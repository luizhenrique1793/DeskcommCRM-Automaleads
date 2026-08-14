import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Adapter UAZAPI — o transporte.
 *
 * Contrato confirmado no OpenAPI oficial 2.1.1
 * (`https://docs.uazapi.com/openapi-bundled.json`), não adivinhado:
 *
 *   POST /instance/status  → { instance:{status,qrcode,paircode,...}, status:{connected,loggedIn,jid} }
 *   POST /send/text        → { messageid, status }
 *   POST /send/media       → { messageid, status } — `type` inclui `ptt` (voice note)
 *   POST /chat/details     → { wa_contactName, wa_name, name, image, phone }
 *   POST /contact/add      → { success, message, contact }
 *
 * Auth por header `token` (não Bearer) — o único que autentica cada chamada
 * de instância.
 */

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

const credsRef: { current: unknown } = { current: null };
vi.mock("@/lib/channels/uazapi/credentials", () => ({
  resolveUazapiCreds: async () => credsRef.current,
}));

import { uazapiAdapter } from "@/lib/channels/adapters/uazapi";
import { getAdapter } from "@/lib/channels";

const CREDS = {
  instanceId: "r183e2ef9597845",
  token: "tok_abc123",
  baseUrl: "https://gateway.exemplo.com",
  source: "session" as const,
};

const ultimaChamada = () => ({
  url: String(fetchMock.mock.calls.at(-1)?.[0] ?? ""),
  init: (fetchMock.mock.calls.at(-1)?.[1] ?? {}) as {
    headers?: Record<string, string>;
    body?: string;
  },
});
const corpo = () => JSON.parse(ultimaChamada().init.body ?? "{}") as Record<string, unknown>;

beforeEach(() => {
  fetchMock.mockReset();
  credsRef.current = CREDS;
});

// 1 — adapter registrado corretamente
describe("registro no seam", () => {
  it("getAdapter('uazapi') devolve o adapter do UAZAPI", () => {
    expect(getAdapter("uazapi")).toBe(uazapiAdapter);
    expect(uazapiAdapter.provider).toBe("uazapi");
  });
});

// 5/6 — recipient por telefone e por JID/LID
describe("resolveRecipient", () => {
  it("telefone vira dígitos puros — /send/text aceita número simples", () => {
    expect(
      uazapiAdapter.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: "+55 (11) 99999-9999",
        waIdentity: null,
      }),
    ).toBe("5511999999999");
  });

  it("wa_lid vira <lid>@lid", () => {
    expect(
      uazapiAdapter.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: null,
        waIdentity: null,
        waLid: "123456789",
      }),
    ).toBe("123456789@lid");
  });

  it("wa_identity lid: também vira @lid quando wa_lid está ausente", () => {
    expect(
      uazapiAdapter.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: null,
        waIdentity: "lid:987654321",
      }),
    ).toBe("987654321@lid");
  });

  it("grupo devolve null — capability declara groups:'none'", () => {
    expect(
      uazapiAdapter.resolveRecipient({
        isGroup: true,
        groupChatId: "123@g.us",
        phoneNumber: "+5511999999999",
        waIdentity: null,
      }),
    ).toBeNull();
  });

  it("sem telefone e sem identidade devolve null", () => {
    expect(
      uazapiAdapter.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: null,
        waIdentity: null,
      }),
    ).toBeNull();
  });
});

