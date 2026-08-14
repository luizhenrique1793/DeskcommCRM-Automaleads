import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { useRefetchDeSeguranca } from "@/hooks/realtime/useRefetchDeSeguranca";

/**
 * `useRefetchDeSeguranca` já é usado (board, dossiê) — nunca teve teste
 * dedicado. Este arquivo prova o mecanismo GENÉRICO em isolamento, sem
 * mock de canal Realtime nenhum: ele não sabe de WebSocket, só de
 * react-query + a ref `ultimaEntrega` que quem chama passa.
 *
 * Timer REAL com intervalo pequeno, não fake timers: `waitFor` do Testing
 * Library faz polling com timer próprio, e misturar os dois trava o teste em
 * silêncio até o timeout global (medido: 5 casos, 5 timeouts de 15s, todos no
 * PRIMEIRO `waitFor`, antes de qualquer avanço de fake timer acontecer).
 *
 * O caso de uso real (Inbox) está em
 * `tests/unit/inbox-realtime-seguranca.test.tsx`.
 */

function wrapperFactory(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

const INTERVALO_MS = 40;

/** Uma "tela" mínima: um useQuery real (para refetchQueries ter o que rodar) + o watchdog. */
function useSonda(
  queryKey: readonly unknown[],
  servidor: { current: number },
  ultimaEntrega: { current: number | null },
  enabled = true,
) {
  const q = useQuery({
    queryKey,
    queryFn: async () => servidor.current,
    refetchOnWindowFocus: false,
    staleTime: Infinity, // só o watchdog refaz — sem isso react-query refetcharia sozinho e confundiria o teste
  });
  const seguranca = useRefetchDeSeguranca<number>({
    queryKey,
    assinatura: (d) => String(d),
    ultimaEntrega,
    intervaloMs: INTERVALO_MS,
    enabled,
  });
  return { q, seguranca };
}

describe("useRefetchDeSeguranca — detecção", () => {
  it("dado mudou no servidor e o canal NUNCA entregou nada → divergência (perdeu) + cura", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const servidor = { current: 1 };
    const ultimaEntrega = { current: null as number | null };

    const { result } = renderHook(() => useSonda(["sonda-1"], servidor, ultimaEntrega), {
      wrapper: wrapperFactory(qc),
    });
    await waitFor(() => expect(result.current.q.data).toBe(1));

    servidor.current = 2; // mudou "no servidor" — o canal (ultimaEntrega) nunca soube
    await waitFor(() => expect(result.current.q.data).toBe(2)); // CUROU

    expect(result.current.seguranca.divergencias, "deveria ter detectado a perda").toBe(1);
    expect(result.current.seguranca.ultimaDivergencia).not.toBeNull();
  });

  it("dado mudou, mas o canal ENTREGOU antes da checagem → sem divergência (a mudança tem dono)", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const servidor = { current: 1 };
    const ultimaEntrega = { current: null as number | null };

    const { result } = renderHook(() => useSonda(["sonda-2"], servidor, ultimaEntrega), {
      wrapper: wrapperFactory(qc),
    });
    await waitFor(() => expect(result.current.q.data).toBe(1));

    servidor.current = 2;
    ultimaEntrega.current = Date.now(); // simula: o canal AVISOU (postgres_changes chegou)
    await waitFor(() => expect(result.current.q.data).toBe(2));

    expect(result.current.seguranca.divergencias, "o canal avisou — não é perda").toBe(0);
  });

  it("nada mudou → sem divergência, mas carimba que verificou", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const servidor = { current: 1 };
    const ultimaEntrega = { current: null as number | null };

    const { result } = renderHook(() => useSonda(["sonda-3"], servidor, ultimaEntrega), {
      wrapper: wrapperFactory(qc),
    });
    await waitFor(() => expect(result.current.q.data).toBe(1));
    await waitFor(() => expect(result.current.seguranca.ultimaVerificacao).not.toBeNull());

    expect(result.current.seguranca.divergencias).toBe(0);
  });

  it("enabled:false — não agenda verificação nenhuma", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const servidor = { current: 1 };
    const ultimaEntrega = { current: null as number | null };

    const { result } = renderHook(() => useSonda(["sonda-4"], servidor, ultimaEntrega, false), {
      wrapper: wrapperFactory(qc),
    });
    await waitFor(() => expect(result.current.q.data).toBe(1));

    servidor.current = 2;
    await new Promise((r) => setTimeout(r, INTERVALO_MS * 5));

    expect(result.current.seguranca.ultimaVerificacao, "desligado não deveria verificar").toBeNull();
    expect(result.current.q.data, "sem watchdog, o dado velho fica parado").toBe(1);
  });

  it("voltar para a aba (visibilitychange) dispara verificação imediata, sem esperar o intervalo", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const servidor = { current: 1 };
    const ultimaEntrega = { current: null as number | null };

    // Intervalo GRANDE de propósito: se a cura chegar mesmo assim, veio do
    // gatilho de foco, não do timer — o teste provaria a coisa errada.
    function useSondaFoco() {
      const query = useQuery({
        queryKey: ["sonda-5"],
        queryFn: async () => servidor.current,
        refetchOnWindowFocus: false,
        staleTime: Infinity,
      });
      const seguranca = useRefetchDeSeguranca<number>({
        queryKey: ["sonda-5"],
        assinatura: (d) => String(d),
        ultimaEntrega,
        intervaloMs: 60_000,
      });
      return { query, seguranca };
    }
    const { result } = renderHook(() => useSondaFoco(), { wrapper: wrapperFactory(qc) });
    await waitFor(() => expect(result.current.query.data).toBe(1));

    servidor.current = 2;
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => expect(result.current.query.data).toBe(2));
  });
});
