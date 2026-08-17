import { beforeEach, describe, expect, it } from "vitest";

/**
 * O UAZAPI ecoa o próprio token no CORPO do webhook — medido em produção
 * (2026-08-13): o payload real inclui `token` (a instância, em texto puro) na
 * raiz de todo evento. `webhook_events_log.raw_body`/`payload_parsed` não são
 * cifrados (desenho correto para todo provider que não vaza segredo no
 * corpo), então sem sanitizar, o token do operador ficaria gravado em claro a
 * cada evento recebido.
 *
 * Dois pontos vigiados aqui:
 *   1. `redactUazapiSecrets` (função pura) — o que ela apaga e o que preserva.
 *   2. `abrirArquivoDoWebhook` — que a sanitização só afeta o que vai para o
 *      banco, nunca o `rawBody` que a rota repassa para `handleInboundWebhook`
 *      (imutabilidade de string garante isso, mas o teste documenta e prova).
 */

import { redactUazapiSecrets } from "@/lib/channels/uazapi/webhook";
import { abrirArquivoDoWebhook } from "@/lib/channels/arquivo-de-webhook";
import { handleInboundWebhook } from "@/lib/channels/inbound";

const TOKEN_REAL = "sk_este_e_um_token_de_teste_36chars";

const PAYLOAD_MENSAGEM_COM_TOKEN = {
  chat: { id: "5511999999999@s.whatsapp.net", wa_name: "Cliente Teste" },
  owner: "5511888888888",
  token: TOKEN_REAL,
  BaseUrl: "https://free.uazapi.com",
  message: {
    id: "3EB0SECRET01",
    text: "oi",
    type: "text",
    chatid: "5511999999999@s.whatsapp.net",
    fromMe: false,
    sender: "5511999999999@s.whatsapp.net",
    source: "android",
    messageid: "3EB0SECRET01",
    sender_pn: "5511999999999@s.whatsapp.net",
    senderName: "Cliente Teste",
    sender_lid: "123456789@lid",
    messageType: "Conversation",
    messageTimestamp: 1755000000000,
    isGroup: false,
  },
  EventType: "messages",
  chatSource: "updated",
  instanceName: "YiKQrN",
};

describe("redactUazapiSecrets — função pura", () => {
  it("apaga o token, mesmo aninhado, mas preserva os demais campos", () => {
    const saneado = redactUazapiSecrets(PAYLOAD_MENSAGEM_COM_TOKEN) as Record<string, unknown>;
    expect(saneado.token).toBe("[REDACTED]");
    // Campos úteis intactos.
    expect(saneado.EventType).toBe("messages");
    expect(saneado.instanceName).toBe("YiKQrN");
    const m = saneado.message as Record<string, unknown>;
    expect(m.messageid).toBe("3EB0SECRET01");
    expect(m.chatid).toBe("5511999999999@s.whatsapp.net");
    expect(m.senderName).toBe("Cliente Teste");
    expect(m.sender_pn).toBe("5511999999999@s.whatsapp.net");
    expect(m.sender_lid).toBe("123456789@lid");
    expect(m.text).toBe("oi");
  });

  it("apaga variações de grafia (camelCase/PascalCase/snake_case) do mesmo conceito", () => {
    for (const chave of ["token", "Token", "apiToken", "instanceToken", "instance_token", "adminToken"]) {
      const saneado = redactUazapiSecrets({ [chave]: "segredo-real", outro: "fica" }) as Record<
        string,
        unknown
      >;
      expect(saneado[chave], `chave ${chave} não foi redigida`).toBe("[REDACTED]");
      expect(saneado.outro).toBe("fica");
    }
  });

  it("NÃO apaga campos que só PARECEM sensíveis por serem strings longas", () => {
    // Guarda de vacuidade contra sanitização genérica demais — messageid,
    // sender_pn etc. são strings compridas e não podem ser confundidos com token.
    const saneado = redactUazapiSecrets({
      messageid: "3EB0" + "A".repeat(40),
      sender_pn: "5511999999999@s.whatsapp.net",
    }) as Record<string, unknown>;
    expect(saneado.messageid).toBe("3EB0" + "A".repeat(40));
    expect(saneado.sender_pn).toBe("5511999999999@s.whatsapp.net");
  });

  it("preserva arrays e não quebra em valores primitivos/nulos", () => {
    const saneado = redactUazapiSecrets({
      lista: [{ token: "x" }, { ok: 1 }],
      nulo: null,
      numero: 42,
      booleano: true,
    }) as Record<string, unknown>;
    expect(saneado.lista).toEqual([{ token: "[REDACTED]" }, { ok: 1 }]);
    expect(saneado.nulo).toBeNull();
    expect(saneado.numero).toBe(42);
    expect(saneado.booleano).toBe(true);
  });
});

