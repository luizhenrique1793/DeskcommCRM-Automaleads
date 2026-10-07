import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";

import { DEFAULT_CHANNEL_PROVIDER } from "@/lib/channels";
import {
  evaluateBeforeSend,
  readStopFlags,
  BEFORE_SEND_GATES,
  type GateContext,
} from "@/lib/agent-engine/guardrails/before-send";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";
import { retentionCopy } from "@/lib/inbox/retention-copy";
import { vetoReason } from "@/lib/leads/veto-activity";

/**
 * OPT-OUT × HANDOFF × PESSOAL — A MESMA TRAVA, TRÊS MOTIVOS (achado em produção,
 * fork Automaleads).
 *
 * ─── O relato ────────────────────────────────────────────────────────────────
 *
 * Conversa da Liliana: ela respondeu "Fico no aguardo", a IA abriu caso humano
 * (`force_human = true` — correto, é exatamente o que o handoff faz) e a
 * timeline registrou "Passou para humano". A resposta seguinte do assistente
 * foi retida (correto: `force_human` arma o `stopGate`, ninguém deveria
 * responder automaticamente depois de um handoff) — mas o CARTÃO mostrou
 * "Resposta bloqueada por conformidade — O contato pediu para não receber
 * mensagens (opt-out)". Ninguém pediu opt-out. E a ficha do contato, corretamente,
 * não tinha o selo "Bloqueado" — porque `is_blocked` nunca foi true.
 *
 * ─── A causa ─────────────────────────────────────────────────────────────────
 *
 * `readStopFlags` (before-send.ts) sempre leu `is_blocked OR force_human OR
 * is_personal` como UM booleano só, e o `stopGate` sempre vetava com o MESMO
 * código `contato_bloqueado` e a MESMA frase de opt-out — para as três causas.
 * `retentionCopy` e `vetoReason` (lib/inbox/retention-copy.ts,
 * lib/leads/veto-activity.ts) só liam esse código único.
 *
 * ─── O que este arquivo prova ────────────────────────────────────────────────
 *
 *   1. `readStopFlags` devolve QUAL motivo (is_blocked > force_human >
 *      is_personal, nesta prioridade quando mais de um está ativo).
 *   2. `stopGate` (via `evaluateBeforeSend`) continua VETANDO nos três casos —
 *      nenhum libera envio —, mas com código e frase DIFERENTES por motivo.
 *   3. `retentionCopy` e `vetoReason` nunca dizem "opt-out" para
 *      force_human/is_personal.
 *   4. Sem motivo informado (chamadores que só conhecem `is_blocked`:
 *      preview, approved-reply, meet-delivery) o comportamento é IDÊNTICO ao
 *      de antes — `contato_bloqueado`, sem mudança para quem já lia esse código.
 */

/**
 * Dublê mínimo de `Queryable` — SEM banco. Computa `stopped` a partir do texto
 * da query real de `readStopFlags` (as DUAS variantes, com/sem `force_human`),
 * exatamente como o Postgres computaria: é o que prova que o dublê mede a
 * função de verdade, não uma reimplementação paralela dela.
 */
function fakeDb(
  row: { is_blocked?: boolean; force_human?: boolean; is_personal?: boolean } | null,
) {
  return {
    query: async <R extends QueryResultRow = QueryResultRow>(
      text: string,
    ): Promise<QueryResult<R>> => {
      if (row === null) {
        return { rows: [], command: "SELECT", rowCount: 0, oid: 0, fields: [] } as QueryResult<R>;
      }
      // As DUAS variantes selecionam a coluna `force_human` (ela viaja sempre,
      // para o cálculo do MOTIVO) — o que distingue o ramo do encontro é o OR
      // dela entrar ou não no `stopped`, não a mera presença da coluna.
      const stopped = text.includes("is_blocked or force_human or is_personal")
        ? Boolean(row.is_blocked || row.force_human || row.is_personal)
        : Boolean(row.is_blocked || row.is_personal);
      return {
        rows: [{ ...row, stopped } as unknown as R],
        command: "SELECT",
        rowCount: 1,
        oid: 0,
        fields: [],
      } as QueryResult<R>;
    },
  };
}

const ORG = "org-1";
const CONTACT = "contact-1";

