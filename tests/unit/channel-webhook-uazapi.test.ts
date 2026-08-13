import { describe, expect, it } from "vitest";

/**
 * Leitura pura do webhook UAZAPI (`lib/channels/uazapi/webhook.ts`).
 *
 * Envelope confirmado no OpenAPI oficial 2.1.1: `{event, instance, data}`,
 * com `data` no MESMO formato `Message` das respostas de envio (`messageid`,
 * `chatid`, `sender`, `fromMe`, `sender_pn`, `sender_lid`, `messageTimestamp`).
 */
import {
  mapUazapiHealthStatus,
  parseUazapiConnection,
  parseUazapiEnvelope,
  parseUazapiMessage,
  parseUazapiStatus,
  resolveUazapiIdentity,
} from "@/lib/channels/uazapi/webhook";

function envelope(event: string, data: Record<string, unknown>) {
  return { event, instance: "r183e2ef9597845", data };
}

const BASE_MSG = {
  messageid: "3EB0ABC123",
  chatid: "5511999999999@s.whatsapp.net",
  sender: "5511999999999@s.whatsapp.net",
  senderName: "Maria",
  isGroup: false,
  fromMe: false,
  messageType: "text",
  messageTimestamp: 1755000000000,
  text: "Olá, tudo bem?",
};

describe("parseUazapiEnvelope", () => {
  it("lê event/instance/data", () => {
    const env = parseUazapiEnvelope({ event: "message", instance: "i1", data: { a: 1 } });
    expect(env).toEqual({ event: "message", instance: "i1", data: { a: 1 } });
  });

  it("payload sem 'event' é null", () => {
    expect(parseUazapiEnvelope({ data: {} })).toBeNull();
    expect(parseUazapiEnvelope(null)).toBeNull();
    expect(parseUazapiEnvelope("string")).toBeNull();
  });
});

// 12 — webhook de texto
describe("parseUazapiMessage — texto", () => {
  it("lê mensagem de texto recebida", () => {
    const msg = parseUazapiMessage(envelope("message", BASE_MSG));
    expect(msg).toMatchObject({
      direction: "inbound",
      kind: "message",
      chatId: "5511999999999@s.whatsapp.net",
      externalId: "3EB0ABC123",
      text: "Olá, tudo bem?",
      mediaType: null,
    });
    expect(msg?.sentAt).toBe(new Date(1755000000000).toISOString());
  });

  it("evento que não é 'message' devolve null", () => {
    expect(parseUazapiMessage(envelope("presence", BASE_MSG))).toBeNull();
  });

  it("sem chatid ou sem messageid devolve null", () => {
    expect(parseUazapiMessage(envelope("message", { ...BASE_MSG, chatid: undefined }))).toBeNull();
    expect(parseUazapiMessage(envelope("message", { ...BASE_MSG, messageid: undefined }))).toBeNull();
  });
});

// 13 — webhook de imagem
describe("parseUazapiMessage — mídia (imagem)", () => {
  it("messageType 'image' com fileURL vira mediaType+fileUrl", () => {
    const msg = parseUazapiMessage(
      envelope("message", {
        ...BASE_MSG,
        messageType: "image",
        fileURL: "https://cdn/img.jpg",
        text: "legenda",
      }),
    );
    expect(msg).toMatchObject({ mediaType: "image", fileUrl: "https://cdn/img.jpg", text: "legenda" });
  });
});

// 14 — webhook de áudio
describe("parseUazapiMessage — mídia (áudio/PTT)", () => {
  it("messageType 'ptt' vira mediaType 'ptt'", () => {
    const msg = parseUazapiMessage(
      envelope("message", { ...BASE_MSG, messageType: "ptt", fileURL: "https://cdn/a.ogg", text: null }),
    );
    expect(msg?.mediaType).toBe("ptt");
    expect(msg?.fileUrl).toBe("https://cdn/a.ogg");
  });
});

// 15 — webhook fromMe (com bug de identidade corrigido: sender é a PRÓPRIA
// instância numa mensagem outbound, não o destinatário)
describe("parseUazapiMessage — fromMe", () => {
  it("fromMe:true vira outbound e resolve identidade pelo CHATID, não pelo sender", () => {
    const msg = parseUazapiMessage(
      envelope("message", {
        ...BASE_MSG,
        fromMe: true,
        chatid: "5511988887777@s.whatsapp.net",
        // `sender` aqui é a PRÓPRIA instância (medido no schema Message) —
        // se o parser o usasse, o contato viraria "nós mesmos".
        sender: "5511900000000@s.whatsapp.net",
      }),
    );
    expect(msg?.direction).toBe("outbound");
    expect(msg?.identity.phone).toBe("+5511988887777");
    expect(msg?.identity.anchor).not.toEqual({ kind: "phone", value: "+5511900000000" });
  });

  it("grupo é SEMPRE ignorado — SKIP CRM binding, mesma política do canal por QR", () => {
    expect(parseUazapiMessage(envelope("message", { ...BASE_MSG, isGroup: true }))).toBeNull();
  });
});

