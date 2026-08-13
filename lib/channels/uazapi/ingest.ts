/**
 * Ingestão do UAZAPI: webhook → contato, conversa, mensagem.
 *
 * Mesmo desenho de `../zernio/ingest.ts`, sem a parte de THREAD: este canal
 * endereça por telefone/JID (como o canal por QR), então não há
 * `provider_conversation_id` a gravar — a identidade (`wa_identity`) já é a
 * prova suficiente, e as mesmas RPCs (`fn_upsert_wa_contact`,
 * `fn_upsert_wa_conversation`, `fn_mark_conversation_message`) resolvem a
 * corrida entre webhooks concorrentes.
 *
 * Idempotência: `unique (organization_id, external_id)` em `messages`, com
 * captura do `23505` — reentrega vira `duplicate`, nunca linha nova.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

import { aplicarEfeitosPosEntrada } from "../pos-entrada";

import type { UazapiInboundMessage } from "./webhook";

export interface UazapiIngestResult {
  status: "ingested" | "duplicate" | "ignored";
  conversationId?: string;
  messageId?: string;
  reason?: string;
}

export async function ingestUazapiInbound(
  admin: SupabaseClient,
  input: { organizationId: string; channelSessionId: string; msg: UazapiInboundMessage },
): Promise<UazapiIngestResult> {
  const { msg } = input;

  if (msg.kind === "status") {
    const { data } = await admin
      .from("messages")
      .update({
        status: msg.status,
        ...(msg.errorReason ? { error_message: msg.errorReason, error_code: "uazapi_error" } : {}),
      })
      .eq("organization_id", input.organizationId)
      .eq("external_id", msg.externalId)
      .not("status", "in", "(read)") // não rebaixa um tique já lido
      .select("id");
    return (data ?? []).length > 0
      ? { status: "ingested", reason: `status_${msg.status}` }
      : { status: "ignored", reason: "mensagem_desconhecida" };
  }

  // `msg.direction === "outbound"` chega aqui como eco do nosso próprio envio
  // (ou de outro dispositivo logado na mesma instância): grava do jeito que o
  // resto do sistema já espera — `external_device`, para as métricas de
  // fricção contarem certo — e a unicidade de `external_id` faz o eco do
  // NOSSO envio virar `duplicate` sem duplicar nada.

  // `parseUazapiMessage` já recusa payload sem âncora (ver ../webhook.ts) —
  // chegando aqui, a identidade sempre existe.
  const identity = waIdentityFrom(msg);
  if (!identity) return { status: "ignored", reason: "sem_identidade_utilizavel" };

  const contactId = await upsertContact(admin, input.organizationId, msg, identity);
  if (!contactId) return { status: "ignored", reason: "contato_nao_resolvido" };

  const { data: conversationId, error: convError } = await admin.rpc("fn_upsert_wa_conversation", {
    p_org: input.organizationId,
    p_contact: contactId,
    p_session: input.channelSessionId,
  });
  if (convError || !conversationId) {
    return { status: "ignored", reason: "conversa_nao_resolvida" };
  }

  const inserted = await insertMessage(admin, {
    organizationId: input.organizationId,
    conversationId: conversationId as string,
    contactId,
    channelSessionId: input.channelSessionId,
    msg,
  });
  if (inserted === "duplicate") return { status: "duplicate", conversationId: conversationId as string };

  await marcarConversa(admin, conversationId as string, msg);
  // `mediaType`, não `fileUrl`: o download é por id de mensagem (ver
  // `insertMessage`), então pede persistência mesmo quando o webhook não
  // trouxe `fileURL` — o id sozinho já basta para `/message/download`.
  if (msg.mediaType) {
    await pedirPersistenciaDaMidia(admin, input.organizationId, conversationId as string, inserted);
  }
  if (msg.direction === "inbound") {
    await aplicarEfeitosPosEntrada(admin, {
      organizationId: input.organizationId,
      contactId,
      conversationId: conversationId as string,
      messageId: inserted,
      channelSessionId: input.channelSessionId,
      texto: msg.text,
      nomeDoContato: msg.identity.displayName,
      origem: "uazapi_webhook",
    });
  }

  return { status: "ingested", conversationId: conversationId as string, messageId: inserted };
}

/** `phone:+E164` | `lid:<digitos>` — mesmo vocabulário do resto do sistema. */
function waIdentityFrom(msg: UazapiInboundMessage): string | null {
  const a = msg.identity.anchor;
  if (!a) return null;
  return a.kind === "phone" ? `phone:${a.value}` : `lid:${a.value}`;
}

