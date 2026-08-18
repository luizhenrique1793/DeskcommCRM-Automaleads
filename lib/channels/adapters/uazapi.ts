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

/**
 * `recipient` chega no formato universal do seam (`<dígitos>@c.us` ou
 * `<dígitos>@s.whatsapp.net`, mesmo que `chatIdFromIdentity` em
 * `app/api/v1/cron/contact-avatars/route.ts` produz para todo provider) —
 * `/chat/details` do UAZAPI espera `number` como dígitos NUS (confirmado no
 * OpenAPI: exemplo `"5511999999999"`, sem sufixo). LID mantém o `@lid`, mesma
 * convenção de `resolveRecipient` abaixo (o único formato de identidade opaca
 * que `/chat/details` teria como aceitar).
 */
function numeroParaChatDetails(recipient: string): string {
  if (recipient.endsWith("@lid")) return recipient;
  return recipient.replace(/@.*/, "");
}

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

  /**
   * Sempre `true` — e NÃO `!!process.env.UAZAPI_BASE_URL`, que é o que este
   * método fazia antes.
   *
   * Medido em homologação (2026-08-14): TODA mensagem mandada pelo composer
   * numa instância "Gateway próprio" (credencial gravada na SESSÃO, o caminho
   * normal — env é só fallback de instalação única) ficava presa em `queued`
   * com `queued_reason: uazapi_not_configured` para sempre, mesmo com o canal
   * `WORKING` e a mensagem chegando no celular via outro teste. Causa: este
   * método é SÍNCRONO (não pode consultar o banco) e checava só o env, que
   * numa instalação "Gateway próprio" nunca é setado — não é esquecimento, é o
   * desenho: a credencial mora em `channel_sessions`, não em `.env`.
   *
   * Mesma classe de defeito que `../adapters/zernio.ts` já teve e já resolveu
   * (ver o comentário lá) — `send()`, que é async e pode ir ao banco
   * (`resolveUazapiCreds`, sessão primeiro, env como fallback), é quem
   * realmente sabe responder "esta ORG está configurada?". Ele agora LANÇA
   * `uazapi_not_configured` quando não acha credencial nenhuma, e
   * `app/api/v1/messages/_handler.ts` já sabe traduzir isso em `queued` — o
   * mesmo desfecho de hoje, só que depois de perguntar de verdade, não antes.
   */
  isConfigured(): boolean {
    return true;
  },

  codes: {
    notConfigured: "uazapi_not_configured",
    sendFailed: "uazapi_error",
    unknownError: "uazapi_unknown",
  },

  async send(envelope: OutboundEnvelope): Promise<{ externalId: string | null }> {
    const admin = createAdminClient();
    const creds = await resolveUazapiCreds(admin, envelope.sessionRef);
    // LANÇA, não devolve `{externalId: null}` — com `isConfigured` sempre
    // `true`, quem desiste é este ponto. Devolver null silenciosamente faria
    // `_handler.ts` gravar `status:'sent'` sem id, dizendo "enviado" para uma
    // mensagem que nunca saiu (mesmo raciocínio de `../adapters/zernio.ts`).
    if (!creds) {
      throw new Error(
        "uazapi_not_configured: nenhuma credencial para esta sessão (nem gravada, nem no ambiente).",
      );
    }

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
    const details = await uazapiClient.chatDetails(creds, numeroParaChatDetails(input.recipient));
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

  /**
   * Ver `ChannelAdapter.sendTyping` — cosmético, NUNCA lança. Sem credencial
   * ou falha de transporte: engole e volta (`catch` interno), porque quem
   * chama trata "sem indicador" e "indicador falhou" do mesmo jeito, e não
   * existe fallback de negócio para "digitando" não ter saído.
   */
  async sendTyping(input: {
    sessionRef: string;
    to: string;
    presence: "composing" | "recording";
    durationMs?: number;
  }): Promise<void> {
    try {
      const admin = createAdminClient();
      const creds = await resolveUazapiCreds(admin, input.sessionRef);
      if (!creds) return;
      await uazapiClient.sendPresence(creds, input.to, input.presence, input.durationMs);
    } catch {
      // Best-effort de propósito — ver doc do método na interface.
    }
  },
};
