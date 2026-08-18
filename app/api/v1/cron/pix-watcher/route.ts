/**
 * Cron — monitora os PIX de entrada das reservas da Pousada Por do Sol.
 *
 * Substitui o par "Registrar Monitoramento PIX Redis" + "Monitorar Status PIX
 * Reservas FILA TESTE" do fluxo n8n original: em vez de uma fila Redis própria,
 * a "fila" é a própria `crm_leads` — todo card de reserva com
 * `custom_fields.pix_status = 'pending'` é um item pendente de checagem.
 *
 * Roda a cada minuto (ver docker-compose.prod.yml, serviço `scheduler`).
 * Idempotente: rodar de novo sem nada vencido/confirmado não faz nada.
 *
 * Diferença deliberada do fluxo original: o PIX de hospedagem no n8n NUNCA
 * tratava expiração (o de quiosque tratava) — um TTL de 2h estourava em
 * silêncio e a reserva sumia do radar sem avisar o cliente. Aqui a expiração
 * é tratada igual à confirmação: o card vai para "Cancelada" e o hóspede é
 * avisado.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { moveLeadHandler } from "@/app/api/v1/leads/_handler";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { unwrapPmsObject } from "@/lib/pousada/pms-client";
import { loadPousadaSettings, type PousadaSettings } from "@/lib/pousada/settings";
import { executarChamadaPousada } from "@/lib/pousada/executor";

export const dynamic = "force-dynamic";

/** Teto por invocação — a próxima passada (1 min depois) pega o resto. */
const LEAD_LIMIT = 100;

const CRON_ACTOR = { type: "webhook_source" as const, id: "pix-watcher" };

type LeadRow = {
  id: string;
  organization_id: string;
  contact_id: string | null;
  custom_fields: Record<string, unknown> | null;
};

async function enviarMensagem(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
  contactId: string | null,
  texto: string,
  requestId: string,
): Promise<void> {
  if (!contactId) return;
  const { data: conversa } = await admin
    .from("conversations")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  const conversationId = (conversa as { id?: string } | null)?.id;
  if (!conversationId) return;
  try {
    await sendMessageHandler(
      admin,
      { organization_id: organizationId, actor: CRON_ACTOR, requestId },
      { conversation_id: conversationId, type: "text", body: texto },
    );
  } catch (err) {
    logger.error("[pix-watcher] falha ao enviar mensagem de confirmação/expiração", {
      organizationId,
      contactId,
      error: err instanceof Error ? err.message : String(err),
      requestId,
    });
  }
}

async function moverParaEtapa(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
  leadId: string,
  stageSlug: string,
  requestId: string,
): Promise<void> {
  const { data: lead } = await admin.from("crm_leads").select("pipeline_id").eq("id", leadId).maybeSingle();
  const pipelineId = (lead as { pipeline_id?: string } | null)?.pipeline_id;
  if (!pipelineId) return;
  const { data: stage } = await admin
    .from("crm_stages")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("pipeline_id", pipelineId)
    .eq("slug", stageSlug)
    .maybeSingle();
  const stageId = (stage as { id?: string } | null)?.id;
  if (!stageId) {
    logger.error("[pix-watcher] etapa não encontrada", { organizationId, stageSlug, requestId });
    return;
  }
  await moveLeadHandler(admin, { organization_id: organizationId, actor: CRON_ACTOR, requestId }, leadId, {
    to_stage_id: stageId,
    reason: `pix-watcher: ${stageSlug}`,
  });
}