// 2 — envio de texto
describe("send — texto", () => {
  it("chama /send/text com número e texto, autentica por header token", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      json: async () => ({ messageid: "3EB0ABC123", status: "Sent" }),
    });
    const r = await uazapiAdapter.send({
      sessionRef: CREDS.instanceId,
      to: "5511999999999",
      kind: "text",
      body: "olá",
    });
    expect(ultimaChamada().url).toBe(`${CREDS.baseUrl}/send/text`);
    expect(ultimaChamada().init.headers?.token).toBe(CREDS.token);
    expect(corpo()).toMatchObject({ number: "5511999999999", text: "olá" });
    expect(r.externalId).toBe("3EB0ABC123");
  });

  it("sem credencial devolve externalId null, sem chamar fetch — canal não configurado é noop", async () => {
    credsRef.current = null;
    const r = await uazapiAdapter.send({
      sessionRef: "x",
      to: "5511999999999",
      kind: "text",
      body: "olá",
    });
    expect(r.externalId).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// 3 — envio de mídia
describe("send — mídia", () => {
  const media = { url: "https://s/x.jpg", mime: "image/jpeg", filename: "x.jpg", caption: "olha" };

  it("imagem vira type:'image' em /send/media", async () => {
    fetchMock.mockResolvedValueOnce({ status: 200, json: async () => ({ messageid: "m1" }) });
    await uazapiAdapter.send({
      sessionRef: CREDS.instanceId,
      to: "5511999999999",
      kind: "image",
      media,
    });
    expect(ultimaChamada().url).toBe(`${CREDS.baseUrl}/send/media`);
    expect(corpo()).toMatchObject({
      number: "5511999999999",
      type: "image",
      file: media.url,
      text: "olha",
      docName: "x.jpg",
      mimetype: "image/jpeg",
    });
  });

  it("documento cai em type:'document'", async () => {
    fetchMock.mockResolvedValueOnce({ status: 200, json: async () => ({ messageid: "m2" }) });
    await uazapiAdapter.send({
      sessionRef: CREDS.instanceId,
      to: "5511999999999",
      kind: "document",
      media: { ...media, mime: "application/pdf", filename: "d.pdf", caption: null },
    });
    expect(corpo().type).toBe("document");
  });
});

// 4 — PTT / voice note
describe("send — PTT (voice note)", () => {
  it("kind:'audio' vira type:'ptt', não 'audio' solto — é a bolha de voz, não arquivo", async () => {
    fetchMock.mockResolvedValueOnce({ status: 200, json: async () => ({ messageid: "m3" }) });
    await uazapiAdapter.send({
      sessionRef: CREDS.instanceId,
      to: "5511999999999",
      kind: "audio",
      media: { url: "https://s/a.ogg", mime: "audio/ogg", filename: null, caption: null },
    });
    expect(corpo().type).toBe("ptt");
  });
});

// 8 — foto de perfil
describe("fetchProfilePictureUrl", () => {
  it("lê `image` de /chat/details", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      json: async () => ({ image: "https://cdn/x.jpg", wa_name: "João", name: "João" }),
    });
    const url = await uazapiAdapter.fetchProfilePictureUrl!({
      sessionRef: CREDS.instanceId,
      recipient: "5511999999999",
    });
    expect(url).toBe("https://cdn/x.jpg");
    expect(ultimaChamada().url).toBe(`${CREDS.baseUrl}/chat/details`);
  });

  it("sem credencial devolve null, sem chamar fetch", async () => {
    credsRef.current = null;
    const url = await uazapiAdapter.fetchProfilePictureUrl!({
      sessionRef: "x",
      recipient: "5511999999999",
    });
    expect(url).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// 7 — LID → telefone (resolvePhoneForIdentity)
describe("resolvePhoneForIdentity", () => {
  it("devolve null sempre — /chat/check não aceita LID como ENTRADA para resolver o par inverso", async () => {
    // Documentado no próprio adapter: o par phone/lid chega pronto no
    // webhook (`sender_pn`/`sender_lid`) quando o UAZAPI já o resolveu; não
    // há endpoint para perguntar "que telefone é este LID" isoladamente.
    const r = await uazapiAdapter.resolvePhoneForIdentity!({
      sessionRef: CREDS.instanceId,
      identity: "lid:123456789",
    });
    expect(r).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// 9/10/11 — health conectado / desconectado / API inalcançável
describe("checkHealth", () => {
  it("connected → reachable:true, status:WORKING, phoneNumber = ownerJid só-dígitos", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      json: async () => ({
        instance: { status: "connected" },
        status: { connected: true, loggedIn: true, jid: { user: "5511999999999" } },
      }),
    });
    const h = await uazapiAdapter.checkHealth!({ sessionRef: CREDS.instanceId });
    expect(h).toEqual({
      reachable: true,
      status: "WORKING",
      detail: null,
      phoneNumber: "5511999999999",
    });
  });

  it("disconnected → reachable:true, status:STOPPED, sem jid → phoneNumber:null", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      json: async () => ({ instance: { status: "disconnected" }, status: { connected: false } }),
    });
    const h = await uazapiAdapter.checkHealth!({ sessionRef: CREDS.instanceId });
    expect(h).toEqual({ reachable: true, status: "STOPPED", detail: null, phoneNumber: null });
  });

  it("connecting → SCAN_QR_CODE (aguardando QR/pairing)", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      json: async () => ({ instance: { status: "connecting" }, status: { connected: false } }),
    });
    const h = await uazapiAdapter.checkHealth!({ sessionRef: CREDS.instanceId });
    expect(h.status).toBe("SCAN_QR_CODE");
  });

  it("401 (token recusado) → reachable:true, status:FAILED — não é 'não deu para perguntar'", async () => {
    fetchMock.mockResolvedValueOnce({ status: 401, json: async () => ({ error: "unauthorized" }) });
    const h = await uazapiAdapter.checkHealth!({ sessionRef: CREDS.instanceId });
    expect(h).toEqual({ reachable: true, status: "FAILED", detail: null });
  });

  it("erro de REDE → reachable:false — não inventa estado do canal", async () => {
    fetchMock.mockRejectedValueOnce(new Error("fetch failed: ECONNREFUSED"));
    const h = await uazapiAdapter.checkHealth!({ sessionRef: CREDS.instanceId });
    expect(h.reachable).toBe(false);
    expect(h.status).toBeNull();
  });

  it("sem credencial → reachable:false, sem chamar fetch", async () => {
    credsRef.current = null;
    const h = await uazapiAdapter.checkHealth!({ sessionRef: "x" });
    expect(h.reachable).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// 19 — salvar contato
describe("saveContact", () => {
  it("chama /contact/add com número e nome", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      json: async () => ({ success: true, contact: { jid: "5511999999999@s.whatsapp.net" } }),
    });
    const r = await uazapiAdapter.saveContact!({
      sessionRef: CREDS.instanceId,
      phoneNumber: "+55 11 99999-9999",
      name: "Maria Cliente",
    });
    expect(r).toEqual({ ok: true });
    expect(ultimaChamada().url).toBe(`${CREDS.baseUrl}/contact/add`);
    expect(corpo()).toEqual({ number: "5511999999999", name: "Maria Cliente" });
  });

  it("provedor recusa → ok:false com o motivo", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      json: async () => ({ success: false, message: "número inválido" }),
    });
    const r = await uazapiAdapter.saveContact!({
      sessionRef: CREDS.instanceId,
      phoneNumber: "123",
      name: "X",
    });
    expect(r).toEqual({ ok: false, reason: "número inválido" });
  });

  it("sem credencial → ok:false, sem chamar fetch", async () => {
    credsRef.current = null;
    const r = await uazapiAdapter.saveContact!({
      sessionRef: "x",
      phoneNumber: "+5511999999999",
      name: "X",
    });
    expect(r).toEqual({ ok: false, reason: "uazapi_not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("códigos que o handler grava", () => {
  it("nomeiam o canal", () => {
    expect(uazapiAdapter.codes).toEqual({
      notConfigured: "uazapi_not_configured",
      sendFailed: "uazapi_error",
      unknownError: "uazapi_unknown",
    });
  });
});
