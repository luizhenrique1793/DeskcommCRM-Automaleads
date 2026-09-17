/**
 * GET /api/v1/ai/capability-http-configs?tool_name=X (manager+)
 * PUT /api/v1/ai/capability-http-configs (admin+)
 *
 * Configuração técnica (método/URL/headers/timeout/auth/corpo) das chamadas
 * HTTP que uma capacidade da pousada faz ao PMS — migration 0149. É POR
 * ORGANIZAÇÃO, compartilhada por todos os agentes que usam a mesma tool
 * (mesmo PMS por trás), não por agente — o liga/desliga por agente continua
 * em `ai_agent_versions.tool_ids` (ToolPicker), sem relação com esta rota.
 *
 * PUT exige `admin` (não `manager`) porque a mudança vale pra toda a
 * organização — mesma régua que `updatePousadaSettings` já usava.
 *
 * Segredo de autenticação: `auth_secret` (plaintext, write-only) é cifrado
 * com `encryptWebhookSecret` (mesma infra de `lib/webhooks/secrets.ts`,
 * migration 0041) antes de gravar em `auth_secret_enc` — o GET nunca devolve
 * o plaintext, só `auth_secret_last4`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { putCapabilityCallsSchema } from "@/lib/schemas/mcp-http-capability";
import { toolsComChamadaHttp, chamadasDaTool } from "@/lib/pousada/http-capability-calls";

export const dynamic = "force-dynamic";

interface CapabilityCallRowWire {
  tool_name: string;
  call_key: string;
  call_label: string;
  call_order: number;
  enabled: boolean;
  method: string | null;
  base_url: string | null;
  endpoint_path: string | null;
  headers: unknown;
  query_params: unknown;
  path_params: unknown;
  body_type: string;
  legacy_body_overrides: unknown;
  body_field_map: unknown;
  response_field_map: unknown;
  timeout_ms: number | null;
  verify_tls: boolean | null;
  auth_type: string;
  auth_key_name: string | null;
  auth_secret_last4: string | null;
  specific_config: unknown;
}

function linhaVazia(
  toolName: string,
  descritor: { callKey: string; callLabel: string; callOrder: number },
): CapabilityCallRowWire {
  return {
    tool_name: toolName,
    call_key: descritor.callKey,
    call_label: descritor.callLabel,
    call_order: descritor.callOrder,
    enabled: false,
    method: null,
    base_url: null,
    endpoint_path: null,
    headers: [],
    query_params: [],
    path_params: [],
    body_type: "json",
    legacy_body_overrides: {},
    body_field_map: [],
    response_field_map: [],
    timeout_ms: null,
    verify_tls: null,
    auth_type: "none",
    auth_key_name: null,
    auth_secret_last4: null,
    specific_config: {},
  };
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "mcp_http_capability_calls" });
  if (!authz.ok) return authz.response;

  const toolName = req.nextUrl.searchParams.get("tool_name");
  if (!toolName || !toolsComChamadaHttp().includes(toolName)) {
    return fail("invalid_request", "tool_name inválido ou sem chamada HTTP configurável.", 400, {
      requestId,
    });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("mcp_http_capability_calls_safe")
    .select("*")
    .eq("tool_name", toolName)
    .order("call_order", { ascending: true });
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const existentes = new Map(
    ((data ?? []) as unknown as CapabilityCallRowWire[]).map((r) => [r.call_key, r]),
  );
  const descritores = chamadasDaTool(toolName);
  const calls = descritores.map((d) => existentes.get(d.callKey) ?? linhaVazia(toolName, d));

  return ok({ tool_name: toolName, calls }, { requestId });
}

export async function PUT(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "mcp_http_capability_calls" });
  if (!authz.ok) return authz.response;
  const { user, org: activeOrg } = authz;

  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = putCapabilityCallsSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("invalid_request", "Dados inválidos.", 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const { tool_name: toolName, calls } = parsed.data;
  if (!toolsComChamadaHttp().includes(toolName)) {
    return fail("invalid_request", "tool_name inválido ou sem chamada HTTP configurável.", 400, {
      requestId,
    });
  }
  const descritoresPorChave = new Map(chamadasDaTool(toolName).map((d) => [d.callKey, d]));
  for (const call of calls) {
    if (!descritoresPorChave.has(call.call_key)) {
      return fail(
        "invalid_request",
        `call_key desconhecido para ${toolName}: ${call.call_key}`,
        400,
        {
          requestId,
        },
      );
    }
  }

  const admin = createAdminClient();
  const supabase = await createClient();

  const rows: Record<string, unknown>[] = [];
  for (const call of calls) {
    const descritor = descritoresPorChave.get(call.call_key)!;

    // undefined = não mexe no segredo já salvo (round-trip sem reenviar).
    let authSecretEnc: string | null | undefined;
    let authSecretLast4: string | null | undefined;
    if (call.auth_secret_clear) {
      authSecretEnc = null;
      authSecretLast4 = null;
    } else if (call.auth_secret) {
      const enc = await encryptWebhookSecret(admin, call.auth_secret);
      if (enc === null) {
        return fail(
          "encryption_unavailable",
          "Não foi possível guardar a credencial com segurança. Configure a chave de cifra e tente de novo — ou deixe sem autenticação.",
          422,
          { requestId },
        );
      }
      authSecretEnc = enc;
      authSecretLast4 = call.auth_secret.slice(-4);
    }

    const row: Record<string, unknown> = {
      organization_id: activeOrg.orgId,
      tool_name: toolName,
      call_key: call.call_key,
      call_label: call.call_label?.trim() || descritor.callLabel,
      call_order: descritor.callOrder,
      enabled: call.enabled,
      method: call.method ?? null,
      base_url: call.base_url || null,
      endpoint_path: call.endpoint_path || null,
      headers: call.headers,
      query_params: call.query_params,
      path_params: call.path_params,
      body_type: call.body_type,
      legacy_body_overrides: call.legacy_body_overrides,
      body_field_map: call.body_field_map,
      response_field_map: call.response_field_map,
      timeout_ms: call.timeout_ms ?? null,
      verify_tls: call.verify_tls ?? null,
      auth_type: call.auth_type,
      auth_key_name: call.auth_key_name || null,
      specific_config: call.specific_config,
      created_by: user.id,
    };
    if (authSecretEnc !== undefined) {
      row.auth_secret_enc = authSecretEnc;
      row.auth_secret_last4 = authSecretLast4;
    }
    rows.push(row);
  }

  const { error } = await supabase
    .from("mcp_http_capability_calls")
    .upsert(rows, { onConflict: "organization_id,tool_name,call_key" });
  if (error) return fail("internal_error", error.message, 500, { requestId });

  void audit({
    action: "mcp.http_capability_updated",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "mcp_http_capability_calls",
    // api_audit_log.resource_id é uuid; toolName é texto (ex.:
    // "pousada_consultar_status_reserva") e o INSERT falhava com 22P02
    // (medido em produção — "invalid input syntax for type uuid"), calado
    // porque audit() é fire-and-forget. O tool_name já vai no metadata.
    resourceId: null,
    requestId,
    metadata: { tool_name: toolName, call_keys: calls.map((c) => c.call_key) },
  });

  return ok({ tool_name: toolName, saved: calls.length }, { requestId });
}
