import { describe, expect, it, beforeEach, vi } from "vitest";

/**
 * Ingestão UAZAPI: webhook → contato, conversa, mensagem.
 *
 * Sem THREAD (diferente do canal intermediado): este canal endereça por
 * telefone/JID, como o canal por QR — a identidade (`wa_identity`) já basta,
 * e as mesmas RPCs (`fn_upsert_wa_contact`, `fn_upsert_wa_conversation`,
 * `fn_mark_conversation_message`) resolvem a corrida entre webhooks
 * concorrentes.
 */

// `pos-entrada` faz efeitos de negócio (opt-out, abrir demanda, despachar
// agente) que não são o que este arquivo prova — mockado para o teste focar
// na ESCRITA da mensagem/contato/conversa, como os testes de ingest dos
// irmãos já fazem implicitamente (o texto de teste nunca casa STOP_RX).
vi.mock("@/lib/channels/pos-entrada", () => ({ aplicarEfeitosPosEntrada: vi.fn() }));

const ops: { tabela: string; op: string; payload?: unknown }[] = [];
let rpcResposta: Record<string, unknown> = {
  fn_upsert_wa_contact: "contact-1",
  fn_upsert_wa_conversation: "conv-1",
};
let insertErro: { code?: string; message: string } | null = null;
/** O `uazapi_instance_id` que a sessão "tem gravado" — para os testes de cruzamento do webhook. */
let sessionInstanceId: string | null = "r183e2ef9597845";

function chain(tabela: string, op: string, payload?: unknown): Record<string, unknown> {
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "maybeSingle" || prop === "single") {
          if (tabela === "channel_sessions" && op === "select") {
            return async () => ({ data: { uazapi_instance_id: sessionInstanceId }, error: null });
          }
          return async () =>
            insertErro ? { data: null, error: insertErro } : { data: { id: "msg-1" }, error: null };
        }
        if (prop === "then") {
          return (ok: (v: unknown) => unknown) => ok({ data: [{ id: "row-1" }], error: null });
        }
        return (...args: unknown[]) => {
          if (["update", "eq", "neq", "not", "is"].includes(String(prop))) {
            ops.push({ tabela, op: `${op}.${String(prop)}`, payload: args[0] });
          }
          return proxy;
        };
      },
    },
  ) as Record<string, unknown>;
  ops.push({ tabela, op, payload });
  return proxy;
}

function fakeAdmin() {
  return {
    rpc: async (nome: string, args: unknown) => {
      ops.push({ tabela: "rpc", op: nome, payload: args });
      const v = rpcResposta[nome];
      return v === null ? { data: null, error: { message: "falhou" } } : { data: v, error: null };
    },
    from: (tabela: string) => ({
      select: () => chain(tabela, "select"),
      insert: (payload: unknown) => chain(tabela, "insert", payload),
      update: (payload: unknown) => chain(tabela, "update", payload),
    }),
  } as never;
}

import { handleInboundWebhook } from "@/lib/channels/inbound";
import { ingestUazapiInbound } from "@/lib/channels/uazapi/ingest";
import { parseUazapiMessage } from "@/lib/channels/uazapi/webhook";

const MSG = {
  messageid: "3EB0ABC123",
  chatid: "5511999999999@s.whatsapp.net",
  sender: "5511999999999@s.whatsapp.net",
  sender_pn: "5511999999999@s.whatsapp.net",
  sender_lid: "999888777@lid",
  senderName: "Cliente",
  isGroup: false,
  fromMe: false,
  messageType: "text",
  messageTimestamp: 1755000000000,
  text: "oi",
};

function parsed(overrides: Record<string, unknown> = {}) {
  const msg = parseUazapiMessage({
    event: "message",
    instance: "i1",
    data: { ...MSG, ...overrides },
  });
  if (!msg) throw new Error("payload de teste inválido");
  return msg;
}

beforeEach(() => {
  ops.length = 0;
  insertErro = null;
  sessionInstanceId = "r183e2ef9597845";
  rpcResposta = { fn_upsert_wa_contact: "contact-1", fn_upsert_wa_conversation: "conv-1" };
});

