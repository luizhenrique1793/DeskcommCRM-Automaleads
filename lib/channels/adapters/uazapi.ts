/**
 * Adapter UAZAPI — canal por QR/pairing como o WAHA, com credencial por
 * sessão como o intermediado (ver `../uazapi/credentials.ts` para o porquê).
 *
 * Burro como os irmãos: traduz formato e nada mais. Contrato confirmado em
 * `https://docs.uazapi.com/openapi-bundled.json` (2.1.1) — ver comentários de
 * `../uazapi/client.ts` para o endpoint exato de cada método.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import type { FetchedMedia } from "@/lib/messaging/media/types";

import { resolveUazapiCreds } from "../uazapi/credentials";
import { uazapiClient } from "../uazapi/client";
import { mapUazapiHealthStatus } from "../uazapi/webhook";
import type {
  ChannelAdapter,
  ChannelHealth,
  OutboundEnvelope,
  OutboundKind,
  RecipientInput,
} from "../types";

/** `kind` do envelope → `type` que `/send/media` espera. */
function mediaTypeFor(kind: OutboundKind): "image" | "video" | "document" | "audio" | "ptt" {
  switch (kind) {
    case "image":
      return "image";
    case "video":
      return "video";
    case "audio":
      // Bolha de voz, não arquivo de áudio solto — mesma escolha do WAHA
      // (`sendVoice`) e do canal intermediado (`voiceNote: true`).
      return "ptt";
    default:
      return "document";
  }
}