async function upsertContact(
  admin: SupabaseClient,
  organizationId: string,
  msg: UazapiInboundMessage,
  identity: string,
): Promise<string | null> {
  const kind = identity.startsWith("phone:") ? "phone" : "lid";
  const valor = identity.slice(identity.indexOf(":") + 1);

  const { data, error } = await admin.rpc("fn_upsert_wa_contact", {
    p_org: organizationId,
    p_kind: kind,
    p_phone: kind === "phone" ? valor : null,
    p_lid: kind === "lid" ? valor : null,
    p_chat_id: msg.chatId,
    p_notify: msg.identity.displayName,
  });
  if (error) return null;
  const contactId = (data as string) ?? null;
  if (!contactId) return null;

  // Telefone conhecido MESMO quando a âncora é o LID — o requisito de "não
  // perder o telefone ao receber identidade LID". `is null`: só preenche o
  // que está vazio, nunca sobrescreve uma correção feita à mão na tela.
  if (msg.identity.phone) {
    await admin
      .from("contacts")
      .update({ phone_number: msg.identity.phone })
      .eq("id", contactId)
      .is("phone_number", null);
  }

  return contactId;
}

async function insertMessage(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    conversationId: string;
    contactId: string;
    channelSessionId: string;
    msg: UazapiInboundMessage;
  },
): Promise<string | "duplicate"> {
  const { msg } = input;
  const { data, error } = await admin
    .from("messages")
    .insert({
      organization_id: input.organizationId,
      conversation_id: input.conversationId,
      contact_id: input.contactId,
      channel_session_id: input.channelSessionId,
      external_id: msg.externalId,
      direction: msg.direction,
      sent_via: "external_device",
      status: msg.direction === "outbound" ? "sent" : "delivered",
      type: msg.mediaType ? tipoDeMidia(msg.mediaType) : "text",
      body: msg.text,
      // `media_url` carrega o `externalId` (messageid), NÃO o `fileURL` do
      // webhook: `fetchInboundMedia` baixa por id via `/message/download`
      // (base64 no mesmo pedido, ver `../adapters/uazapi.ts`), nunca por URL.
      // `fileURL`, quando o payload o trouxe, fica só em `metadata` — é
      // referência para depurar, não o que o worker usa para baixar.
      ...(msg.mediaType ? { media_url: msg.externalId, media_mime: mimeHintDeMidia(msg.mediaType) } : {}),
      ...(msg.fileUrl ? { metadata: { uazapi_file_url: msg.fileUrl } } : {}),
      ...(msg.sentAt ? { sent_at: msg.sentAt } : {}),
    })
    .select("id")
    .maybeSingle();

  if (error?.code === "23505") return "duplicate";
  if (error || !data) throw new Error(`uazapi_ingest_insert_failed: ${error?.message ?? "sem id"}`);
  return (data as { id: string }).id;
}

/** `messageType` do UAZAPI → vocabulário de `messages.type`. */
function tipoDeMidia(messageType: string): string {
  switch (messageType) {
    case "image":
      return "image";
    case "video":
    case "videoplay":
    case "ptv":
      return "video";
    case "audio":
    case "myaudio":
    case "ptt":
      return "audio";
    case "sticker":
      return "sticker";
    default:
      return "document";
  }
}

/**
 * DICA de mime a partir do `messageType`, não verdade — quem manda é o
 * `mimetype` que `/message/download` devolve quando o worker baixa de fato.
 * Serve para a tela ter o que mostrar antes dos bytes chegarem.
 */
function mimeHintDeMidia(messageType: string): string | null {
  switch (messageType) {
    case "image":
      return "image/jpeg";
    case "video":
    case "videoplay":
    case "ptv":
      return "video/mp4";
    case "audio":
    case "myaudio":
    case "ptt":
      return "audio/ogg";
    default:
      return null;
  }
}

async function marcarConversa(
  admin: SupabaseClient,
  conversationId: string,
  msg: UazapiInboundMessage,
): Promise<void> {
  const { error } = await admin.rpc("fn_mark_conversation_message" as never, {
    p_conv: conversationId,
    p_direction: msg.direction,
    p_preview: (msg.text ?? "").slice(0, 200),
    p_at: msg.sentAt ?? new Date().toISOString(),
  } as never);
  if (error) {
    logger.warn("[uazapi] carimbo da conversa falhou", { conversationId, detail: error.message });
  }
}

async function pedirPersistenciaDaMidia(
  admin: SupabaseClient,
  organizationId: string,
  conversationId: string,
  messageId: string,
): Promise<void> {
  const { error } = await admin.rpc("emit_event" as never, {
    p_event_type: "media.persist_requested",
    p_entity_kind: "message",
    p_entity_id: messageId,
    p_payload: { message_id: messageId, conversation_id: conversationId },
    p_metadata: { source: "uazapi_webhook" },
    p_organization_id: organizationId,
  } as never);
  if (error) {
    logger.warn("[uazapi] emit media.persist_requested falhou", { messageId, detail: error.message });
  }
}