describe("readStopFlags — qual motivo armou o STOP", () => {
  it("nenhuma trava ativa → não para, sem motivo", async () => {
    const r = await readStopFlags(
      fakeDb({ is_blocked: false, force_human: false, is_personal: false }),
      ORG,
      CONTACT,
    );
    expect(r).toEqual({ stopped: false, reason: null });
  });

  it("só is_blocked → para por 'is_blocked' (opt-out real)", async () => {
    const r = await readStopFlags(
      fakeDb({ is_blocked: true, force_human: false, is_personal: false }),
      ORG,
      CONTACT,
    );
    expect(r).toEqual({ stopped: true, reason: "is_blocked" });
  });

  it("só force_human (o caso 'Fico no aguardo') → para por 'force_human', NUNCA 'is_blocked'", async () => {
    const r = await readStopFlags(
      fakeDb({ is_blocked: false, force_human: true, is_personal: false }),
      ORG,
      CONTACT,
    );
    expect(r).toEqual({ stopped: true, reason: "force_human" });
  });

  it("só is_personal → para por 'is_personal'", async () => {
    const r = await readStopFlags(
      fakeDb({ is_blocked: false, force_human: false, is_personal: true }),
      ORG,
      CONTACT,
    );
    expect(r).toEqual({ stopped: true, reason: "is_personal" });
  });

  it("is_blocked E force_human juntos → reporta 'is_blocked' (o motivo mais grave nunca fica escondido)", async () => {
    const r = await readStopFlags(
      fakeDb({ is_blocked: true, force_human: true, is_personal: false }),
      ORG,
      CONTACT,
    );
    expect(r.reason).toBe("is_blocked");
  });

  it("encontro humano (humanMeetingCommand): force_human sozinho NÃO para — é a isenção que o encontro abre", async () => {
    const r = await readStopFlags(
      fakeDb({ is_blocked: false, force_human: true, is_personal: false }),
      ORG,
      CONTACT,
      true,
    );
    expect(r).toEqual({ stopped: false, reason: null });
  });

  it("encontro humano: is_personal AINDA para — pessoal não recebe nem por lá", async () => {
    const r = await readStopFlags(
      fakeDb({ is_blocked: false, force_human: true, is_personal: true }),
      ORG,
      CONTACT,
      true,
    );
    expect(r).toEqual({ stopped: true, reason: "is_personal" });
  });

  it("contato inexistente → não para (controle de vacuidade)", async () => {
    const r = await readStopFlags(fakeDb(null), ORG, CONTACT);
    expect(r).toEqual({ stopped: false, reason: null });
  });
});

const baseCtx = (): GateContext => ({
  now: new Date("2026-10-07T15:00:00Z"),
  body: "Olá, posso ajudar?",
  optedOut: false,
  provider: DEFAULT_CHANNEL_PROVIDER,
  messagingWindow: { lastInboundAt: new Date("2026-10-07T14:00:00Z") },
  pacing: {
    knobs: PACING_DEFAULTS,
    state: { lastSentAt: null, sentToday: 0, numberActivatedAt: null },
    crmDailyLimit: null,
  },
  spinning: { knobs: SPINNING_DEFAULTS, window: [] },
  promise: { table: null },
  semanticPromise: null,
  disclosure: { template: null, isFirstOutbound: false, mode: "inject" },
  lgpd: null,
  casesEnabled: false,
  hasOpenCase: false,
  openedCaseThisTurn: false,
});