describe("ingestUazapiInbound — o que grava", () => {
  it("cria contato+conversa+mensagem, com o telefone E o lid preenchidos", async () => {
    const admin = fakeAdmin();
    const r = await ingestUazapiInbound(admin, {
      organizationId: "org-1",
      channelSessionId: "sess-1",
      msg: parsed(),
    });
    expect(r).toMatchObject({ status: "ingested", conversationId: "conv-1", messageId: "msg-1" });

    const rpcContact = ops.find((o) => o.op === "fn_upsert_wa_contact")?.payload as Record<string, unknown>;
    expect(rpcContact).toMatchObject({ p_org: "org-1", p_kind: "phone", p_phone: "+5511999999999" });

    // Telefone conhecido MESMO com âncora phone — grava por `is null`, sem sobrescrever.
    const up = ops.find((o) => o.tabela === "contacts" && o.op === "update");
    expect(up?.payload).toEqual({ phone_number: "+5511999999999" });
  });

  it("mensagem entra com external_id determinístico — a base da deduplicação", async () => {
    const admin = fakeAdmin();
    await ingestUazapiInbound(admin, { organizationId: "org-1", channelSessionId: "sess-1", msg: parsed() });
    const ins = ops.find((o) => o.tabela === "messages" && o.op === "insert")?.payload as Record<
      string,
      unknown
    >;
    expect(ins).toMatchObject({
      organization_id: "org-1",
      conversation_id: "conv-1",
      contact_id: "contact-1",
      external_id: "3EB0ABC123",
      direction: "inbound",
      type: "text",
      body: "oi",
    });
  });

  it("mídia grava media_url = externalId (id da mensagem), NÃO o fileURL do webhook", async () => {
    // O download real é por id via /message/download (base64 no mesmo
    // pedido); o fileURL, quando presente, vai só para metadata.
    const admin = fakeAdmin();
    await ingestUazapiInbound(admin, {
      organizationId: "org-1",
      channelSessionId: "sess-1",
      msg: parsed({ messageType: "image", fileURL: "https://cdn/img.jpg" }),
    });
    const ins = ops.find((o) => o.tabela === "messages" && o.op === "insert")?.payload as Record<
      string,
      unknown
    >;
    expect(ins.media_url).toBe("3EB0ABC123");
    expect(ins.metadata).toEqual({ uazapi_file_url: "https://cdn/img.jpg" });
  });

  it("pede persistência de mídia (emit_event) quando há mediaType, mesmo sem fileURL", async () => {
    const admin = fakeAdmin();
    await ingestUazapiInbound(admin, {
      organizationId: "org-1",
      channelSessionId: "sess-1",
      msg: parsed({ messageType: "ptt", fileURL: undefined }),
    });
    const evt = ops.find((o) => o.op === "emit_event");
    expect(evt, "não pediu persistência da mídia").toBeTruthy();
    expect((evt?.payload as Record<string, unknown>).p_event_type).toBe("media.persist_requested");
  });

  it("carimba a conversa (fn_mark_conversation_message) com a hora do provider", async () => {
    const admin = fakeAdmin();
    await ingestUazapiInbound(admin, { organizationId: "org-1", channelSessionId: "sess-1", msg: parsed() });
    const carimbo = ops.find((o) => o.op === "fn_mark_conversation_message");
    expect(carimbo?.payload).toMatchObject({
      p_direction: "inbound",
      p_at: new Date(1755000000000).toISOString(),
    });
  });
});

describe("ingestUazapiInbound — status", () => {
  it("desfecho ATUALIZA, não insere", async () => {
    const admin = fakeAdmin();
    const { parseUazapiStatus } = await import("@/lib/channels/uazapi/webhook");
    const s = parseUazapiStatus({
      event: "status",
      instance: "i1",
      data: { messageid: "3EB0ABC123", status: "Delivered" },
    });
    if (!s) throw new Error("status de teste inválido");

    const r = await ingestUazapiInbound(admin, {
      organizationId: "org-1",
      channelSessionId: "sess-1",
      msg: s,
    });
    expect(r.reason).toBe("status_delivered");
    expect(ops.some((o) => o.tabela === "messages" && o.op === "insert")).toBe(false);
    const up = ops.find((o) => o.tabela === "messages" && o.op === "update");
    expect(up?.payload).toMatchObject({ status: "delivered" });
  });
});

describe("idempotência — item 16, webhook duplicado", () => {
  it("reentrega do MESMO evento devolve duplicate, não cria linha nova", async () => {
    insertErro = { code: "23505", message: "duplicate key value violates unique constraint" };
    const admin = fakeAdmin();
    const r = await ingestUazapiInbound(admin, {
      organizationId: "org-1",
      channelSessionId: "sess-1",
      msg: parsed(),
    });
    expect(r.status).toBe("duplicate");
  });

  it("outro erro de escrita LANÇA — reentrega é o que se quer nesse caso", async () => {
    insertErro = { code: "42501", message: "permission denied" };
    const admin = fakeAdmin();
    await expect(
      ingestUazapiInbound(admin, { organizationId: "org-1", channelSessionId: "sess-1", msg: parsed() }),
    ).rejects.toThrow(/uazapi_ingest_insert_failed/);
  });
});

