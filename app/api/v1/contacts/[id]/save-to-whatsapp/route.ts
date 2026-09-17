/**
 * POST /api/v1/contacts/[id]/save-to-whatsapp
 *
 * Salva o lead na AGENDA do WhatsApp do canal indicado — não no CRM (o
 * contato já existe aqui). Primeira versão: botão manual, um contato por vez.
 * NÃO existe salvamento automático — decisão explícita do escopo inicial.
 *
 * A rota não pergunta QUAL provider é: pede o adapter da sessão e testa se
 * ele SUPORTA a operação (`capabilitiesOf(provider).canSaveContact` +
 * `!!adapter.saveContact`), fail-closed quando não suporta. É o mesmo padrão
 * dos outros métodos opcionais de `ChannelAdapter` — nunca uma comparação
 * direta contra o nome de um provider específico.
 *
 * Auth: cookie session, role >= agent (mesma régua das ações do inbox).
 * Audit: `contact.saved_to_whatsapp`, fire-and-forget.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { capabilitiesOf, getAdapter, resolveSessionRef } from "@/lib/channels";
import { CHANNEL_SESSION_REF_COLUMNS } from "@/lib/channels/session-ref";
import type { ChannelSessionRef } from "@/lib/channels/session-ref";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({ channel_session_id: z.string().uuid() });

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: contactId } = await ctx.params;

  const authz = await requireRole("agent", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_request", "channel_session_id é obrigatório", 422, { requestId });
  }

  // Admin client + filtro EXPLÍCITO de organization_id nas duas leituras
  // abaixo: doutrina de service role em handler (CLAUDE.md).
  const admin = createAdminClient();

  const { data: contact } = await admin
    .from("contacts")
    .select("id, display_name, name, phone_number")
    .eq("id", contactId)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (!contact) return fail("not_found", "Contato não encontrado.", 404, { requestId });
  if (!contact.phone_number) {
    return fail("invalid_request", "Este contato não tem telefone conhecido.", 422, { requestId });
  }

  const { data: session } = await admin
    .from("channel_sessions")
    .select(CHANNEL_SESSION_REF_COLUMNS)
    .eq("id", parsed.data.channel_session_id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (!session) return fail("not_found", "Canal não encontrado nesta organização.", 404, { requestId });

  const provider = session.provider as Parameters<typeof getAdapter>[0];
  // Fail-closed: provider fora da matriz (ou linha corrompida) lança dentro
  // de `getAdapter`/`capabilitiesOf` — não cai num provider default.
  let caps: ReturnType<typeof capabilitiesOf>;
  let adapter: ReturnType<typeof getAdapter>;
  try {
    caps = capabilitiesOf(provider);
    adapter = getAdapter(provider);
  } catch {
    return fail("invalid_request", "Canal com provider desconhecido.", 422, { requestId });
  }

  if (!caps.canSaveContact || !adapter.saveContact) {
    return fail(
      "invalid_request",
      "Este canal não suporta salvar contato na agenda do WhatsApp.",
      422,
      { requestId },
    );
  }

  const nome = nomeDoContato(contact);
  if (!nome) {
    return fail("invalid_request", "Este contato não tem nome para salvar na agenda.", 422, {
      requestId,
    });
  }

  const resultado = await adapter.saveContact({
    organizationId: activeOrg.orgId,
    sessionRef: resolveSessionRef(session as unknown as ChannelSessionRef),
    phoneNumber: contact.phone_number,
    name: nome,
  });

  // Fire-and-forget: falha de audit nunca bloqueia a resposta principal
  // (doutrina de audit log do CLAUDE.md).
  void audit({
    action: "contact.saved_to_whatsapp",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "contact",
    resourceId: contactId,
    requestId,
    metadata: { channel_session_id: parsed.data.channel_session_id, ok: resultado.ok },
  });

  if (!resultado.ok) {
    return fail("invalid_request", resultado.reason, 422, { requestId });
  }
  return ok({ saved: true }, { requestId });
}
