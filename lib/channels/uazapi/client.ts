/**
 * Cliente HTTP fino do UAZAPI — só os endpoints que o DeskcommCRM consome
 * (contrato confirmado em `https://docs.uazapi.com/openapi-bundled.json`,
 * versão 2.1.1). Cada método é uma tradução 1:1 de um endpoint; regra de
 * negócio não mora aqui (ver `../adapters/uazapi.ts`).
 *
 * ─── Por que não busca mídia por URL ─────────────────────────────────────────
 *
 * `/message/download` aceita `return_base64: true` e devolve os bytes no
 * próprio corpo (autenticado pelo `token` da instância, mesma chamada). Pedir
 * SEMPRE base64 (e nunca `return_link`) evita uma SEGUNDA busca a uma URL que
 * viria do payload — a classe de SSRF que o canal intermediado precisa
 * neutralizar (`assertSafeOutboundUrl`) simplesmente não existe aqui.
 *
 * ─── Por que a Base URL não passa por checagem de SSRF ──────────────────────
 *
 * Diferente da URL de mídia (dado do payload, não confiável), a Base URL é
 * CONFIGURAÇÃO DE OPERADOR — o mesmo status de `WAHA_BASE_URL`/
 * `ZERNIO_API_BASE_URL`. Num self-host típico o UAZAPI roda como contêiner
 * irmão na rede interna do Docker (`http://uazapi:9000`, IP privado de
 * propósito) — bloquear faixa privada aqui quebraria justamente o desenho que
 * o produto pede. Quem escreve a Base URL já passou pelo gate de `admin`.
 */
import type { UazapiCredentials } from "./credentials";

const TIMEOUT_MS = 20_000;

export interface UazapiInstanceStatus {
  status: "disconnected" | "connecting" | "connected" | "hibernated" | string;
  connected: boolean;
  loggedIn: boolean;
  qrcode: string | null;
  paircode: string | null;
  profileName: string | null;
  profilePicUrl: string | null;
  ownerJid: string | null;
}

export interface UazapiSendResult {
  messageId: string | null;
  status: string | null;
}

export interface UazapiChatCheckResult {
  query: string;
  jid: string | null;
  lid: string | null;
  isInWhatsapp: boolean;
  verifiedName: string | null;
}

export interface UazapiChatDetails {
  waContactName: string | null;
  waName: string | null;
  name: string | null;
  phone: string | null;
  image: string | null;
}

class UazapiHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "UazapiHttpError";
  }
}

