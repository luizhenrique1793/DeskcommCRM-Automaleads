/**
 * Executor HTTP genérico das capacidades da pousada — monta e faz UMA
 * chamada HTTP, nada mais. Toda a lógica de negócio (validação de
 * disponibilidade, revalidação antes de reservar, parsing heterogêneo da
 * resposta do PMS, criação de card no CRM) continua em
 * lib/mcp/tools/pousada.ts, chamando isto por chamada física, não por tool.
 *
 * Sem configuração (`enabled=false` ou linha ausente): o comportamento é
 * IDÊNTICO ao hardcoded original — mesmo method/path/body que o handler já
 * monta, chamado direto via pmsRequest sem nenhum ajuste. É essa a garantia
 * de compatibilidade: uma organização que nunca abriu o editor não percebe
 * nenhuma mudança.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { pmsRequest } from "./pms-client";
import {
  loadCapabilityCall,
  type CapabilityParamEntry,
  type CapabilityBodyFieldMapEntry,
} from "./capability-config";
import { deepMergeOverride, type JsonRecord } from "./overrides";
import { montarUrlFinal, type ParamEntradaUrl } from "./http-capability-calls";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

export interface ChamadaPousadaInput {
  supabase: SupabaseClient;
  organizationId: string;
  toolName: string;
  callKey: string;
  /** Method/path/baseUrl/body hardcoded que o handler já monta hoje — usados como fallback sem config. */
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  baseUrl: string;
  body?: unknown;
  /** Input da tool (já validado pelo zod do handler) — resolve params/campos com source "agent_field". */
  input?: Record<string, unknown>;
}

function isPlainObject(v: unknown): v is JsonRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function resolveParamValue(
  entry: CapabilityParamEntry,
  input: Record<string, unknown> | undefined,
): string {
  if (entry.source === "agent_field") {
    const v = input?.[entry.value];
    return v === undefined || v === null ? "" : String(v);
  }
  return entry.value;
}

function coerceFixedValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function resolveBodyFieldValue(
  entry: CapabilityBodyFieldMapEntry,
  input: Record<string, unknown> | undefined,
): unknown {
  if (entry.source === "agent_field") return input?.[entry.value];
  return coerceFixedValue(entry.value);
}

function setDeepPath(obj: JsonRecord, path: string, value: unknown): void {
  const keys = path.split(".").filter(Boolean);
  if (keys.length === 0) return;
  let cursor: JsonRecord = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    if (!isPlainObject(cursor[key])) cursor[key] = {};
    cursor = cursor[key] as JsonRecord;
  }
  cursor[keys[keys.length - 1]!] = value;
}

function toParamEntradaUrl(
  entries: CapabilityParamEntry[],
  input: Record<string, unknown> | undefined,
): ParamEntradaUrl[] {
  return entries
    .filter((e) => e.key)
    .map((e) => ({ key: e.key, value: resolveParamValue(e, input) }));
}

export async function executarChamadaPousada(args: ChamadaPousadaInput): Promise<unknown> {
  const config = await loadCapabilityCall(
    args.supabase,
    args.organizationId,
    args.toolName,
    args.callKey,
  );

  if (!config) {
    return pmsRequest(args.method, args.path, args.baseUrl, args.body);
  }

  const method = config.method ?? args.method;

  const resolvedPathParams = toParamEntradaUrl(config.pathParams, args.input);
  const resolvedQueryParams = toParamEntradaUrl(config.queryParams, args.input);

  const extraHeaders: Record<string, string> = {};
  for (const h of config.headers) {
    if (h.key) extraHeaders[h.key] = h.value;
  }

  if (config.authType !== "none") {
    const secret =
      config.authSecretEnc != null
        ? await decryptWebhookSecret(args.supabase, config.authSecretEnc)
        : null;
    if (secret) {
      switch (config.authType) {
        case "bearer":
          extraHeaders.authorization = `Bearer ${secret}`;
          break;
        case "api_key_header":
          extraHeaders[config.authKeyName || "x-api-key"] = secret;
          break;
        case "api_key_query":
          resolvedQueryParams.push({ key: config.authKeyName || "api_key", value: secret });
          break;
        case "basic": {
          const user = config.authKeyName || "";
          extraHeaders.authorization = `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;
          break;
        }
      }
    }
  }

  const finalUrl = montarUrlFinal({
    baseUrl: config.baseUrl,
    endpointPath: config.endpointPath,
    pathParams: resolvedPathParams,
    queryParams: resolvedQueryParams,
    hardcodedBaseUrl: args.baseUrl,
    hardcodedEndpointPath: args.path,
  });
  if (!finalUrl) {
    // Sem base URL nenhuma (nem configurada, nem hardcoded) — mesmo erro que pmsRequest já dá hoje.
    return pmsRequest(method, args.path, args.baseUrl, args.body);
  }
  const baseUrlEfetiva = config.baseUrl?.trim() || args.baseUrl;

  let body = args.body;
  if (body !== undefined) {
    let merged: JsonRecord = isPlainObject(body)
      ? deepMergeOverride(body, config.legacyBodyOverrides)
      : (body as JsonRecord);
    if (isPlainObject(merged) && config.bodyFieldMap.length > 0) {
      merged = { ...merged };
      for (const entry of config.bodyFieldMap) {
        setDeepPath(merged, entry.api_field_path, resolveBodyFieldValue(entry, args.input));
      }
    }
    body = merged;
  }

  return pmsRequest(method, finalUrl, baseUrlEfetiva, body, {
    timeoutMs: config.timeoutMs ?? undefined,
    verifyTls: config.verifyTls ?? undefined,
    extraHeaders,
  });
}
