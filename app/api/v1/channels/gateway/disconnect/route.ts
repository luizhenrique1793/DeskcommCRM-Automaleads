/**
 * POST /api/v1/channels/gateway/disconnect — encerra a sessão do WhatsApp
 * SEM apagar a conexão. Para excluir de vez, a rota genérica de sessão
 * (`/api/v1/channel-sessions/[id]`) já arquiva qualquer provider.
 */
import { randomUUID } from "node:crypto";
import type { NextResponse } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { disconnectGateway, findGatewaySession } from "@/lib/channels/gateway";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(): Promise<NextResponse> {
  const requestId = randomUUID();
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org || ROLE_RANK[org.role] < ROLE_RANK.admin) {
    return fail("forbidden", "admin_required", 403, { requestId });
  }

  const admin = createAdminClient();
  const sessao = await findGatewaySession(admin, org.orgId);
  if (!sessao?.instanceId || sessao.archivedAt) {
    return fail("not_found", "nenhuma conexão para desconectar", 404, { requestId });
  }

  const desconectou = await disconnectGateway(admin, sessao.instanceId);
  if (!desconectou) {
    return fail("invalid_request", "sem credencial gravada para esta conexão", 422, { requestId });
  }
  await admin
    .from("channel_sessions")
    .update({ status: "disconnected" })
    .eq("id", sessao.id);

  return ok({ disconnected: true }, { requestId });
}
