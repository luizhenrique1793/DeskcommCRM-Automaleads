/**
 * GET/POST /api/v1/cron/retry-queued-messages
 *
 * Repesca mensagem outbound de HUMANO (`sent_via='user'`), de INTEGRAÇÃO
 * (`sent_via='system'` — ator `api_token`) ou de AUTOMAÇÃO (`sent_via='automation'`
 * — ator `webhook_source`, ex.: pix-watcher, cron/regra sem IA no caminho —
 * decisão do mantenedor na issue #652, `origemDaMensagem()` em
 * `lib/operacao/autoria.ts`) presa em `queued` porque o canal não estava
 * pronto no instante do envio (`queued_reason: channel_session_not_working`
 * ou `<provider>_not_configured` — `app/api/v1/messages/_handler.ts`).
 *
 * ─── Por que ela fica órfã sem este cron ────────────────────────────────────
 *
 * O comentário de `removerEcoDoProprioEnvio` (`_handler.ts`) já registra que
 * "`queued` é estado de espera com DONO: o agent-engine reagenda o job
 * (`SEND_QUEUED_RETRY_MS`)". Isso é verdade só para mensagem de um TURNO DE
 * AGENTE, que passa pela fila de job (`sent_via='ai'`, ator `ai_agent`). As
 * outras três categorias nunca criam job nenhum, só gravam `status:'queued'`
 * e param. Medido em homologação real (2026-08-14): atendente mandou mensagem
 * 3 minutos antes do canal subir, ficou presa para sempre. Medido AO VIVO em
 * produção (2026-08-18): o `pix-watcher` travou 3 confirmações de pagamento
 * quando o canal caiu no instante do envio, e ficaram presas até este cron
 * passar a olhar a categoria dele também (então `system`; depois do merge com
 * o upstream, 2026-10, `webhook_source` passou a gravar `automation`, e o
 * filtro acompanhou).
 *
 * ─── Por que é SEGURO reenviar (ao contrário de `recover-stuck-messages`) ──
 *
 * `recover-stuck-messages` NUNCA reenvia `sending`, de propósito: o envio
 * pode já ter saído e só o ack não voltou — reenviar arriscaria mandar em
 * dobro. `queued` aqui é o OPOSTO: `adapter.send()` nunca foi chamado — a
 * pre-checagem interceptou ANTES do transporte. Zero chance de já ter saído.
 *
 * ─── Escopo deliberadamente estreito ────────────────────────────────────────
 *
 *   - só `sent_via IN ('user','system','automation')` — mensagem de TURNO DE
 *     AGENTE (`sent_via='ai'`) tem dono próprio (agent-engine);
 *   - só `type != 'template'` — template pede pré-voo de definição aprovada
 *     (`lib/channels/conferir-definicao.ts`), fora de escopo aqui; o operador
 *     já tem uma saída manual (`JanelaFechadaAviso`);
 *   - reusa `getAdapter`/`adapter.send` — o MESMO seam do envio imediato,
 *     nunca um transporte próprio.
 *
 * Auth: mesmo contrato dos demais crons — `autorizaCron()` de
 * `lib/auth/cron-auth.ts`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import {
  CHANNEL_SESSION_REF_COLUMNS,
  DEFAULT_CHANNEL_PROVIDER,
  getAdapter,
  resolveSessionRef,
  type ChannelSessionRef,
} from "@/lib/channels";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import {
  extendBotSilence,
  previewFrom,
  removerEcoDoProprioEnvio,
} from "@/app/api/v1/messages/_handler";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { STATUS_OPERANTE, ehOperante, statusDaOrgEmbutida } from "@/lib/organizacao/operante";

export const dynamic = "force-dynamic";

/** Teto por invocação — a rodada seguinte pega o resto, mesmo padrão dos irmãos. */
const SCAN_LIMIT = 100;

interface QueuedRow {
  id: string;
  organization_id: string;
  conversation_id: string;
  type: string;
  body: string | null;
  media_url: string | null;
  media_mime: string | null;
  media_storage_path: string | null;
  metadata: Record<string, unknown> | null;
  /** Status da org embutido — quem decide é `ehOperante`, não uma lista de ids. */
  organizations: { status: string | null } | { status: string | null }[] | null;
}

interface ConvJoin {
  id: string;
  organization_id: string;
  contact_id: string;
  channel_session_id: string;
  is_group: boolean;
  group_chat_id: string | null;
  bot_silenced_until: string | null;
  provider_conversation_id: string | null;
  contacts: {
    phone_number: string | null;
    wa_identity: string | null;
    wa_lid: string | null;
    is_blocked: boolean;
  } | null;
  channel_sessions: (ChannelSessionRef & { status: string; archived_at?: string | null }) | null;
}

