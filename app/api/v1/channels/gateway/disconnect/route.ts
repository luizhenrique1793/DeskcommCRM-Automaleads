/**
 * POST /api/v1/channels/gateway/disconnect — encerra a sessão do WhatsApp
 * SEM apagar a conexão. Para excluir de vez, a rota genérica de sessão
 * (`/api/v1/channel-sessions/[id]`) já arquiva qualquer provider.
 */
import { randomUUID } from "node:crypto";
import type { NextResponse } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { disconnectGateway, findGatewaySession } from "@/lib/channels/gateway";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_gateway" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;

  const admin = createAdminClient();
  const sessao = await findGatewaySession(admin, orgId);
  if (!sessao?.instanceId || sessao.archivedAt) {
    return fail("not_found", "nenhuma conexão para desconectar", 404, { requestId });
  }

  // `disconnectGateway` grava o status CANÔNICO por dentro do seam — a rota
  // não escolhe a palavra (ver o comentário da função em `lib/channels/gateway.ts`).
  const desconectou = await disconnectGateway(admin, orgId, sessao.instanceId, sessao.id);
  if (!desconectou) {
    return fail("invalid_request", "sem credencial gravada para esta conexão", 422, { requestId });
  }

  return ok({ disconnected: true }, { requestId });
}