async function call(
  creds: UazapiCredentials,
  path: string,
  init: { method: "GET" | "POST"; body?: unknown } = { method: "GET" },
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const url = `${creds.baseUrl.replace(/\/+$/, "")}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method,
      headers: {
        token: creds.token,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "erro_desconhecido";
    throw new UazapiHttpError(0, `uazapi_unreachable: ${detail}`);
  }

  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: res.status, json };
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export const uazapiClient = {
  /** `GET /instance/status` — o estado agora, incluindo QR/pairing atualizados. */
  async getStatus(creds: UazapiCredentials): Promise<UazapiInstanceStatus | null> {
    const { status, json } = await call(creds, "/instance/status");
    if (status === 401 || status === 403) return null;
    const instance = asRecord(json?.instance);
    const statusObj = asRecord(json?.status);
    const jid = asRecord(statusObj?.jid);
    return {
      status: asString(instance?.status) ?? "disconnected",
      connected: statusObj?.connected === true,
      loggedIn: statusObj?.loggedIn === true,
      qrcode: asString(instance?.qrcode),
      paircode: asString(instance?.paircode),
      profileName: asString(instance?.profileName),
      profilePicUrl: asString(instance?.profilePicUrl),
      ownerJid: jid ? (asString(jid.user) ?? null) : null,
    };
  },

  /** `POST /instance/connect` — inicia QR (sem `phone`) ou pairing code (com `phone`). */
  async connect(creds: UazapiCredentials, phone?: string | null): Promise<void> {
    await call(creds, "/instance/connect", {
      method: "POST",
      body: phone ? { phone } : {},
    });
  },

  /** `POST /instance/disconnect`. */
  async disconnect(creds: UazapiCredentials): Promise<void> {
    await call(creds, "/instance/disconnect", { method: "POST" });
  },

  /**
   * `POST /webhook` — registra a URL genérica do canal
   * (`app/api/v1/webhooks/channel/[token]`) para os eventos que o CRM
   * consome. Chamado pela própria rota de conexão, uma vez, logo após validar
   * a credencial — o UAZAPI tem API própria para isso, então o operador não
   * precisa colar URL em painel nenhum (diferente do canal intermediado, cujo
   * provedor não expõe o mesmo self-service).
   */
  async setWebhook(creds: UazapiCredentials, url: string): Promise<boolean> {
    const { status } = await call(creds, "/webhook", {
      method: "POST",
      body: { enabled: true, url, events: ["messages", "messages_update", "connection"] },
    });
    return status === 200;
  },

  /** `POST /send/text`. */
  async sendText(creds: UazapiCredentials, to: string, text: string): Promise<UazapiSendResult> {
    const { json } = await call(creds, "/send/text", { method: "POST", body: { number: to, text } });
    return { messageId: asString(json?.messageid), status: asString(json?.status) };
  },

  /** `POST /send/media` — `type` cobre imagem/vídeo/documento/áudio/PTT. */
  async sendMedia(
    creds: UazapiCredentials,
    to: string,
    input: {
      type: "image" | "video" | "document" | "audio" | "ptt";
      file: string;
      text?: string | null;
      docName?: string | null;
      mimetype?: string | null;
    },
  ): Promise<UazapiSendResult> {
    const { json } = await call(creds, "/send/media", {
      method: "POST",
      body: {
        number: to,
        type: input.type,
        file: input.file,
        ...(input.text ? { text: input.text } : {}),
        ...(input.docName ? { docName: input.docName } : {}),
        ...(input.mimetype ? { mimetype: input.mimetype } : {}),
      },
    });
    return { messageId: asString(json?.messageid), status: asString(json?.status) };
  },

  /** `POST /chat/check` — um número por chamada (o chamador já sabe qual quer). */
  async checkChat(creds: UazapiCredentials, number: string): Promise<UazapiChatCheckResult | null> {
    // A resposta é um ARRAY na raiz (não um objeto) — `json` aqui é o array
    // cru, só tipado largo por `call()`. `Array.isArray` antes de indexar
    // evita tratar um objeto de erro (`{error: "..."}`) como se fosse a lista.
    const { json } = await call(creds, "/chat/check", { method: "POST", body: { numbers: [number] } });
    const row = Array.isArray(json) ? asRecord((json as unknown[])[0]) : null;
    if (!row) return null;
    return {
      query: asString(row.query) ?? number,
      jid: asString(row.jid),
      lid: asString(row.lid),
      isInWhatsapp: row.isInWhatsapp === true,
      verifiedName: asString(row.verifiedName),
    };
  },

  /** `POST /chat/details` — nome consolidado, nome de agenda, push name, foto. */
  async chatDetails(creds: UazapiCredentials, number: string): Promise<UazapiChatDetails | null> {
    const { status, json } = await call(creds, "/chat/details", {
      method: "POST",
      body: { number, preview: false },
    });
    if (status !== 200 || !json) return null;
    return {
      waContactName: asString(json.wa_contactName),
      waName: asString(json.wa_name),
      name: asString(json.name),
      phone: asString(json.phone),
      image: asString(json.image),
    };
  },

  /** `POST /contact/add` — salva o lead na agenda do WhatsApp da instância. */
  async addContact(
    creds: UazapiCredentials,
    input: { number: string; name: string },
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const { status, json } = await call(creds, "/contact/add", { method: "POST", body: input });
    if (status === 200 && json?.success !== false) return { ok: true };
    const reason = asString(json?.message) ?? asString(json?.error) ?? `status_${status}`;
    return { ok: false, reason };
  },

  /**
   * `POST /message/download` com `return_base64: true, return_link: false` —
   * bytes direto na resposta, sem segunda busca a URL (ver cabeçalho do arquivo).
   */
  async downloadMedia(
    creds: UazapiCredentials,
    messageId: string,
  ): Promise<{ buffer: Buffer; mime: string } | null> {
    const { status, json } = await call(creds, "/message/download", {
      method: "POST",
      body: { id: messageId, return_base64: true, return_link: false },
    });
    if (status !== 200 || !json) return null;
    const base64 = asString(json.base64Data);
    if (!base64) return null;
    const mime = asString(json.mimetype) ?? "application/octet-stream";
    return { buffer: Buffer.from(base64, "base64"), mime };
  },
};

export { UazapiHttpError };
