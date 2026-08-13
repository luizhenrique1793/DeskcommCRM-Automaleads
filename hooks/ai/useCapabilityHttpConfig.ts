"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

export interface CapabilityHttpHeader {
  key: string;
  value: string;
}

export interface CapabilityHttpParam {
  key: string;
  source: "fixed" | "agent_field";
  value: string;
}

export interface CapabilityHttpBodyFieldMap {
  api_field_path: string;
  source: "fixed" | "agent_field";
  value: string;
}

export interface CapabilityHttpResponseFieldMap {
  agent_field: string;
  response_path: string;
}

export type CapabilityHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type CapabilityHttpAuthType =
  "none" | "bearer" | "api_key_header" | "api_key_query" | "basic";

export interface CapabilityHttpCall {
  tool_name: string;
  call_key: string;
  call_label: string;
  call_order: number;
  enabled: boolean;
  method: CapabilityHttpMethod | null;
  base_url: string | null;
  endpoint_path: string | null;
  headers: CapabilityHttpHeader[];
  query_params: CapabilityHttpParam[];
  path_params: CapabilityHttpParam[];
  body_type: "json" | "form" | "none";
  legacy_body_overrides: Record<string, unknown>;
  body_field_map: CapabilityHttpBodyFieldMap[];
  response_field_map: CapabilityHttpResponseFieldMap[];
  timeout_ms: number | null;
  verify_tls: boolean | null;
  auth_type: CapabilityHttpAuthType;
  auth_key_name: string | null;
  auth_secret_last4: string | null;
  specific_config: Record<string, unknown>;
}

interface GetResponse {
  data: { tool_name: string; calls: CapabilityHttpCall[] };
}

export function capabilityHttpConfigQueryKey(toolName: string) {
  return ["ai", "capability-http-configs", toolName] as const;
}

export function useCapabilityHttpConfig(toolName: string, enabled = true) {
  return useQuery({
    queryKey: capabilityHttpConfigQueryKey(toolName),
    queryFn: async () =>
      (
        await apiClient.get<GetResponse>(
          `/api/v1/ai/capability-http-configs?tool_name=${encodeURIComponent(toolName)}`,
        )
      ).data,
    enabled,
  });
}

export type CapabilityHttpCallWrite = Omit<CapabilityHttpCall, "auth_secret_last4"> & {
  auth_secret?: string;
  auth_secret_clear?: boolean;
};

export interface SaveCapabilityHttpCallsInput {
  tool_name: string;
  calls: CapabilityHttpCallWrite[];
}

export function useSaveCapabilityHttpConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveCapabilityHttpCallsInput) =>
      apiClient.put("/api/v1/ai/capability-http-configs", input),
    onSuccess: (_data, variables) =>
      void qc.invalidateQueries({ queryKey: capabilityHttpConfigQueryKey(variables.tool_name) }),
  });
}
