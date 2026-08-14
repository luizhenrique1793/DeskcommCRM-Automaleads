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
  // `type` só distingue "text" de "media" (medido: texto puro chega com
  // `type:"text"` e `messageType:"Conversation"` ao mesmo tempo — ver o
  // cabeçalho de `../uazapi/webhook.ts`). A ESPÉCIE de mídia mora em
  // `mediaType` (campo próprio, testado abaixo) — `messageType` fica aqui só
  // como fixture realista, não como o que o parser lê.
  type: "text",
  messageType: "Conversation",
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
  it("fallback: SEM mediaType próprio, usa 'type' — mantém instalações antigas funcionando", () => {
    const msg = parseUazapiMessage(
      envelope("message", {
        ...BASE_MSG,
        type: "image",
        messageType: "ImageMessage",
        fileURL: "https://cdn/img.jpg",
        text: "legenda",
      }),
    );
    expect(msg).toMatchObject({ mediaType: "image", fileUrl: "https://cdn/img.jpg", text: "legenda" });
  });

  it("REAL: type:'media' + mediaType:'image' próprio + content.mimetype — espécie e mime vêm do campo certo", () => {
    // Medido em homologação (2026-08-14): uma imagem de verdade chega com
    // `type:"media"` (NUNCA "image") — a espécie mora em `mediaType`, campo
    // separado. `content` carrega o proto original (mimetype, tamanho, URL
    // temporária). Este é o formato que quebrava antes desta correção: toda
    // imagem real virava `mediaType:"media"` e caía em "document" genérico.
    const msg = parseUazapiMessage(
      envelope("message", {
        ...BASE_MSG,
        type: "media",
        mediaType: "image",
        messageType: "ImageMessage",
        text: "",
        content: {
          URL: "https://mmg.whatsapp.net/o1/v/t24/...",
          mimetype: "image/jpeg",
          fileLength: 54091,
          width: 554,
          height: 556,
        },
      }),
    );
    // `text:""` no payload real vira `null` — `str()` trata string vazia como
    // ausente, mesma convenção do resto deste arquivo (não é regressão).
    expect(msg).toMatchObject({ mediaType: "image", mediaMime: "image/jpeg", text: null });
  });

  it("REAL: caption não-vazia de mídia continua em 'text' (mesmo campo do texto puro)", () => {
    const msg = parseUazapiMessage(
      envelope("message", {
        ...BASE_MSG,
        type: "media",
        mediaType: "image",
        text: "olha essa foto",
        content: { mimetype: "image/jpeg" },
      }),
    );
    expect(msg?.text).toBe("olha essa foto");
  });

  it("content.fileName ausente (não confirmado em payload real de imagem) → fileName:null, sem quebrar", () => {
    const msg = parseUazapiMessage(
      envelope("message", { ...BASE_MSG, type: "media", mediaType: "image", content: { mimetype: "image/jpeg" } }),
    );
    expect(msg?.fileName).toBeNull();
  });

  it("content.fileName presente (best-effort, nome padrão do proto DocumentMessage) → preservado", () => {
    const msg = parseUazapiMessage(
      envelope("message", {
        ...BASE_MSG,
        type: "media",
        mediaType: "document",
        content: { mimetype: "application/pdf", fileName: "relatorio.pdf" },
      }),
    );
    expect(msg?.fileName).toBe("relatorio.pdf");
    expect(msg?.mediaMime).toBe("application/pdf");
  });
});

