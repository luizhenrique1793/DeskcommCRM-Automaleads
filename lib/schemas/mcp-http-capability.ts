/**
 * Zod schemas da configuração técnica editável das capacidades HTTP da
 * pousada (migration 0149, aba "Capacidades" do agente).
 *
 * `auth_secret` é write-only (plaintext, input do editor) — a rota troca por
 * `auth_secret_enc` cifrado antes de gravar (mesmo padrão de
 * `lib/webhooks/secrets.ts`/`actionSchema.call_webhook`). Omitir o campo
 * preserva o segredo já salvo; `auth_secret_clear: true` apaga.
 */
import { z } from "zod";

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export const CAPABILITY_AUTH_TYPES = [
  "none",
  "bearer",
  "api_key_header",
  "api_key_query",
  "basic",
] as const;
export const CAPABILITY_PARAM_SOURCES = ["fixed", "agent_field"] as const;

export const capabilityHeaderSchema = z.object({
  key: z.string().trim().min(1).max(200),
  value: z.string().max(2000),
});

export const capabilityParamSchema = z.object({
  key: z.string().trim().min(1).max(200),
  source: z.enum(CAPABILITY_PARAM_SOURCES).default("fixed"),
  value: z.string().max(2000),
});

export const capabilityBodyFieldMapSchema = z.object({
  api_field_path: z.string().trim().min(1).max(300),
  source: z.enum(CAPABILITY_PARAM_SOURCES).default("fixed"),
  value: z.string().max(2000),
});

export const capabilityResponseFieldMapSchema = z.object({
  agent_field: z.string().trim().min(1).max(200),
  response_path: z.string().trim().min(1).max(300),
});

export const capabilityCallWriteSchema = z.object({
  call_key: z.string().trim().min(1).max(100),
  call_label: z.string().trim().max(200).optional(),
  enabled: z.boolean().default(false),
  method: z.enum(HTTP_METHODS).nullish(),
  base_url: z.string().trim().max(500).nullish(),
  endpoint_path: z.string().trim().max(500).nullish(),
  headers: z.array(capabilityHeaderSchema).max(50).default([]),
  query_params: z.array(capabilityParamSchema).max(50).default([]),
  path_params: z.array(capabilityParamSchema).max(50).default([]),
  body_type: z.enum(["json", "form", "none"]).default("json"),
  legacy_body_overrides: z.record(z.string(), z.unknown()).default({}),
  body_field_map: z.array(capabilityBodyFieldMapSchema).max(100).default([]),
  response_field_map: z.array(capabilityResponseFieldMapSchema).max(50).default([]),
  timeout_ms: z.coerce.number().int().min(1000).max(120000).nullish(),
  verify_tls: z.boolean().nullish(),
  auth_type: z.enum(CAPABILITY_AUTH_TYPES).default("none"),
  auth_key_name: z.string().trim().max(200).nullish(),
  auth_secret: z.string().max(1000).optional(),
  auth_secret_clear: z.boolean().optional(),
  specific_config: z.record(z.string(), z.unknown()).default({}),
});

export const putCapabilityCallsSchema = z.object({
  tool_name: z.string().trim().min(1).max(200),
  calls: z.array(capabilityCallWriteSchema).min(1).max(10),
});

export type CapabilityCallWriteInput = z.infer<typeof capabilityCallWriteSchema>;
export type PutCapabilityCallsInput = z.infer<typeof putCapabilityCallsSchema>;