describe("stopGate — veta nos três estados, mas classifica cada um", () => {
  it("não vetado → passa (nenhuma trava)", () => {
    const { veto } = evaluateBeforeSend({ ...baseCtx(), optedOut: false });
    expect(veto).toBeNull();
  });

  it("is_blocked → veto 'contato_bloqueado' com a frase de opt-out", () => {
    const { veto } = evaluateBeforeSend({
      ...baseCtx(),
      optedOut: true,
      optOutReason: "is_blocked",
    });
    expect(veto?.code).toBe("contato_bloqueado");
    expect(veto?.message).toContain("optou por sair");
  });

  it("force_human (o caso 'Fico no aguardo') → veto DIFERENTE, sem dizer opt-out", () => {
    const { veto } = evaluateBeforeSend({
      ...baseCtx(),
      optedOut: true,
      optOutReason: "force_human",
    });
    expect(veto?.code).toBe("contato_encaminhado_para_humano");
    expect(veto?.message).not.toContain("optou por sair");
    expect(veto?.message).toContain("não é opt-out");
    expect(veto?.message).toContain("atendimento humano");
  });

  it("is_personal → veto DIFERENTE, sem dizer opt-out", () => {
    const { veto } = evaluateBeforeSend({
      ...baseCtx(),
      optedOut: true,
      optOutReason: "is_personal",
    });
    expect(veto?.code).toBe("contato_pessoal_sem_envio_automatico");
    expect(veto?.message).not.toContain("optou por sair");
    expect(veto?.message).toContain("não é opt-out");
  });

  it("optedOut=true SEM optOutReason (preview/approved-reply/meet-delivery) → comportamento antigo intacto", () => {
    // Nenhum destes chamadores conhece `optOutReason` — todos só armam
    // `optedOut` a partir de `is_blocked`. Ausência tem de continuar se
    // comportando EXATAMENTE como antes desta correção.
    const { veto } = evaluateBeforeSend({ ...baseCtx(), optedOut: true });
    expect(veto?.code).toBe("contato_bloqueado");
    expect(veto?.message).toContain("optou por sair");
  });

  it("o stop continua sendo o PRIMEIRO gate da cadeia — nenhum dos três estados chega aos gates seguintes", () => {
    expect(BEFORE_SEND_GATES[0]!.name).toBe("stop");
    const { trace } = evaluateBeforeSend({
      ...baseCtx(),
      optedOut: true,
      optOutReason: "force_human",
    });
    expect(trace[0]).toMatchObject({ gate: "stop", verdict: "veto" });
    expect(trace.slice(1).every((t) => t.verdict === "skipped")).toBe(true);
  });
});

describe("retentionCopy — a tela nunca chama handoff/pessoal de opt-out", () => {
  const ctx = { window_start_hour: 8, window_end_hour: 21, allow_sunday: false, timezone: "America/Sao_Paulo" };

  it("contato_bloqueado continua 'compliance' e menciona opt-out (opt-out real)", () => {
    const r = retentionCopy("contato_bloqueado", ctx);
    expect(r.kind).toBe("compliance");
    expect(r.description).toContain("opt-out");
  });

  it("contato_encaminhado_para_humano é 'handoff' e NEGA opt-out explicitamente", () => {
    const r = retentionCopy("contato_encaminhado_para_humano", ctx);
    expect(r.kind).toBe("handoff");
    expect(r.description).toMatch(/N[ÃA]O.*opt-out/i);
    expect(r.title).not.toContain("conformidade");
  });

  it("contato_pessoal_sem_envio_automatico é 'handoff' e NEGA opt-out explicitamente", () => {
    const r = retentionCopy("contato_pessoal_sem_envio_automatico", ctx);
    expect(r.kind).toBe("handoff");
    expect(r.description).toMatch(/N[ÃA]O.*opt-out/i);
  });
});

describe('o caso "Fico no aguardo" de ponta a ponta (sem banco, sem DOM)', () => {
  it("handoff humano → readStopFlags → stopGate → retentionCopy/vetoReason: nenhuma camada fala em opt-out", async () => {
    // 1. A conversa está em handoff: force_human=true, is_blocked=false,
    //    is_personal=false — exatamente o estado que o handoff grava.
    const stop = await readStopFlags(
      fakeDb({ is_blocked: false, force_human: true, is_personal: false }),
      ORG,
      CONTACT,
    );
    expect(stop.reason).toBe("force_human");

    // 2. O gate veta a tentativa de resposta seguinte com o motivo certo.
    const { veto } = evaluateBeforeSend({
      ...baseCtx(),
      optedOut: stop.stopped,
      ...(stop.reason !== null ? { optOutReason: stop.reason } : {}),
    });
    expect(veto?.code).toBe("contato_encaminhado_para_humano");

    // 3. O cartão da Inbox (retentionCopy) e a timeline (vetoReason) concordam:
    //    nenhum dos dois textos menciona opt-out ou "pediu para parar".
    const copy = retentionCopy(veto!.code, {
      window_start_hour: 8,
      window_end_hour: 21,
      allow_sunday: false,
      timezone: "America/Sao_Paulo",
    });
    // A descrição PODE citar "opt-out" (pra negar: "isto NÃO é opt-out") — o
    // que não pode acontecer é repetir a alegação original, errada, de que o
    // contato pediu para parar de receber mensagens.
    expect(copy.description).not.toContain("pediu para não receber mensagens");
    expect(copy.description).toMatch(/N[ÃA]O.*opt-out/i);
    const timeline = vetoReason("stop", veto!.code);
    expect(timeline).not.toContain("pediu para parar");
    expect(timeline).toContain("atendimento humano");
  });
});
