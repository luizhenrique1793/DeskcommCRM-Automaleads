/**
 * GET  /api/v1/channels/gateway — estado da conexão, incluindo QR/pairing ao vivo.
 * POST /api/v1/channels/gateway — valida a credencial, grava, registra o
 *                                  webhook e inicia a conexão (QR ou pairing code).
 *
 * Mesmo padrão de `../partner/route.ts`: o caminho e o corpo desta rota não
 * citam o provider — quem sabe é `lib/channels/gateway`.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import {
  findGatewaySession,
  GATEWAY_CHANNEL_LABEL,
  getGatewayLiveStatus,
  registerGatewayWebhook,
  saveGatewaySession,
  startGatewayConnection,
  validateGatewayCredentials,
} from "@/lib/channels/gateway";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const conectarSchema = z.object({
  base_url: z.string().trim().min(1).max(500),
  instance_id: z.string().trim().min(1).max(200),
  token: z.string().trim().min(8).max(500),
  /** Presente = pede pairing code; ausente = pede QR. */
  phone: z.string().trim().min(8).max(20).optional(),
});

type Gate = { ok: true; orgId: string } | { ok: false; resposta: NextResponse };

async function adminGate(requestId: string): Promise<Gate> {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  // Conectar um canal expõe a conta do WhatsApp da empresa: decisão de dono.
  if (!org || ROLE_RANK[org.role] < ROLE_RANK.admin) {
    return { ok: false, resposta: fail("forbidden", "admin_required", 403, { requestId }) };
  }
  return { ok: true, orgId: org.orgId };
}

/** Mesmo cálculo de `../partner/route.ts` — ver o comentário lá para o porquê. */
function urlDoWebhook(req: NextRequest, token: string): string {
  const configurada = env.NEXT_PUBLIC_APP_URL;
  const usavel = configurada && !configurada.includes("placeholder.invalid") ? configurada : null;
  const base = (
    usavel ??
    req.headers.get("origin") ??
    `${req.nextUrl.protocol}//${req.nextUrl.host}`
  ).replace(/\/+$/, "");
  return `${base}/api/v1/webhooks/channel/${token}`;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const g = await adminGate(requestId);
  if (!g.ok) return g.resposta;

  const admin = createAdminClient();
  const sessao = await findGatewaySession(admin, g.orgId);
  const conectado = !!sessao && !sessao.archivedAt;

  if (!conectado || !sessao?.instanceId || !sessao.baseUrl) {
    return ok(
      { label: GATEWAY_CHANNEL_LABEL, connected: false, status: null, qrcode: null, paircode: null },
      { requestId },
    );
  }

  // Ao vivo, não o que a última escrita gravou: é o QR/pairing atual, e o
  // ponto inteiro de expor este GET é o operador poder ficar olhando ele mudar.
  const live = await getGatewayLiveStatus(admin, sessao.instanceId);

  return ok(
    {
      label: GATEWAY_CHANNEL_LABEL,
      connected: true,
      phone_number: sessao.phoneNumber,
      display_name: sessao.displayName,
      status: live?.status ?? sessao.status,
      qrcode: live?.qrcode ?? null,
      paircode: live?.paircode ?? null,
      webhook_url: sessao.webhookPathToken ? urlDoWebhook(req, sessao.webhookPathToken) : null,
      // NÃO são segredo — só o token é (esse fica cifrado e nunca é
      // devolvido). Sem isto o formulário de reconexão nascia vazio: quem
      // precisasse reconectar (token expirado/rotacionado do lado do
      // provedor, visto em homologação) tinha de redigitar URL e id da
      // instância do zero, não só colar o token novo.
      base_url: sessao.baseUrl,
      instance_id: sessao.instanceId,
    },
    { requestId },
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const g = await adminGate(requestId);
  if (!g.ok) return g.resposta;

  const parsed = conectarSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_request", "URL do servidor, id da instância e token são obrigatórios", 422, {
      requestId,
    });
  }

  const v = await validateGatewayCredentials({
    baseUrl: parsed.data.base_url,
    instanceId: parsed.data.instance_id,
    token: parsed.data.token,
  });
  if (!v.ok) return fail("invalid_request", v.reason, 422, { requestId });

  // O AUTORITATIVO é o que a própria API devolveu (`v.instanceId`), não o que
  // o operador digitou — é este valor que chega de volta no campo `instance`
  // do webhook, e o cruzamento de instância em `lib/channels/inbound.ts`
  // compara contra ELE. Cair no que foi digitado é só rede de segurança para
  // a resposta não trazer `id` (não deveria acontecer, mas não é motivo para
  // recusar a conexão).
  const instanceId = v.instanceId ?? parsed.data.instance_id;

  const admin = createAdminClient();
  const tokenCifrado = await encryptWebhookSecret(admin, parsed.data.token);
  const segredoWebhook = randomBytes(32).toString("hex");
  const segredoCifrado = await encryptWebhookSecret(admin, segredoWebhook);
  if (!tokenCifrado || !segredoCifrado) {
    return fail(
      "invalid_request",
      "cifra indisponível nesta instalação — o token não foi gravado",
      422,
      { requestId },
    );
  }

  const existente = await findGatewaySession(admin, g.orgId);
  const webhookToken = existente?.webhookPathToken ?? randomBytes(16).toString("hex");

  const { error } = await saveGatewaySession(admin, {
    organizationId: g.orgId,
    existingId: existente?.id ?? null,
    instanceId,
    baseUrl: parsed.data.base_url.replace(/\/+$/, ""),
    tokenEncrypted: tokenCifrado,
    webhookPathToken: webhookToken,
    webhookSecretEncrypted: segredoCifrado,
    phoneNumber: null,
    displayName: v.profileName ?? GATEWAY_CHANNEL_LABEL,
  });
  if (error) return fail("internal_error", error, 500, { requestId });

  // Registra o webhook e inicia a conexão. Best-effort: se o registro falhar,
  // a sessão já está gravada e o operador vê "conectado" com o aviso de
  // conexão caída assim que o vigia rodar — melhor que perder o token colado.
  // Resolve pelo instance_id GRAVADO (não pelo token ainda em memória): o
  // seam decide como buscar a credencial, a rota não monta o objeto sozinha.
  const webhookUrl = urlDoWebhook(req, webhookToken);
  const webhookOk = await registerGatewayWebhook(admin, instanceId, webhookUrl);
  await startGatewayConnection(admin, instanceId, parsed.data.phone ?? null);

  return ok(
    {
      connected: true,
      display_name: v.profileName ?? GATEWAY_CHANNEL_LABEL,
      webhook_registered: webhookOk,
    },
    { requestId },
  );
}
