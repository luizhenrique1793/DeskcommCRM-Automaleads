import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { runBeforeSend } from "@/lib/agent-engine/guardrails/before-send";
import type { Logger } from "@/lib/agent-engine/obs/logger";

/**
 * MEDIDO EM PRODUÇÃO (fork Automaleads, 07/10): a conversa do Luiz reabriu com
 * o AVISO ERRADO de opt-out depois que a PR da classificação (is_blocked vs
 * force_human vs is_personal) já estava no ar.
 *
 * `args.optedOutThisTurn` é um SNAPSHOT de `contacts.is_blocked` tirado na
 * ABERTURA do turno (`inbound-turn.ts`/`followup-turn.ts`). O código antigo,
 * quando esse snapshot vinha `true`, nunca chamava `readStopFlags` — reportava
 * `reason: 'is_blocked'` incondicionalmente. No caso medido, o turno abriu com
 * `is_blocked=true` (um bloqueio de teste já revertido no banco) e, no MEIO do
 * turno, o motivo real virou `force_human` (o próprio modelo chamou
 * `crm_request_human_handoff`) — a leitura fresca já veria só `force_human`,
 * mas o snapshot vencia sozinho, e o veto saía com `contato_bloqueado`: o
 * aviso ao lead e a atividade da Central diziam opt-out para uma conversa que
 * só estava com humano.
 *
 * A cadeia REAL (sem gates: injetado) é o que se exercita aqui — o mesmo
 * molde de `tests/unit/gate-vazamento-interno.test.ts`: provar só `stopGate`
 * isolado provaria a decisão, não a fiação (`optedOutThisTurn` →
 * `readStopFlags` → `GateContext.optOutReason` → `stopGate`).
 */
function clienteFalso(linhaDeContato: {
  is_blocked: boolean;
  force_human: boolean;
  is_personal: boolean;
} | null): { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("is_blocked, force_human, is_personal")) {
      return {
        rows:
          linhaDeContato === null
            ? []
            : [
                {
                  ...linhaDeContato,
                  stopped: linhaDeContato.is_blocked || linhaDeContato.force_human || linhaDeContato.is_personal,
                },
              ],
      };
    }
    return { rows: [] };
  });
  return { query, release: vi.fn() };
}

const COMERCIAL = new Date("2026-07-28T13:00:00Z"); // 10h BRT, terça — dentro da janela

function chamaCadeiaReal(args: {
  optedOutThisTurn: boolean;
  linhaDeContato: { is_blocked: boolean; force_human: boolean; is_personal: boolean } | null;
}) {
  const client = clienteFalso(args.linhaDeContato);
  const inserts = vi.fn().mockResolvedValue({ rows: [{ id: "trace-1" }] });
  const pool = { connect: vi.fn().mockResolvedValue(client), query: inserts } as unknown as pg.Pool;
  const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return runBeforeSend({
    pool,
    log,
    tenantId: "00000000-0000-4000-8000-000000000001",
    leadId: "00000000-0000-4000-8000-000000000002",
    jobId: "00000000-0000-4000-8000-000000000003",
    channelSessionId: "00000000-0000-4000-8000-000000000004",
    body: "tudo certo, já te retorno",
    optedOutThisTurn: args.optedOutThisTurn,
    crmDailyLimit: null,
    now: COMERCIAL,
    rng: () => 0,
    sleep: async () => {},
    send: async () => ({ kind: "sent", idempotencyKey: "k", messageId: "m" }),
  });
}

describe("a leitura fresca de readStopFlags vence o snapshot da abertura do turno", () => {
  it("snapshot dizia is_blocked=true, leitura fresca só vê force_human → veto é 'força humana', NUNCA opt-out", async () => {
    const r = await chamaCadeiaReal({
      optedOutThisTurn: true,
      linhaDeContato: { is_blocked: false, force_human: true, is_personal: false },
    });
    expect(r.status).toBe("vetoed");
    if (r.status !== "vetoed") throw new Error("inalcançável");
    expect(r.code).toBe("contato_encaminhado_para_humano");
    expect(r.message).toContain("não é opt-out");
  });

  it("snapshot dizia is_blocked=true, leitura fresca só vê is_personal → veto é 'contato pessoal', NUNCA opt-out", async () => {
    const r = await chamaCadeiaReal({
      optedOutThisTurn: true,
      linhaDeContato: { is_blocked: false, force_human: false, is_personal: true },
    });
    expect(r.status).toBe("vetoed");
    if (r.status !== "vetoed") throw new Error("inalcançável");
    expect(r.code).toBe("contato_pessoal_sem_envio_automatico");
    expect(r.message).toContain("não é opt-out");
  });

  it("snapshot E leitura fresca concordam em is_blocked → continua vetando por opt-out real", async () => {
    const r = await chamaCadeiaReal({
      optedOutThisTurn: true,
      linhaDeContato: { is_blocked: true, force_human: false, is_personal: false },
    });
    expect(r.status).toBe("vetoed");
    if (r.status !== "vetoed") throw new Error("inalcançável");
    expect(r.code).toBe("contato_bloqueado");
  });

  it("rede de segurança preservada: snapshot=true e a leitura fresca não encontra NENHUMA trava (linha ausente) → ainda veta, como antes", async () => {
    const r = await chamaCadeiaReal({ optedOutThisTurn: true, linhaDeContato: null });
    expect(r.status).toBe("vetoed");
    if (r.status !== "vetoed") throw new Error("inalcançável");
    expect(r.code).toBe("contato_bloqueado");
  });

  it("nem snapshot nem leitura fresca travam → a mensagem sai", async () => {
    const r = await chamaCadeiaReal({
      optedOutThisTurn: false,
      linhaDeContato: { is_blocked: false, force_human: false, is_personal: false },
    });
    expect(r.status).toBe("sent");
  });
});
