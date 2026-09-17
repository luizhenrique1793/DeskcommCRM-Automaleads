/**
 * Épico Operação Visível (F1) — central de avisos do agente.
 * GET → agent_inbox_items da org (default: abertos), mais recente primeiro,
 * paginado por cursor opaco (created_at+id, mesma convenção de
 * app/api/v1/ai/agents/[id]/runs/route.ts).
 * PATCH → resolve/reabre EM MASSA (até 200 ids de uma vez) — sem isto, uma
 * central com mais de uma tela de avisos só dava pra resolver um por um.
 * Itens de plataforma (organization_id null) são do operador do sistema, não
 * do tenant — nunca entram aqui.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { resolverDestinosDosAvisos } from "@/lib/ai/inbox-destino";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  status: z.enum(["open", "ack", "resolved", "all"]).default("open"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

interface CursorPayload {
  created_at: string;
  id: string;
}

function encodeCursor(p: CursorPayload): string {
  return Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
}

function decodeCursor(raw: string): CursorPayload | null {
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const p = JSON.parse(json) as CursorPayload;
    if (typeof p.id !== "string" || typeof p.created_at !== "string") return null;
    return p;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "agent_inbox_items" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org } = authz;

  const parsed = querySchema.safeParse(
    Object.fromEntries(new URL(req.url).searchParams.entries()),
  );
  if (!parsed.success) {
    return fail("validation_failed", t("Query inválida."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const { status, limit, cursor } = parsed.data;

  const admin = createAdminClient();
  let query = admin
    .from("agent_inbox_items")
    .select("id, kind, severity, title, body, ref_kind, ref_id, status, created_at")
    .eq("organization_id", org.orgId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);
  if (status !== "all") {
    query = query.eq("status", status);
  }
  if (cursor) {
    const c = decodeCursor(cursor);
    if (!c) return fail("invalid_request", "cursor inválido.", 400, { requestId });
    // Tuple-aware seek: created_at < c.created_at OR (=, id < c.id).
    query = query.or(
      `created_at.lt.${c.created_at},and(created_at.eq.${c.created_at},id.lt.${c.id})`,
    );
  }
  const { data, error } = await query;
  if (error) {
    return fail("internal_error", t("Falha ao carregar os avisos."), 500, { requestId });
  }

  const rows = data ?? [];
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor({ created_at: last.created_at, id: last.id }) : null;

  const { count: openCount } = await admin
    .from("agent_inbox_items")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", org.orgId)
    .eq("status", "open");

  const itemsComDestino = await resolverDestinosDosAvisos(
    await createClient(),
    org.orgId,
    org.role,
    items,
  );
  return ok(
    { items: itemsComDestino, open_count: openCount ?? 0 },
    { requestId, meta: { cursor: nextCursor, has_more: hasMore } },
  );
}

const bulkPatchSchema = z
  .object({
    ids: z.array(z.string().uuid()).min(1).max(200),
    status: z.enum(["open", "ack", "resolved"]),
  })
  .strict();

export async function PATCH(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "agent_inbox_items" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org } = authz;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }
  const parsed = bulkPatchSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("agent_inbox_items")
    .update({ status: parsed.data.status })
    .eq("organization_id", org.orgId)
    .in("id", parsed.data.ids)
    .select("id");
  if (error) {
    return fail("internal_error", "Falha ao atualizar os avisos.", 500, { requestId });
  }

  const updatedIds = (data ?? []).map((r) => r.id as string);

  // Auditoria em UMA entrada pra ação em massa (não uma por linha) — é uma
  // mutação só, e N entradas idênticas no audit log não ajudam ninguém a
  // investigar depois; a lista de ids fica no metadata.
  await audit({
    action: "ai.inbox_items_bulk_status_changed",
    actorUserId: authUser.id,
    organizationId: org.orgId,
    resourceType: "agent_inbox_items",
    resourceId: null,
    requestId,
    metadata: { status: parsed.data.status, ids: updatedIds, count: updatedIds.length },
  });

  return ok({ updated: updatedIds.length, ids: updatedIds }, { requestId });
}