// 14 — webhook de áudio
describe("parseUazapiMessage — mídia (áudio/PTT)", () => {
  it("fallback: SEM mediaType próprio, usa 'type'", () => {
    const msg = parseUazapiMessage(
      envelope("message", {
        ...BASE_MSG,
        type: "ptt",
        messageType: "AudioMessage",
        fileURL: "https://cdn/a.ogg",
        text: null,
      }),
    );
    expect(msg?.mediaType).toBe("ptt");
    expect(msg?.fileUrl).toBe("https://cdn/a.ogg");
  });

  it("REAL: type:'media' + mediaType:'ptt' — voz não vira documento genérico", () => {
    const msg = parseUazapiMessage(
      envelope("message", {
        ...BASE_MSG,
        type: "media",
        mediaType: "ptt",
        messageType: "AudioMessage",
        content: { mimetype: "audio/ogg; codecs=opus", seconds: 4 },
      }),
    );
    expect(msg?.mediaType).toBe("ptt");
    expect(msg?.mediaMime).toBe("audio/ogg; codecs=opus");
  });

  it("sticker: mediaType:'sticker' preserva o mime real (webp), não cai em document", () => {
    const msg = parseUazapiMessage(
      envelope("message", {
        ...BASE_MSG,
        type: "media",
        mediaType: "sticker",
        messageType: "StickerMessage",
        content: { mimetype: "image/webp" },
      }),
    );
    expect(msg?.mediaType).toBe("sticker");
    expect(msg?.mediaMime).toBe("image/webp");
  });

  it("vídeo (inclui GIF, que chega como vídeo com gifPlayback): mediaType:'video'", () => {
    const msg = parseUazapiMessage(
      envelope("message", {
        ...BASE_MSG,
        type: "media",
        mediaType: "video",
        messageType: "VideoMessage",
        content: { mimetype: "video/mp4", gifPlayback: true },
      }),
    );
    expect(msg?.mediaType).toBe("video");
    expect(msg?.mediaMime).toBe("video/mp4");
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

  it("status DESCONHECIDO degrada para STOPPED — NUNCA para WORKING", () => {
    // O enum oficial (OpenAPI 2.1.1) só tem os quatro valores acima. Um valor
    // fora dele (API mudou, resposta corrompida) não pode virar "conectado":
    // mascarar como WORKING seria a inversão exata do que o vigia de saúde
    // existe para evitar. STOPPED é o lado seguro — nenhuma mensagem
    // entra/sai, e o operador é avisado.
    expect(mapUazapiHealthStatus("um_status_que_nao_existe")).toBe("STOPPED");
    expect(mapUazapiHealthStatus("")).toBe("STOPPED");
  });

  it("só devolve um dos cinco valores que o CHECK do banco aceita", () => {
    const CANONICOS = new Set(["STARTING", "SCAN_QR_CODE", "WORKING", "STOPPED", "FAILED"]);
    for (const bruto of ["connected", "connecting", "disconnected", "hibernated", "lixo"]) {
      expect(CANONICOS.has(mapUazapiHealthStatus(bruto))).toBe(true);
    }
  });
});

/**
 * Formato REAL — medido em homologação, 2026-08-13. Estrutura fiel, valores
 * fabricados (nenhum dado de instância/contato real). Divergiu do OpenAPI
 * 2.1.1 em três pontos: chave `EventType` (não `event`), sem envelope `data`
 * genérico (o corpo do evento fica solto em `message`/`instance`), e a
 * instância se identifica por NOME (`instanceName`), não por um `id` solto.
 * O primeiro teste com instância real devolvia "evento_sem_interesse" para
 * TUDO até este formato ser reconhecido — estes casos são a rede que falta
 * para não regredir.
 */
describe("formato REAL do payload (não o do OpenAPI)", () => {
  const mensagemReal = {
    chat: { id: "5511999999999@s.whatsapp.net", wa_name: "Cliente Teste" },
    owner: "5511888888888",
    token: "tok-nao-usado-neste-teste-36-chars--",
    BaseUrl: "https://free.uazapi.com",
    message: {
      id: "3EB0REAL0001",
      text: "oi, teste",
      type: "text",
      chatid: "5511999999999@s.whatsapp.net",
      fromMe: false,
      sender: "5511999999999@s.whatsapp.net",
      source: "android",
      messageid: "3EB0REAL0001",
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

  const conexaoReal = (status: string, extra: Record<string, unknown> = {}) => ({
    owner: "",
    token: "tok-nao-usado-neste-teste-36-chars--",
    BaseUrl: "https://free.uazapi.com",
    event_id: "evt-fabricado-0001",
    instance: { name: "YiKQrN", status, ...extra },
    EventType: "connection",
    instanceName: "YiKQrN",
  });

  it("envelope: lê EventType (não 'event') e instanceName (não 'instance' string)", () => {
    const env = parseUazapiEnvelope(mensagemReal);
    expect(env).toMatchObject({ event: "messages", instance: "YiKQrN" });
  });

  it("mensagem de texto real vira UazapiInboundMessage corretamente", () => {
    const env = parseUazapiEnvelope(mensagemReal)!;
    const msg = parseUazapiMessage(env);
    expect(msg).toMatchObject({
      direction: "inbound",
      kind: "message",
      chatId: "5511999999999@s.whatsapp.net",
      externalId: "3EB0REAL0001",
      text: "oi, teste",
      mediaType: null, // type:"text" -> não é mídia, mesmo com messageType:"Conversation"
    });
    expect(msg?.identity.phone).toBe("+5511999999999");
  });

  it("evento connection real (objeto {name,status}) vira UazapiConnectionEvent", () => {
    const env = parseUazapiEnvelope(conexaoReal("connected"))!;
    const conexao = parseUazapiConnection(env);
    expect(conexao).toEqual({ status: "connected" });
  });

  it("evento connection real com QR (connecting) também funciona", () => {
    const env = parseUazapiEnvelope(conexaoReal("connecting", { qrcode: "data:image/png;base64,AAAA" }))!;
    const conexao = parseUazapiConnection(env);
    expect(conexao).toEqual({ status: "connecting" });
  });

  it("mensagem de imagem real (envelope completo, EventType+message) vira UazapiInboundMessage com espécie e mime corretos", () => {
    // Estrutura fiel a um evento REAL capturado (2026-08-14, valores
    // anonimizados) — a mesma classe de divergência do EventType/instanceName
    // documentada acima, mas para MÍDIA: `message.type` é "media" (não
    // "image"), e a espécie/mime vêm de `message.mediaType`/`message.content`.
    const imagemReal = {
      ...mensagemReal,
      message: {
        ...mensagemReal.message,
        id: "3EB0REAL0IMG",
        messageid: "3EB0REAL0IMG",
        text: "",
        type: "media",
        mediaType: "image",
        messageType: "ImageMessage",
        content: {
          URL: "https://mmg.whatsapp.net/o1/v/fake",
          mimetype: "image/jpeg",
          fileLength: 54091,
          width: 554,
          height: 556,
        },
      },
    };
    const env = parseUazapiEnvelope(imagemReal)!;
    const msg = parseUazapiMessage(env);
    expect(msg).toMatchObject({
      externalId: "3EB0REAL0IMG",
      mediaType: "image",
      mediaMime: "image/jpeg",
      text: null, // `text:""` no payload real vira null — mesma convenção do str()
    });
  });

  it("retrocompatível: o formato documentado no OpenAPI (event/instance string/data) continua funcionando", () => {
    const env = parseUazapiEnvelope({
      event: "message",
      instance: "algum-id-antigo",
      data: { ...mensagemReal.message },
    });
    expect(env).toMatchObject({ event: "message", instance: "algum-id-antigo" });
    const msg = parseUazapiMessage(env!);
    expect(msg?.externalId).toBe("3EB0REAL0001");
  });
});
