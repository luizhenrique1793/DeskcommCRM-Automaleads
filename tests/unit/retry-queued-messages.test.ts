import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as LibChannels from "@/lib/channels";

/**
 * A REGRA do cron `retry-queued-messages`.
 *
 * Achado em homologação real (2026-08-14): mensagem de humano presa em
 * `queued` porque o canal ainda não estava `WORKING` no instante do envio
 * NUNCA se recupera sozinha — o "dono" que reagenda `queued`
 * (`SEND_QUEUED_RETRY_MS`, comentário de `removerEcoDoProprioEnvio` em
 * `_handler.ts`) só cobre `sent_via='ai'` (fila de job do agent-engine).
 * Mensagem do composer não passa por lá.
 *
 * O que se guarda aqui, e por quê cada ponto quebra sozinho se sumir:
 *
 *   1. escopo estreito (`sent_via='user'`, `type != 'template'`) — tocar
 *      mensagem de IA brigaria com o job que já a reagenda; template exige
 *      pré-voo de definição aprovada, fora de escopo;
 *   2. claim atômico (`status:'sending'` com `eq(status,'queued')`) — sem
 *      isso, duas rodadas concorrentes mandariam a MESMA mensagem duas vezes;
 *   3. `sessionRef` é o RESOLVIDO pelo seam (`resolveSessionRef`), nunca o
 *      UUID da linha de `channel_sessions` — usar o UUID cru manda a UAZAPI/
 *      WAHA/etc um identificador que elas não reconhecem;
 *   4. ainda não pronto (não configurado / não WORKING) volta pra `queued`,
 *      nunca vira `failed` — vai sair quando o canal voltar;
 *   5. canal ARQUIVADO e falta de telefone são `failed` IMEDIATO — não tem
 *      "esperar mais", mesmo raciocínio de `_handler.ts`;
 *   6. sucesso atualiza a CONVERSA (prévia, last_outbound_at) — senão a
 *      lista do Inbox mostra a mensagem enviada sem refletir isso;
 *   7. `adapter.send()` que lança vira `failed` com o código do adapter, não
 *      um erro genérico nem `sent` mentiroso.
 */

const sendMock = vi.fn();
const resolveRecipientMock = vi.fn((i: { phoneNumber?: string | null }) =>
  i.phoneNumber ? i.phoneNumber.replace(/\D/g, "") : null,
);
let isConfigured = true;
vi.mock("@/lib/channels", async (importOriginal) => {
  const real = await importOriginal<typeof LibChannels>();
  return {
    ...real,
    getAdapter: vi.fn(() => ({
      provider: "waha",
      resolveRecipient: (i: unknown) => resolveRecipientMock(i as never),
      isConfigured: () => isConfigured,
      codes: { notConfigured: "x_not_configured", sendFailed: "x_error", unknownError: "x_unknown" },
      send: (...a: unknown[]) => sendMock(...a),
      echoExternalIds: undefined,
    })),
  };
});

vi.mock("@/app/api/v1/messages/_handler", () => ({
  removerEcoDoProprioEnvio: vi.fn(async () => undefined),
  previewFrom: (i: { body?: string }) => i.body ?? "[media]",
  extendBotSilence: () => undefined,
}));

vi.mock("@/lib/env", () => ({
  env: { INTERNAL_CRON_SECRET: "segredo", INTERNAL_SECRET: "segredo" },
}));

import { retryQueuedMessages } from "@/app/api/v1/cron/retry-queued-messages/route";

interface Chamada {
  tabela: string;
  op: string;
  filtros: Record<string, unknown>;
  valores?: Record<string, unknown>;
}

const REF_SESSAO = "waha-session-42";
const CONVERSA = {
  id: "conv-1",
  organization_id: "org-1",
  contact_id: "contact-1",
  channel_session_id: "sess-1",
  is_group: false,
  group_chat_id: null,
  bot_silenced_until: null,
  provider_conversation_id: null,
  contacts: { phone_number: "+5511999999999", wa_identity: null, wa_lid: null, is_blocked: false },
  channel_sessions: {
    provider: "waha",
    waha_session_name: REF_SESSAO,
    meta_phone_number_id: null,
    zernio_account_id: null,
    uazapi_instance_id: null,
    status: "WORKING",
    archived_at: null,
  },
};

function fila(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "msg-1",
    organization_id: "org-1",
    conversation_id: "conv-1",
    type: "text",
    body: "olá",
    media_url: null,
    media_mime: null,
    media_storage_path: null,
    metadata: {},
    ...over,
  };
}

