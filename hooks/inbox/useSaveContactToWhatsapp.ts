"use client";
import { useMutation } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import { toast } from "sonner";

interface SaveArgs {
  contact_id: string;
  channel_session_id: string;
}

/**
 * Salva o lead na agenda do WhatsApp do canal — botão manual, um contato por
 * vez (sem salvamento automático, decisão explícita do escopo inicial). O
 * `useMutation` já cobre "impedir dupla execução": `isPending` desabilita o
 * botão entre o clique e a resposta, então um segundo clique não dispara uma
 * segunda chamada antes da primeira terminar.
 */
export function useSaveContactToWhatsapp() {
  return useMutation({
    mutationFn: async (args: SaveArgs) =>
      apiClient.post<{ data: { saved: boolean } }>(
        `/api/v1/contacts/${args.contact_id}/save-to-whatsapp`,
        { channel_session_id: args.channel_session_id },
      ),
    onSuccess: () => toast.success("Contato salvo na agenda do WhatsApp."),
    onError: (err) => showApiError(err),
  });
}