export interface RetryQueuedResult {
  scanned: number;
  sent: number;
  failed: number;
  still_queued: number;
}

const convSelect = (comArchived: boolean) =>
  `id, organization_id, contact_id, channel_session_id, is_group, group_chat_id, bot_silenced_until, provider_conversation_id, contacts:contact_id(phone_number, wa_identity, wa_lid, is_blocked), channel_sessions:channel_session_id(${CHANNEL_SESSION_REF_COLUMNS}, status${comArchived ? `, ${ARCHIVED_AT}` : ""})`;

/**
 * Separado do handler HTTP para o teste poder exercitar a REGRA sem montar
 * request/auth — mesmo padrão de `recover-stuck-messages`.
 */
export async function retryQueuedMessages(
  admin: ReturnType<typeof createAdminClient>,
  now: Date,
  requestId: string,
): Promise<RetryQueuedResult> {
  const { data, error } = await admin
    .from("messages")
    .select(
      "id, organization_id, conversation_id, type, body, media_url, media_mime, media_storage_path, metadata, organizations:organization_id!inner(status)",
    )
    .eq("direction", "outbound")
    .eq("status", "queued")
    .in("sent_via", ["user", "system", "automation"])
    .neq("type", "template")
    // Org parada sai no banco, ANTES do `limit`: filtrar só em memória deixaria
    // a varredura ocupada por mensagem de uma org que não opera mais.
    .eq("organizations.status", STATUS_OPERANTE)
    .order("created_at", { ascending: true })
    .limit(SCAN_LIMIT);

  if (error) throw new Error(`query_failed: ${error.message}`);

  const fila = (data ?? []) as QueuedRow[];
  let enviadas = 0;
  let falhadas = 0;
  let aindaEmFila = 0;

  for (const row of fila) {
    // Org parada não gasta nem fala: o corte já saiu no banco (embed `!inner` +
    // filtro de status, acima); isto é cinto, mesmo padrão de agenda-reminder.
    // Antes do claim: a linha fica intocada em `queued`, sem virar `sending` e
    // voltar — reativação sem rajada, se a org voltar a operar.
    if (!ehOperante(statusDaOrgEmbutida(row.organizations))) continue;

    // CLAIM ATÔMICO — se outra rodada (ou o envio original, corrida rara)
    // já tirou esta linha de `queued`, o UPDATE não casa nada e pulamos: sem
    // isto, duas invocações concorrentes do cron poderiam mandar a mesma
    // mensagem duas vezes.
    const { data: reivindicada } = await admin
      .from("messages")
      .update({ status: "sending" })
      .eq("id", row.id)
      .eq("status", "queued")
      .select("id")
      .maybeSingle();
    if (!reivindicada) continue;

    const nowIso = now.toISOString();
    const { data: conv } = await queryTolerantToMissingArchived(
      () =>
        admin.from("conversations").select(convSelect(true)).eq("id", row.conversation_id).maybeSingle(),
      () =>
        admin.from("conversations").select(convSelect(false)).eq("id", row.conversation_id).maybeSingle(),
    );
    const c = conv as unknown as ConvJoin | null;

    if (!c || c.contacts?.is_blocked) {
      // Contato bloqueado DEPOIS de a mensagem entrar na fila: o envio
      // imediato já barra isto antes de inserir; aqui a linha existe porque
      // o bloqueio veio DEPOIS. `failed`, não `queued` — não vai sair nunca.
      await admin
        .from("messages")
        .update({
          status: "failed",
          error_code: c ? "contact_blocked" : "conversation_not_found",
          error_message: c ? "Contato bloqueou o atendimento." : "Conversa não encontrada.",
        })
        .eq("id", row.id);
      falhadas++;
      continue;
    }

    const adapter = getAdapter(c.channel_sessions?.provider ?? DEFAULT_CHANNEL_PROVIDER);
    const chatId = adapter.resolveRecipient({
      isGroup: c.is_group,
      groupChatId: c.group_chat_id,
      phoneNumber: c.contacts?.phone_number,
      waIdentity: c.contacts?.wa_identity,
      waLid: c.contacts?.wa_lid,
    });

    if (c.channel_sessions?.archived_at) {
      await admin
        .from("messages")
        .update({
          status: "failed",
          error_code: "channel_archived",
          error_message: "Este número foi excluído da Central de Conexões.",
        })
        .eq("id", row.id);
      falhadas++;
      continue;
    }

    if (!chatId) {
      await admin
        .from("messages")
        .update({
          status: "failed",
          error_code: "missing_phone_number",
          error_message: "Contato sem telefone para envio WhatsApp.",
        })
        .eq("id", row.id);
      falhadas++;
      continue;
    }

    if (!adapter.isConfigured() || !c.channel_sessions || c.channel_sessions.status !== "WORKING") {
      // Ainda não dá — devolve pra `queued` (não é falha, é "continua esperando").
      await admin
        .from("messages")
        .update({
          status: "queued",
          metadata: {
            ...(row.metadata ?? {}),
            queued_reason: !adapter.isConfigured()
              ? adapter.codes.notConfigured
              : "channel_session_not_working",
          },
        })
        .eq("id", row.id);
      aindaEmFila++;
      continue;
    }

    try {
      let externalId: string | null;
      if (row.media_storage_path) {
        const { data: signed, error: signErr } = await admin.storage
          .from("whatsapp-media")
          .createSignedUrl(row.media_storage_path, 600);
        if (signErr || !signed?.signedUrl) {
          throw new Error(`storage_sign_failed: ${signErr?.message ?? "no_url"}`);
        }
        const filename = row.media_storage_path.split("/").pop() ?? undefined;
        ({ externalId } = await adapter.send({
          organizationId: row.organization_id,
          sessionRef: resolveSessionRef(c.channel_sessions as ChannelSessionRef),
          to: chatId,
          providerConversationId: c.provider_conversation_id,
          kind: row.type as never,
          media: {
            url: signed.signedUrl,
            mime: row.media_mime ?? "application/octet-stream",
            filename,
            caption: row.body ?? null,
          },
        }));
      } else {
        ({ externalId } = await adapter.send({
          organizationId: row.organization_id,
          sessionRef: resolveSessionRef(c.channel_sessions as ChannelSessionRef),
          to: chatId,
          providerConversationId: c.provider_conversation_id,
          kind: row.type as never,
          body: row.body ?? "",
        }));
      }

      await removerEcoDoProprioEnvio(
        admin,
        row.organization_id,
        c.id,
        row.id,
        externalId,
        externalId ? (adapter.echoExternalIds?.({ externalId, recipient: chatId }) ?? [externalId]) : [],
      );

      await admin
        .from("messages")
        .update({ status: "sent", external_id: externalId, ack: 0 })
        .eq("id", row.id);

      const conversationUpdate: Record<string, unknown> = {
        last_outbound_at: nowIso,
        last_message_at: nowIso,
        last_message_preview: previewFrom({
          body: row.body ?? undefined,
          media_url: row.media_url ?? undefined,
          media_storage_path: row.media_storage_path ?? undefined,
          type: row.type,
        }),
      };
      const silenceUntil = extendBotSilence(c.bot_silenced_until, nowIso);
      if (silenceUntil) conversationUpdate.bot_silenced_until = silenceUntil;
      await admin.from("conversations").update(conversationUpdate).eq("id", c.id);

      await admin
        .rpc("emit_event" as never, {
          p_event_type: "message.sent",
          p_entity_kind: "message",
          p_entity_id: row.id,
          p_payload: { status: "sent", conversation_id: c.id },
          p_metadata: { source: "retry-queued-messages", request_id: requestId },
          p_organization_id: row.organization_id,
        } as never)
        .then(({ error: emitErr }: { error: { message: string } | null }) => {
          if (emitErr) {
            logger.warn("[retry-queued-messages] emit_event falhou", {
              detail: emitErr.message,
              message_id: row.id,
              requestId,
            });
          }
        });

      enviadas++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : adapter.codes.unknownError;
      const code = msg.startsWith("storage_sign_failed") ? "storage_sign_failed" : adapter.codes.sendFailed;
      await admin
        .from("messages")
        .update({ status: "failed", error_code: code, error_message: msg })
        .eq("id", row.id);
      falhadas++;
      logger.warn("[retry-queued-messages] envio falhou", {
        detail: msg,
        message_id: row.id,
        requestId,
      });
    }
  }

  return { scanned: fila.length, sent: enviadas, failed: falhadas, still_queued: aindaEmFila };
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  let result: RetryQueuedResult;
  try {
    result = await retryQueuedMessages(createAdminClient(), new Date(), requestId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[retry-queued-messages] falhou", { error: detail, requestId });
    return fail("internal_error", "Failed to retry queued messages.", 500, { requestId });
  }

  return ok(result, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