export const uazapiAdapter: ChannelAdapter = {
  provider: "uazapi",

  /**
   * Grupo devolve `null`: a capability declara `groups: "none"` (a ingestão
   * também os ignora, mesma política do canal por QR — CLAUDE.md) e endereçar
   * um destino que nunca vira conversa no CRM seria enviar para o vazio.
   */
  resolveRecipient(input: RecipientInput): string | null {
    if (input.isGroup) return null;
    if (input.waLid) return `${input.waLid}@lid`;
    if (input.waIdentity?.startsWith("lid:")) return `${input.waIdentity.slice("lid:".length)}@lid`;
    if (input.phoneNumber) return input.phoneNumber.replace(/\D/g, "");
    return null;
  },

  // Síncrono, então não pode consultar a sessão gravada — só diz se HÁ
  // caminho de credencial (env). A pergunta "esta ORG específica está
  // configurada?" só `send`/`checkHealth` respondem, que podem ir ao banco.
  isConfigured(): boolean {
    return !!process.env.UAZAPI_BASE_URL;
  },

  codes: {
    notConfigured: "uazapi_not_configured",
    sendFailed: "uazapi_error",
    unknownError: "uazapi_unknown",
  },

  async send(envelope: OutboundEnvelope): Promise<{ externalId: string | null }> {
    const admin = createAdminClient();
    const creds = await resolveUazapiCreds(admin, envelope.sessionRef);
    if (!creds) return { externalId: null };

    const result = envelope.media
      ? await uazapiClient.sendMedia(creds, envelope.to, {
          type: mediaTypeFor(envelope.kind),
          file: envelope.media.url,
          text: envelope.media.caption ?? undefined,
          docName: envelope.media.filename ?? undefined,
          mimetype: envelope.media.mime,
        })
      : await uazapiClient.sendText(creds, envelope.to, envelope.body ?? "");

    return { externalId: result.messageId };
  },

  /**
   * `/chat/details` traz a imagem em dois tamanhos; pedimos `full` (o padrão
   * do endpoint) pela mesma razão do WAHA: a URL é assinada e temporária, quem
   * chama baixa e persiste — pedir a menor faria a foto persistida ficar pior
   * que a que o cliente vê no próprio WhatsApp.
   */
  async fetchProfilePictureUrl(input: { sessionRef: string; recipient: string }): Promise<string | null> {
    const admin = createAdminClient();
    const creds = await resolveUazapiCreds(admin, input.sessionRef);
    if (!creds) return null;
    const details = await uazapiClient.chatDetails(creds, input.recipient);
    return details?.image ?? null;
  },

  /**
   * `lid:123…` → `+595...`, via `/chat/check` (que devolve `jid`+`lid` juntos
   * para um número). Só para identidade OPACA: telefone já se basta.
   *
   * `/chat/check` recebe TELEFONE ou id de grupo — não aceita LID como entrada
   * para resolver o par na direção inversa (lid→phone). Por isso, quando o
   * UAZAPI ainda não resolveu o par na origem (`sender_pn` ausente no
   * webhook), este método não tem como perguntar e devolve `null` — "ainda não
   * sei", não erro. O par chega OUTRA hora pelo próprio webhook, quando o
   * UAZAPI o resolver internamente.
   */
  async resolvePhoneForIdentity(): Promise<string | null> {
    return null;
  },

  async checkHealth(input: { sessionRef: string }): Promise<ChannelHealth> {
    const admin = createAdminClient();
    const creds = await resolveUazapiCreds(admin, input.sessionRef);
    if (!creds) return { reachable: false, status: null, detail: "sem_credencial_para_a_sessao" };

    try {
      const status = await uazapiClient.getStatus(creds);
      // `getStatus` devolve `null` quando o token foi recusado (401/403): a
      // credencial existe e não vale mais — é FAILED, não "não deu para
      // perguntar". Ver o mesmo raciocínio em `../adapters/zernio.ts`.
      if (!status) return { reachable: true, status: "FAILED", detail: null };
      // `ownerJid` já vem só-dígitos (`.user` de um JID `<digitos>@s.whatsapp.net`
      // — ver `../uazapi/client.ts`), mesmo formato que `channel_sessions.phone_number`
      // usa no ramo WAHA. `null` enquanto a instância não tiver feito login ainda.
      return {
        reachable: true,
        status: mapUazapiHealthStatus(status.status),
        detail: null,
        phoneNumber: status.ownerJid,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : "erro_desconhecido";
      return { reachable: false, status: null, detail: detail.slice(0, 200) };
    }
  },

  /**
   * Pede os bytes já em base64 no MESMO pedido (`return_base64: true`,
   * `return_link: false`) — sem segunda busca a uma URL vinda do payload, que
   * é a classe de SSRF que o canal intermediado precisa neutralizar. Aqui essa
   * classe de risco não existe: ver cabeçalho de `../uazapi/client.ts`.
   */
  async fetchInboundMedia(input: {
    sessionRef: string;
    url: string;
    hintMime?: string | null;
  }): Promise<FetchedMedia> {
    const admin = createAdminClient();
    const creds = await resolveUazapiCreds(admin, input.sessionRef);
    if (!creds) throw new Error("uazapi_not_configured: sem credencial para baixar a mídia.");

    // `url` aqui é o `messageid` (ver `../uazapi/ingest.ts`: `media_url` grava
    // o `fileURL` do webhook só como REFERÊNCIA visível; o download de verdade
    // é sempre por id de mensagem, autenticado pelo `token` da instância).
    const baixado = await uazapiClient.downloadMedia(creds, input.url);
    if (!baixado) throw new Error("uazapi_media_failed: download sem retorno utilizável.");
    return { buffer: baixado.buffer, mime: baixado.mime || input.hintMime || "application/octet-stream" };
  },

  /**
   * `/contact/add` — salva o lead na agenda do WhatsApp da instância.
   * `saveContact` é opcional no contrato (`ChannelAdapter`); a feature
   * pergunta `!!adapter.saveContact`, nunca `provider === "uazapi"`.
   */
  async saveContact(input: {
    sessionRef: string;
    phoneNumber: string;
    name: string;
  }): Promise<{ ok: true } | { ok: false; reason: string }> {
    const admin = createAdminClient();
    const creds = await resolveUazapiCreds(admin, input.sessionRef);
    if (!creds) return { ok: false, reason: "uazapi_not_configured" };
    return uazapiClient.addContact(creds, {
      number: input.phoneNumber.replace(/\D/g, ""),
      name: input.name,
    });
  },
};