// 20 — isolamento entre tenants
describe("isolamento entre tenants", () => {
  it("cada ingestão carrega SÓ o organization_id do input — nunca vaza entre chamadas concorrentes", async () => {
    const adminA = fakeAdmin();
    await ingestUazapiInbound(adminA, {
      organizationId: "org-A",
      channelSessionId: "sess-A",
      msg: parsed({ messageid: "mA" }),
    });
    const insA = ops.find((o) => o.tabela === "messages" && o.op === "insert")?.payload as Record<
      string,
      unknown
    >;
    expect(insA.organization_id).toBe("org-A");
    expect(insA.channel_session_id).toBe("sess-A");

    ops.length = 0;
    const adminB = fakeAdmin();
    await ingestUazapiInbound(adminB, {
      organizationId: "org-B",
      channelSessionId: "sess-B",
      msg: parsed({ messageid: "mB" }),
    });
    const insB = ops.find((o) => o.tabela === "messages" && o.op === "insert")?.payload as Record<
      string,
      unknown
    >;
    expect(insB.organization_id).toBe("org-B");
    expect(insB.channel_session_id).toBe("sess-B");
    // Nenhum traço da org A sobrevive no lote da org B.
    expect(JSON.stringify(insB)).not.toContain("org-A");

    const rpcB = ops.find((o) => o.op === "fn_upsert_wa_contact")?.payload as Record<string, unknown>;
    expect(rpcB.p_org).toBe("org-B");
  });
});

/**
 * O cruzamento de instância — defesa em profundidade além do
 * `webhook_path_token`. `handleInboundWebhook` é o ponto de entrada real
 * (o que a rota genérica chama), então estes casos exercitam o dispatch
 * inteiro, não só `ingestUazapiInbound`.
 */
describe("cruzamento de instância no webhook", () => {
  const SESSAO = { id: "sess-1", organization_id: "org-1", provider: "uazapi" };
  const corpo = (instance: string | null | undefined) =>
    JSON.stringify({
      event: "message",
      ...(instance !== undefined ? { instance } : {}),
      data: MSG,
    });

  it("instância CORRETA — ingere normalmente", async () => {
    sessionInstanceId = "r183e2ef9597845";
    const r = await handleInboundWebhook(fakeAdmin(), {
      session: SESSAO,
      rawBody: corpo("r183e2ef9597845"),
      headers: new Headers(),
      secret: null,
    });
    expect(r.ok).toBe(true);
    expect(ops.some((o) => o.op === "fn_upsert_wa_contact")).toBe(true);
  });

  it("instância DIFERENTE — rejeita, não ingere, não cria contato, não vaza id na resposta", async () => {
    sessionInstanceId = "r183e2ef9597845";
    const r = await handleInboundWebhook(fakeAdmin(), {
      session: SESSAO,
      rawBody: corpo("outra-instancia-999"),
      headers: new Headers(),
      secret: null,
    });
    expect(r).toMatchObject({ ok: false, code: "unauthorized", message: "instance_mismatch" });
    // A mensagem de erro devolvida ao chamador é genérica — nenhum dos dois
    // instance_id (esperado ou recebido) aparece na resposta.
    expect(JSON.stringify(r)).not.toContain("r183e2ef9597845");
    expect(JSON.stringify(r)).not.toContain("outra-instancia-999");
    // Nada foi gravado: nem contato, nem conversa, nem mensagem.
    expect(ops.some((o) => o.op === "fn_upsert_wa_contact")).toBe(false);
    expect(ops.some((o) => o.op === "fn_upsert_wa_conversation")).toBe(false);
    expect(ops.some((o) => o.tabela === "messages")).toBe(false);
  });

  it("payload SEM identificador de instância — permitido, cai no caminho normal (fallback documentado)", async () => {
    sessionInstanceId = "r183e2ef9597845";
    const r = await handleInboundWebhook(fakeAdmin(), {
      session: SESSAO,
      rawBody: corpo(undefined),
      headers: new Headers(),
      secret: null,
    });
    expect(r.ok).toBe(true);
    expect(ops.some((o) => o.op === "fn_upsert_wa_contact")).toBe(true);
  });

  it("sessão sem uazapi_instance_id gravado — não deveria acontecer, mas não derruba: fallback também cobre este lado", async () => {
    sessionInstanceId = null;
    const r = await handleInboundWebhook(fakeAdmin(), {
      session: SESSAO,
      rawBody: corpo("qualquer-coisa"),
      headers: new Headers(),
      secret: null,
    });
    expect(r.ok).toBe(true);
  });
});
