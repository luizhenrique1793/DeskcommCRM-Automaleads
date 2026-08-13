/**
 * Leitura server-only da configuração técnica de uma chamada HTTP
 * (mcp_http_capability_calls, migration 0149) — inclui o segredo cifrado,
 * por isso nunca deve ser importado por código client-side.
 *
 * Linha ausente ou `enabled=false` devolve null: o executor
 * (lib/pousada/executor.ts) trata null como "use o comportamento hardcoded
 * de hoje, sem nenhuma alteração" — é o que garante compatibilidade mesmo
 * para organizações que nunca configuraram nada.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { HttpMethod } from "./http-capability-calls";

export type CapabilityAuthType = "none" | "bearer" | "api_key_header" | "api_key_query" | "basic";

export interface CapabilityHeaderEntry {
  key: string;
  value: string;
}

export interface CapabilityParamEntry {
  key: string;
  /** 'fixed' usa `value` literal; 'agent_field' resolve `value` como o nome de um campo do input da tool. */
  source: "fixed" | "agent_field";
  value: string;
}

export interface CapabilityBodyFieldMapEntry {
  /** Caminho no corpo final, ex: "reserva.observacao" ou "valor". */
  api_field_path: string;
  source: "fixed" | "agent_field";
  value: string;
}

export interface CapabilityCallRow {
  toolName: string;
  callKey: string;
  enabled: boolean;
  method: HttpMethod | null;
  baseUrl: string | null;
  endpointPath: string | null;
  headers: CapabilityHeaderEntry[];
  queryParams: CapabilityParamEntry[];
  pathParams: CapabilityParamEntry[];
  bodyType: "json" | "form" | "none";
  legacyBodyOverrides: Record<string, unknown>;
  bodyFieldMap: CapabilityBodyFieldMapEntry[];
  timeoutMs: number | null;
  verifyTls: boolean | null;
  authType: CapabilityAuthType;
  authKeyName: string | null;
  /** bytea cifrado, formato hex do PostgREST ("\x…") ou hex puro. Decifrar com lib/webhooks/secrets.ts. */
  authSecretEnc: string | null;
  specificConfig: Record<string, unknown>;
}

interface RawRow {
  tool_name: string;
  call_key: string;
  enabled: boolean;
  method: string | null;
  base_url: string | null;
  endpoint_path: string | null;
  headers: unknown;
  query_params: unknown;
  path_params: unknown;
  body_type: string | null;
  legacy_body_overrides: unknown;
  body_field_map: unknown;
  timeout_ms: number | null;
  verify_tls: boolean | null;
  auth_type: string | null;
  auth_key_name: string | null;
  auth_secret_enc: string | null;
  specific_config: unknown;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseHeaderList(raw: unknown): CapabilityHeaderEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is Record<string, unknown> => isPlainObject(e))
    .map((e) => ({ key: String(e.key ?? ""), value: String(e.value ?? "") }))
    .filter((e) => e.key !== "");
}

function parseParamList(raw: unknown): CapabilityParamEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is Record<string, unknown> => isPlainObject(e))
    .map((e) => ({
      key: String(e.key ?? ""),
      source: e.source === "agent_field" ? ("agent_field" as const) : ("fixed" as const),
      value: String(e.value ?? ""),
    }))
    .filter((e) => e.key !== "");
}

function parseBodyFieldMap(raw: unknown): CapabilityBodyFieldMapEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is Record<string, unknown> => isPlainObject(e))
    .map((e) => ({
      api_field_path: String(e.api_field_path ?? ""),
      source: e.source === "agent_field" ? ("agent_field" as const) : ("fixed" as const),
      value: String(e.value ?? ""),
    }))
    .filter((e) => e.api_field_path !== "");
}

const AUTH_TYPES: readonly CapabilityAuthType[] = [
  "none",
  "bearer",
  "api_key_header",
  "api_key_query",
  "basic",
];
const HTTP_METHODS: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

function toCapabilityCallRow(row: RawRow): CapabilityCallRow {
  return {
    toolName: row.tool_name,
    callKey: row.call_key,
    enabled: row.enabled === true,
    method: HTTP_METHODS.includes(row.method as HttpMethod) ? (row.method as HttpMethod) : null,
    baseUrl: row.base_url?.trim() || null,
    endpointPath: row.endpoint_path?.trim() || null,
    headers: parseHeaderList(row.headers),
    queryParams: parseParamList(row.query_params),
    pathParams: parseParamList(row.path_params),
    bodyType: row.body_type === "form" || row.body_type === "none" ? row.body_type : "json",
    legacyBodyOverrides: isPlainObject(row.legacy_body_overrides) ? row.legacy_body_overrides : {},
    bodyFieldMap: parseBodyFieldMap(row.body_field_map),
    timeoutMs: typeof row.timeout_ms === "number" ? row.timeout_ms : null,
    verifyTls: typeof row.verify_tls === "boolean" ? row.verify_tls : null,
    authType: AUTH_TYPES.includes(row.auth_type as CapabilityAuthType)
      ? (row.auth_type as CapabilityAuthType)
      : "none",
    authKeyName: row.auth_key_name?.trim() || null,
    authSecretEnc: row.auth_secret_enc || null,
    specificConfig: isPlainObject(row.specific_config) ? row.specific_config : {},
  };
}

/**
 * Lê a linha completa (inclui `auth_secret_enc` cifrado) — server-only.
 * `enabled=false` ou linha ausente devolvem null de propósito: o caller
 * (executor) trata isso como "sem config, use o hardcoded".
 */
export async function loadCapabilityCall(
  supabase: SupabaseClient,
  organizationId: string,
  toolName: string,
  callKey: string,
): Promise<CapabilityCallRow | null> {
  const { data, error } = await supabase
    .from("mcp_http_capability_calls")
    .select(
      "tool_name, call_key, enabled, method, base_url, endpoint_path, headers, query_params, path_params, " +
        "body_type, legacy_body_overrides, body_field_map, timeout_ms, verify_tls, auth_type, auth_key_name, " +
        "auth_secret_enc, specific_config",
    )
    .eq("organization_id", organizationId)
    .eq("tool_name", toolName)
    .eq("call_key", callKey)
    .maybeSingle();
  if (error) throw new Error(`carregar_capacidade_http_falhou: ${error.message}`);
  // Cast via unknown: a tabela é nova (migration 0149) e ainda não está no
  // Database gerado (lib/database.types.ts), então o supabase-js não
  // consegue tipar o resultado do select a partir da string de colunas.
  const row = data as unknown as RawRow | null;
  if (!row || row.enabled !== true) return null;
  return toCapabilityCallRow(row);
}
