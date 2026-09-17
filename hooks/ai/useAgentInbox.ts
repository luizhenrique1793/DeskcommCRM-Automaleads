"use client";
import { usePermission } from "@/hooks/auth/AuthProvider";
import { useMutation, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { AgentInboxSeverity } from "@/lib/ai/agent-inbox-copy";
import type { DestinoDoAviso } from "@/lib/ai/inbox-destino";

export interface AgentInboxItem {
  id: string;
  kind: string;
  severity: AgentInboxSeverity;
  title: string;
  body: string | null;
  ref_kind: string | null;
  ref_id: string | null;
  status: "open" | "ack" | "resolved";
  created_at: string;
  destination: DestinoDoAviso;
}

export interface AgentInboxData {
  items: AgentInboxItem[];
  open_count: number;
}

interface AgentInboxResponse {
  data: AgentInboxData;
  meta?: { cursor: string | null; has_more: boolean };
}

/**
 * Central de avisos do runtime (F1). Polling 60s — avisos nascem no worker.
 * Paginado por cursor: cada página vem com até 50 itens; `fetchNextPage`
 * busca a próxima. Antes disto o limite era 200 itens carregados de uma vez
 * só, sem jeito de ver o resto — achado ao vivo com 142 avisos acumulados de
 * teste (2026-08-18).
 */
export function useAgentInbox(status: "open" | "resolved" = "open") {
  const podeConsultar = usePermission("ai.inbox.view");
  return useInfiniteQuery({
    enabled: podeConsultar,
    queryKey: ["agent-inbox", status],
    refetchInterval: 60_000,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      apiClient.get<AgentInboxResponse>(
        `/api/v1/ai/inbox?status=${status}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
      ),
    getNextPageParam: (lastPage) => lastPage.meta?.cursor ?? undefined,
  });
}

export function useUpdateInboxItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: "open" | "resolved" }) =>
      apiClient.patch(`/api/v1/ai/inbox/${id}`, { status }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["agent-inbox"] }),
  });
}

/** Resolve/reabre várias linhas de uma vez — o botão "Resolver selecionados". */
export function useBulkUpdateInboxItems() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ids, status }: { ids: string[]; status: "open" | "resolved" }) =>
      apiClient.patch<{ data: { updated: number; ids: string[] } }>("/api/v1/ai/inbox", {
        ids,
        status,
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["agent-inbox"] }),
  });
}

/**
 * Resolve TODOS os avisos abertos da organização de uma vez.
 *
 * Não recebe ids: quem decide o conjunto é o servidor, a partir da org do
 * cookie. Mandar a lista da tela seria pior — a tela carrega no máximo 50, e
 * "marcar todos" com 144 abertos precisa alcançar os 144.
 */
export function useResolveAllInboxItems() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiClient.post<{ data: { resolved_count: number } }>(
      "/api/v1/ai/inbox/resolve-all",
      {},
    ),
    onSettled: () => qc.invalidateQueries({ queryKey: ["agent-inbox"] }),
  });
}