async function processarLead(
  admin: ReturnType<typeof createAdminClient>,
  lead: LeadRow,
  agora: Date,
  requestId: string,
  settings: PousadaSettings,
): Promise<"confirmada" | "expirada" | "pendente" | "erro"> {
  const cf = lead.custom_fields ?? {};
  const reservaId = String(cf.pms_reserva_id ?? "").replace(/\D/g, "");
  if (!reservaId) return "erro";

  const expiraEmRaw = cf.pix_expira_em;
  const expiraEm = typeof expiraEmRaw === "string" ? new Date(expiraEmRaw) : null;
  const expirado = expiraEm !== null && !Number.isNaN(expiraEm.getTime()) && agora > expiraEm;

  // Mesmo endpoint que pousada_consultar_status_reserva (lib/mcp/tools/pousada.ts)
  // — POST com corpo JSON, não GET com query string, e exige o header X-Api-Key
  // configurado na aba Capacidades → Autenticação. Por isso passa por
  // executarChamadaPousada (que lê essa config), não pmsRequest cru: antes desta
  // correção, este watcher chamava o PMS errado a cada minuto, sempre em 404,
  // há dias — NENHUMA confirmação de pagamento por PIX chegou a avisar o
  // hóspede pelo WhatsApp, mesmo reserva paga de verdade (achado ao vivo
  // 2026-08-18, mesma causa raiz do bug já corrigido na tool).
  const raw = await executarChamadaPousada({
    supabase: admin,
    organizationId: lead.organization_id,
    toolName: "pousada_consultar_status_reserva",
    callKey: "default",
    method: "POST",
    path: "/api/Reservas/BuscarStatus",
    baseUrl: settings.pmsBaseUrl,
    body: { IdReserva: Number(reservaId) },
  });
  const status = typeof raw === "string" ? raw : String(unwrapPmsObject(raw).status ?? raw ?? "");
  const confirmada = status.trim().toLowerCase() === "reserva confirmada";

  const novosCampos = { ...cf };

  if (confirmada) {
    novosCampos.pix_status = "confirmed";
    await admin
      .from("crm_leads")
      .update({ custom_fields: novosCampos, updated_at: agora.toISOString() })
      .eq("id", lead.id);
    await moverParaEtapa(admin, lead.organization_id, lead.id, "confirmada", requestId);
    await enviarMensagem(
      admin,
      lead.organization_id,
      lead.contact_id,
      `Recebemos a confirmação do seu pagamento! ✅ Sua reserva #${reservaId} está confirmada. Qualquer dúvida, é só chamar.`,
      requestId,
    );
    return "confirmada";
  }

  if (expirado) {
    novosCampos.pix_status = "expired";
    await admin
      .from("crm_leads")
      .update({ custom_fields: novosCampos, updated_at: agora.toISOString() })
      .eq("id", lead.id);
    await moverParaEtapa(admin, lead.organization_id, lead.id, "cancelada", requestId);
    await enviarMensagem(
      admin,
      lead.organization_id,
      lead.contact_id,
      `O código PIX da sua reserva #${reservaId} expirou sem confirmação de pagamento. Se ainda quiser se hospedar com a gente, é só me chamar que eu gero um novo código. 🌞`,
      requestId,
    );
    return "expirada";
  }

  return "pendente";
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  const agora = new Date();

  const { data: rows, error } = await admin
    .from("crm_leads")
    .select("id, organization_id, contact_id, custom_fields")
    .eq("custom_fields->>pix_status", "pending")
    .limit(LEAD_LIMIT);

  if (error) {
    logger.error("[pix-watcher] query falhou", { error: error.message, requestId });
    return fail("internal_error", "Failed to list pending PIX charges.", 500, { requestId });
  }

  const leads = (rows ?? []) as LeadRow[];
  let confirmadas = 0;
  let expiradas = 0;
  let erros = 0;

  // Cache por organização dentro do lote — leads da mesma org (o caso comum)
  // não repetem a consulta de settings a cada item.
  const settingsPorOrg = new Map<string, PousadaSettings>();

  for (const lead of leads) {
    try {
      let settings = settingsPorOrg.get(lead.organization_id);
      if (!settings) {
        settings = await loadPousadaSettings(admin, lead.organization_id);
        settingsPorOrg.set(lead.organization_id, settings);
      }
      const resultado = await processarLead(admin, lead, agora, requestId, settings);
      if (resultado === "confirmada") confirmadas++;
      else if (resultado === "expirada") expiradas++;
      else if (resultado === "erro") erros++;
    } catch (e) {
      // Um lead com PMS fora do ar não pode travar os outros — mesma
      // disciplina de isolamento por item dos demais watchers do cron.
      erros++;
      logger.error("[pix-watcher] lead falhou", {
        leadId: lead.id,
        organizationId: lead.organization_id,
        error: e instanceof Error ? e.message : String(e),
        requestId,
      });
    }
  }

  return ok(
    {
      scanned: leads.length,
      confirmed: confirmadas,
      expired: expiradas,
      errors: erros,
    },
    { requestId },
  );
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