function clientDuble(presas: Record<string, unknown>[], opts: { conversa?: Record<string, unknown> | null; claim?: boolean } = {}) {
  const chamadas: Chamada[] = [];
  const conversa = opts.conversa === undefined ? CONVERSA : opts.conversa;
  const claim = opts.claim ?? true;

  const client = {
    rpc(fn: string, args: Record<string, unknown>) {
      chamadas.push({ tabela: `rpc:${fn}`, op: "rpc", filtros: {}, valores: args });
      return Promise.resolve({ error: null });
    },
    storage: {
      from: () => ({
        createSignedUrl: async () => ({ data: { signedUrl: "https://signed/x" }, error: null }),
      }),
    },
    from(tabela: string) {
      const filtros: Record<string, unknown> = {};
      let valores: Record<string, unknown> | undefined;
      let op = "select";
      const cadeia: Record<string, unknown> = {
        select() {
          return cadeia;
        },
        update(v: Record<string, unknown>) {
          op = "update";
          valores = v;
          return cadeia;
        },
        eq(col: string, val: unknown) {
          filtros[`eq:${col}`] = val;
          return cadeia;
        },
        neq(col: string, val: unknown) {
          filtros[`neq:${col}`] = val;
          return cadeia;
        },
        in(col: string, vals: unknown) {
          filtros[`in:${col}`] = vals;
          return cadeia;
        },
        order() {
          return cadeia;
        },
        limit() {
          chamadas.push({ tabela, op, filtros, valores });
          return Promise.resolve({ data: presas, error: null });
        },
        maybeSingle() {
          chamadas.push({ tabela, op, filtros, valores });
          if (tabela === "conversations") {
            return Promise.resolve({ data: conversa, error: null });
          }
          // messages: select("id") após update — é o CLAIM.
          if (op === "update" && valores?.status === "sending") {
            return Promise.resolve({ data: claim ? { id: filtros["eq:id"] } : null, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        then(resolve: (r: unknown) => unknown) {
          chamadas.push({ tabela, op, filtros, valores });
          return Promise.resolve(resolve({ data: null, error: null }));
        },
      };
      return cadeia;
    },
  };
  return { client, chamadas };
}

const AGORA = new Date("2026-08-14T15:10:00.000Z");

beforeEach(() => {
  sendMock.mockReset();
  sendMock.mockResolvedValue({ externalId: null });
  resolveRecipientMock.mockClear();
  isConfigured = true;
});

describe("retry-queued-messages", () => {
  it("busca só outbound queued de HUMANO ou SISTEMA, sem template", async () => {
    const { client, chamadas } = clientDuble([]);
    await retryQueuedMessages(client as never, AGORA, "req-1");

    const busca = chamadas.find((c) => c.tabela === "messages" && c.op === "select");
    expect(busca?.filtros["eq:direction"]).toBe("outbound");
    expect(busca?.filtros["eq:status"]).toBe("queued");
    expect(busca?.filtros["in:sent_via"]).toEqual(["user", "system"]);
    expect(busca?.filtros["neq:type"]).toBe("template");
  });

  it("nada na fila ⇒ não escreve nada", async () => {
    const { client, chamadas } = clientDuble([]);
    const r = await retryQueuedMessages(client as never, AGORA, "req-2");
    expect(r).toEqual({ scanned: 0, sent: 0, failed: 0, still_queued: 0 });
    expect(chamadas.filter((c) => c.op === "update")).toEqual([]);
  });

  it("claim atômico: UPDATE carrega status=sending E eq(status,queued) — sem isso, corrida manda em dobro", async () => {
    const { client, chamadas } = clientDuble([fila()]);
    await retryQueuedMessages(client as never, AGORA, "req-3");

    const claimCall = chamadas.find(
      (c) => c.tabela === "messages" && c.op === "update" && c.valores?.status === "sending",
    );
    expect(claimCall).toBeDefined();
    expect(claimCall?.filtros["eq:status"]).toBe("queued");
  });

  it("outra rodada já reivindicou (claim falha) ⇒ pula, não manda de novo", async () => {
    const { client, chamadas } = clientDuble([fila()], { claim: false });
    const r = await retryQueuedMessages(client as never, AGORA, "req-4");

    expect(sendMock).not.toHaveBeenCalled();
    expect(r).toEqual({ scanned: 1, sent: 0, failed: 0, still_queued: 0 });
    // Nenhuma escrita de DESFECHO depois do claim que falhou.
    expect(chamadas.filter((c) => c.tabela === "messages" && c.op === "update")).toHaveLength(1);
  });

  it("sessionRef é o RESOLVIDO pelo seam — nunca o UUID cru de channel_sessions", async () => {
    sendMock.mockResolvedValue({ externalId: "ext-1" });
    const { client } = clientDuble([fila()]);
    await retryQueuedMessages(client as never, AGORA, "req-5");

    expect(sendMock).toHaveBeenCalledTimes(1);
    const envelope = sendMock.mock.calls[0]![0] as { sessionRef: string };
    expect(envelope.sessionRef).toBe(REF_SESSAO);
    expect(envelope.sessionRef).not.toBe(CONVERSA.channel_session_id);
  });

  it("canal ainda NÃO configurado ⇒ volta pra queued com o motivo, NUNCA chama send", async () => {
    isConfigured = false;
    const { client, chamadas } = clientDuble([fila()]);
    const r = await retryQueuedMessages(client as never, AGORA, "req-6");

    expect(sendMock).not.toHaveBeenCalled();
    const desfecho = chamadas.find(
      (c) => c.tabela === "messages" && c.op === "update" && c.valores?.status === "queued",
    );
    expect((desfecho?.valores?.metadata as Record<string, unknown>)?.queued_reason).toBe(
      "x_not_configured",
    );
    expect(r.still_queued).toBe(1);
  });

  it("canal ainda não WORKING ⇒ volta pra queued com channel_session_not_working", async () => {
    const conversaParada = {
      ...CONVERSA,
      channel_sessions: { ...CONVERSA.channel_sessions, status: "STARTING" },
    };
    const { client, chamadas } = clientDuble([fila()], { conversa: conversaParada });
    const r = await retryQueuedMessages(client as never, AGORA, "req-7");

    expect(sendMock).not.toHaveBeenCalled();
    const desfecho = chamadas.find(
      (c) => c.tabela === "messages" && c.op === "update" && c.valores?.status === "queued",
    );
    expect((desfecho?.valores?.metadata as Record<string, unknown>)?.queued_reason).toBe(
      "channel_session_not_working",
    );
    expect(r.still_queued).toBe(1);
  });

  it("canal ARQUIVADO ⇒ failed imediato, nunca queued — não vai sair nunca", async () => {
    const conversaArquivada = {
      ...CONVERSA,
      channel_sessions: { ...CONVERSA.channel_sessions, archived_at: "2026-08-01T00:00:00Z" },
    };
    const { client, chamadas } = clientDuble([fila()], { conversa: conversaArquivada });
    const r = await retryQueuedMessages(client as never, AGORA, "req-8");

    expect(sendMock).not.toHaveBeenCalled();
    const falha = chamadas.find(
      (c) => c.tabela === "messages" && c.op === "update" && c.valores?.status === "failed",
    );
    expect(falha?.valores?.error_code).toBe("channel_archived");
    expect(r.failed).toBe(1);
  });

  it("sem telefone resolvível ⇒ failed imediato", async () => {
    const semTelefone = {
      ...CONVERSA,
      contacts: { ...CONVERSA.contacts, phone_number: null },
    };
    const { client, chamadas } = clientDuble([fila()], { conversa: semTelefone });
    const r = await retryQueuedMessages(client as never, AGORA, "req-9");

    const falha = chamadas.find(
      (c) => c.tabela === "messages" && c.op === "update" && c.valores?.status === "failed",
    );
    expect(falha?.valores?.error_code).toBe("missing_phone_number");
    expect(r.failed).toBe(1);
  });

  it("sucesso: sent + external_id + ack 0, e a CONVERSA é atualizada (prévia/last_outbound_at)", async () => {
    sendMock.mockResolvedValue({ externalId: "ext-123" });
    const { client, chamadas } = clientDuble([fila({ body: "oi de novo" })]);
    const r = await retryQueuedMessages(client as never, AGORA, "req-10");

    const sentUpdate = chamadas.find(
      (c) => c.tabela === "messages" && c.op === "update" && c.valores?.status === "sent",
    );
    expect(sentUpdate?.valores).toMatchObject({ status: "sent", external_id: "ext-123", ack: 0 });

    const convUpdate = chamadas.find((c) => c.tabela === "conversations" && c.op === "update");
    expect(convUpdate?.valores).toMatchObject({
      last_outbound_at: AGORA.toISOString(),
      last_message_at: AGORA.toISOString(),
      last_message_preview: "oi de novo",
    });

    const emitido = chamadas.find((c) => c.tabela === "rpc:emit_event");
    expect(emitido?.valores?.p_event_type).toBe("message.sent");
    expect(r.sent).toBe(1);
  });

  it("adapter.send() lança ⇒ failed com o código do adapter, nunca 'sent' mentiroso", async () => {
    sendMock.mockRejectedValue(new Error("boom da API"));
    const { client, chamadas } = clientDuble([fila()]);
    const r = await retryQueuedMessages(client as never, AGORA, "req-11");

    const falha = chamadas.find(
      (c) => c.tabela === "messages" && c.op === "update" && c.valores?.status === "failed",
    );
    expect(falha?.valores?.error_code).toBe("x_error");
    expect(falha?.valores?.error_message).toBe("boom da API");
    expect(r.failed).toBe(1);
    expect(chamadas.some((c) => c.valores?.status === "sent")).toBe(false);
  });

  it("mídia: assina a URL do storage e manda pelo envelope de media, com a legenda certa", async () => {
    sendMock.mockResolvedValue({ externalId: "ext-media" });
    const { client } = clientDuble([
      fila({ type: "image", media_storage_path: "org-1/conv-1/msg-1.jpg", media_mime: "image/jpeg", body: "legenda" }),
    ]);
    await retryQueuedMessages(client as never, AGORA, "req-12");

    const envelope = sendMock.mock.calls[0]![0] as { media?: { url: string; caption: string | null } };
    expect(envelope.media?.url).toBe("https://signed/x");
    expect(envelope.media?.caption).toBe("legenda");
  });
});