// 16 — "duplicado" na camada de parsing: o mesmo payload processado duas
// vezes produz o MESMO externalId — a deduplicação de verdade (unique
// (organization_id, external_id) + captura do 23505) é vigiada em
// channel-ingest-uazapi.test.ts, mas a garantia começa aqui: sem
// determinismo no id extraído, a constraint no banco não teria o que comparar.
describe("determinismo do externalId (pré-requisito da deduplicação)", () => {
  it("o mesmo payload produz o mesmo externalId nas duas leituras", () => {
    const a = parseUazapiMessage(envelope("message", BASE_MSG));
    const b = parseUazapiMessage(envelope("message", BASE_MSG));
    expect(a?.externalId).toBe(b?.externalId);
    expect(a?.externalId).toBe("3EB0ABC123");
  });
});

// 17 — nome / pushName
describe("nome exibido (senderName / push name)", () => {
  it("inbound usa senderName do remetente", () => {
    const msg = parseUazapiMessage(envelope("message", { ...BASE_MSG, senderName: "Cliente Feliz" }));
    expect(msg?.identity.displayName).toBe("Cliente Feliz");
  });

  it("outbound (fromMe) também carrega o senderName para exibição", () => {
    const msg = parseUazapiMessage(envelope("message", { ...BASE_MSG, fromMe: true, senderName: "X" }));
    expect(msg?.identity.displayName).toBe("X");
  });
});

// 18 — JID + LID
describe("resolveUazapiIdentity — JID e LID", () => {
  it("prioriza sender_pn/sender_lid RESOLVIDOS sobre o sender cru — os dois juntos preenchem phone e lid na mesma mensagem", () => {
    const id = resolveUazapiIdentity({
      sender: "123456@lid",
      sender_pn: "5511999999999@s.whatsapp.net",
      sender_lid: "123456@lid",
      senderName: "Fulano",
    });
    expect(id.phone).toBe("+5511999999999");
    expect(id.lid).toBe("123456");
    expect(id.anchor).toEqual({ kind: "phone", value: "+5511999999999" });
  });

  it("sem os campos resolvidos, decide pelo sufixo do sender cru — @lid", () => {
    const id = resolveUazapiIdentity({ sender: "987654@lid", senderName: null });
    expect(id.lid).toBe("987654");
    expect(id.phone).toBeNull();
    expect(id.anchor).toEqual({ kind: "lid", value: "987654" });
  });

  it("sem os campos resolvidos, decide pelo sufixo do sender cru — telefone", () => {
    const id = resolveUazapiIdentity({ sender: "5511999999999@s.whatsapp.net", senderName: null });
    expect(id.phone).toBe("+5511999999999");
    expect(id.anchor).toEqual({ kind: "phone", value: "+5511999999999" });
  });

  it("mensagem sem sender algum → anchor null (payload sem identidade utilizável)", () => {
    const id = resolveUazapiIdentity({ senderName: null });
    expect(id.anchor).toBeNull();
  });
});

describe("parseUazapiStatus — desfecho de entrega", () => {
  it("status conhecido vira o vocabulário do CRM", () => {
    const s = parseUazapiStatus(envelope("status", { messageid: "m1", status: "Delivered" }));
    expect(s).toMatchObject({ kind: "status", status: "delivered", externalId: "m1" });
  });

  it("status Failed carrega o motivo", () => {
    const s = parseUazapiStatus(
      envelope("status", { messageid: "m1", status: "Failed", error: "número bloqueado" }),
    );
    expect(s?.errorReason).toBe("número bloqueado");
  });

  it("status desconhecido do provider devolve null — não inventa vocabulário", () => {
    expect(parseUazapiStatus(envelope("status", { messageid: "m1", status: "Pending" }))).toBeNull();
  });
});

describe("parseUazapiConnection + mapUazapiHealthStatus", () => {
  it("lê o status do evento connection", () => {
    const c = parseUazapiConnection(envelope("connection", { status: "connected" }));
    expect(c).toEqual({ status: "connected" });
  });

  it("mapeia para o vocabulário de saúde do CRM", () => {
    expect(mapUazapiHealthStatus("connected")).toBe("WORKING");
    expect(mapUazapiHealthStatus("connecting")).toBe("SCAN_QR_CODE");
    expect(mapUazapiHealthStatus("disconnected")).toBe("STOPPED");
    expect(mapUazapiHealthStatus("hibernated")).toBe("STOPPED");
  });
});
