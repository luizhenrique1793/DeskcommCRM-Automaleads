"use client";
import { useInfiniteQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useCallback } from "react";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { useRefetchDeSeguranca } from "@/hooks/realtime/useRefetchDeSeguranca";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { Message } from "@/lib/types/messaging";

interface MessagesResponse {
  data: Message[];
  meta?: { cursor?: string | null; has_more?: boolean };
}

export function useMessagesRealtime(conversationId: string | null) {
  const qc = useQueryClient();
  const queryKey = ["messages", conversationId] as const;

  const query = useInfiniteQuery({
    queryKey,
    enabled: !!conversationId,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      if (!conversationId) {
        return { data: [], meta: { has_more: false, cursor: null } } as MessagesResponse;
      }
      const qs = new URLSearchParams();
      if (pageParam) qs.set("cursor", pageParam);
      qs.set("limit", "50");
      try {
        return await apiClient.get<MessagesResponse>(
          `/api/v1/conversations/${conversationId}/messages?${qs.toString()}`,
        );
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
    getNextPageParam: (last) =>
      last.meta?.has_more && last.meta.cursor ? last.meta.cursor : undefined,
    /**
     * Voltar para a aba RESSINCRONIZA — aqui, e não no padrão global.
     *
     * O padrão do repo é `refetchOnWindowFocus: false`, e está certo para o
     * resto: recarregar tudo a cada troca de aba é gasto sem retorno numa tela
     * que muda devagar. O inbox é o oposto — é a tela em que a informação chega
     * de fora enquanto ninguém olha, e voltar para ela é exatamente o momento
     * em que a defasagem aparece.
     *
     * É a segunda rede, não a primeira: quem entrega é o Realtime. Esta existe
     * para o intervalo em que ele esteve caído — e foi o sintoma relatado,
     * "às vezes preciso atualizar para a mensagem aparecer".
     */
    refetchOnWindowFocus: true,
  });

  const onChange = useCallback(() => {
    if (conversationId) qc.invalidateQueries({ queryKey: ["messages", conversationId] });
    qc.invalidateQueries({ queryKey: ["conversations"] });
  }, [qc, conversationId]);

  // Mesmo cuidado do board/lista de conversas: o status não pode ser
  // descartado, senão "canal morreu" e "nada aconteceu" são indistinguíveis.
  const { status: realtimeStatus, ultimaEntrega } = useRealtimeChannel({
    name: conversationId ? `messages-${conversationId}` : "messages-disabled",
    postgresChanges: conversationId
      ? {
          event: "*",
          schema: "public",
          table: "messages",
          filter: `conversation_id=eq.${conversationId}`,
        }
      : undefined,
    onChange,
    enabled: !!conversationId,
  });

  /**
   * A REDE DE SEGURANÇA — mesmo mecanismo do board/dossiê, reutilizado, nunca
   * reinventado. Cura a mesma classe de morte silenciosa que
   * `tests/prova-raio-do-silencio.ts` mediu na conversa aberta: canal
   * `SUBSCRIBED`, entrega morta, tela parada até um F5.
   *
   * Assinatura: contagem de mensagens + id da mais recente por `created_at` —
   * sensível a mensagem nova entrando (o que o canal deveria trazer),
   * insensível a reordenação de páginas já carregadas.
   */
  const seguranca = useRefetchDeSeguranca<InfiniteData<MessagesResponse>>({
    queryKey,
    assinatura: (d) => {
      const msgs = d?.pages.flatMap((p) => p.data) ?? [];
      let maior = "";
      let maiorId = "";
      for (const m of msgs) {
        if (m.created_at > maior) {
          maior = m.created_at;
          maiorId = m.id;
        }
      }
      return `${msgs.length}:${maiorId}`;
    },
    ultimaEntrega,
    enabled: !!conversationId,
  });

  return { ...query, realtimeStatus, seguranca };
}