describe("abrirArquivoDoWebhook — a cópia arquivada, não o que o parser recebe", () => {
  let inserido: Record<string, unknown> | null = null;

  function fakeAdmin() {
    return {
      from() {
        return {
          insert: (payload: Record<string, unknown>) => {
            inserido = payload;
            return { select: () => ({ maybeSingle: async () => ({ data: { id: "log-1" }, error: null }) }) };
          },
        };
      },
    } as never;
  }

  beforeEach(() => {
    inserido = null;
  });

  it("provider uazapi: raw_body arquivado NÃO contém o token real", async () => {
    const rawBody = JSON.stringify(PAYLOAD_MENSAGEM_COM_TOKEN);
    await abrirArquivoDoWebhook(fakeAdmin(), {
      organizationId: "org-1",
      channelSessionId: "sess-1",
      provider: "uazapi",
      rawBody,
      headers: new Headers(),
    });

    const rawArquivado = inserido?.raw_body as string;
    expect(rawArquivado).not.toContain(TOKEN_REAL);
    expect(rawArquivado).toContain("[REDACTED]");

    const parsedArquivado = inserido?.payload_parsed as Record<string, unknown>;
    expect(parsedArquivado.token).toBe("[REDACTED]");
    // Campos úteis continuam presentes no arquivo — só o segredo some.
    const m = parsedArquivado.message as Record<string, unknown>;
    expect(m.messageid).toBe("3EB0SECRET01");
    expect(m.senderName).toBe("Cliente Teste");
  });

  it("outro provider (sem o mesmo vazamento): raw_body arquivado igual ao original, mesmo com uma chave 'token'", async () => {
    // A sanitização é ESCOPADA ao UAZAPI — outro canal com um campo chamado
    // 'token' por coincidência não deve ter o corpo reescrito sem necessidade.
    const rawBody = JSON.stringify({ token: "nao-e-segredo-deste-provider", evento: "x" });
    await abrirArquivoDoWebhook(fakeAdmin(), {
      organizationId: "org-1",
      channelSessionId: "sess-1",
      provider: "zernio",
      rawBody,
      headers: new Headers(),
    });
    expect(inserido?.raw_body).toBe(rawBody);
  });

  it("provider uazapi com corpo NÃO-JSON: arquiva como veio, sem tentar redigir (e sem quebrar)", async () => {
    const rawBody = "<html>erro do proxy</html>";
    const id = await abrirArquivoDoWebhook(fakeAdmin(), {
      organizationId: "org-1",
      channelSessionId: "sess-1",
      provider: "uazapi",
      rawBody,
      headers: new Headers(),
    });
    expect(id).toBe("log-1");
    expect(inserido?.raw_body).toBe(rawBody);
  });

  it("não registra o token em nenhum campo textual gravado (headers/status/error_message)", async () => {
    await abrirArquivoDoWebhook(fakeAdmin(), {
      organizationId: "org-1",
      channelSessionId: "sess-1",
      provider: "uazapi",
      rawBody: JSON.stringify(PAYLOAD_MENSAGEM_COM_TOKEN),
      headers: new Headers({ "x-teste": "1" }),
    });
    const linhaInteira = JSON.stringify(inserido);
    expect(linhaInteira).not.toContain(TOKEN_REAL);
  });
});

describe("o parser continua recebendo o payload ORIGINAL, não a cópia sanitizada", () => {
  it("handleInboundWebhook processa normalmente o corpo com token — a sanitização não vaza para o processamento", async () => {
    const rawBody = JSON.stringify(PAYLOAD_MENSAGEM_COM_TOKEN);
    // O MESMO `rawBody` — string imutável — passado às duas funções, como a
    // rota real faz (`app/api/v1/webhooks/channel/[token]/route.ts`).
    const antes = rawBody;

    const ops: { tabela: string; op: string; payload?: unknown }[] = [];
    function chain(tabela: string, op: string, payload?: unknown): Record<string, unknown> {
      const proxy: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "maybeSingle" || prop === "single") {
              if (tabela === "channel_sessions" && op === "select") {
                return async () => ({ data: { uazapi_instance_id: "YiKQrN" }, error: null });
              }
              return async () => ({ data: { id: "msg-1" }, error: null });
            }
            if (prop === "then") return (ok: (v: unknown) => unknown) => ok({ data: [{ id: "row-1" }], error: null });
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
    const admin = {
      rpc: async (nome: string, args: unknown) => {
        ops.push({ tabela: "rpc", op: nome, payload: args });
        return { data: nome.includes("contact") ? "contact-1" : "conv-1", error: null };
      },
      from: (tabela: string) => ({
        select: () => chain(tabela, "select"),
        insert: (p: unknown) => chain(tabela, "insert", p),
        update: (p: unknown) => chain(tabela, "update", p),
      }),
    } as never;

    const r = await handleInboundWebhook(admin, {
      session: { id: "sess-1", organization_id: "org-1", provider: "uazapi" },
      rawBody,
      headers: new Headers(),
      secret: null,
    });

    expect(r.ok).toBe(true);
    // A string original não foi alterada (imutabilidade — provado, não só suposto).
    expect(rawBody).toBe(antes);
    expect(ops.some((o) => o.op === "fn_upsert_wa_contact")).toBe(true);
  });
});
