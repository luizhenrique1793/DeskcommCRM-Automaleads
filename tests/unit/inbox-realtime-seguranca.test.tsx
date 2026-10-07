import { readFileSync } from "node:fs";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O INBOX GANHA A MESMA REDE DE SEGURANÇA QUE BOARD E DOSSIÊ JÁ TÊM.
 *
 * Causa medida (2026-08-14): o canal do Inbox pode ficar `SUBSCRIBED` e parar
 * de entregar `postgres_changes` em silêncio (mesma classe de defeito de
 * `tests/prova-raio-do-silencio.ts`). `refetchOnWindowFocus` só ajuda quem
 * troca de aba; quem fica olhando a tela o tempo todo (o caso relatado) não
 * tinha rede nenhuma. `useConversationsRealtime`/`useMessagesRealtime` agora
 * chamam `useRefetchDeSeguranca` — o MESMO mecanismo que `useBoard.ts` e
 * `useLeadTimeline.ts` já usam, não uma segunda arquitetura.
 *
 * Este arquivo prova a FIAÇÃO (wiring), não o mecanismo em si — o mecanismo
 * (`useRefetchDeSeguranca`) já tem prova própria e genérica em
 * `tests/unit/refetch-de-seguranca.test.tsx`. Por isso os dois hooks aqui são
 * MOCKADOS: rodar o timer de 45s de verdade tornaria este arquivo lento e
 * frágil sem provar nada que o outro arquivo já não prove.
 */

const realtimeChannelSpy = vi.fn();
vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({
  useRealtimeChannel: (opts: unknown) => realtimeChannelSpy(opts),
}));

const refetchSegurancaSpy = vi.fn();
vi.mock("@/hooks/realtime/useRefetchDeSeguranca", () => ({
  useRefetchDeSeguranca: (opts: unknown) => refetchSegurancaSpy(opts),
}));

const getSpy = vi.fn(async (_url: string) => ({ data: [], meta: { has_more: false, cursor: null } }));
vi.mock("@/lib/api/client", () => ({ apiClient: { get: (url: string) => getSpy(url) } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

import { useConversationsRealtime } from "@/hooks/inbox/useConversationsRealtime";
import { useMessagesRealtime } from "@/hooks/inbox/useMessagesRealtime";

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const ULTIMA_ENTREGA_FALSA = { current: null as number | null };

beforeEach(() => {
  realtimeChannelSpy.mockReset();
  refetchSegurancaSpy.mockReset();
  getSpy.mockClear();
  realtimeChannelSpy.mockReturnValue({ status: "subscribed", ultimaEntrega: ULTIMA_ENTREGA_FALSA });
  refetchSegurancaSpy.mockReturnValue({ divergencias: 0, ultimaDivergencia: null, ultimaVerificacao: null });
});

describe("useConversationsRealtime — fiação da rede de segurança", () => {
  it("chama useRealtimeChannel UMA vez, nunca mais — sem subscription duplicada", async () => {
    renderHook(() => useConversationsRealtime({}, "org-1"), { wrapper });
    await waitFor(() => expect(getSpy).toHaveBeenCalled());
    expect(realtimeChannelSpy).toHaveBeenCalledTimes(1);
  });

  it("repassa a MESMA ref ultimaEntrega do canal pro watchdog — não perde a ligação", async () => {
    renderHook(() => useConversationsRealtime({}, "org-1"), { wrapper });
    await waitFor(() => expect(refetchSegurancaSpy).toHaveBeenCalledTimes(1));
    const args = refetchSegurancaSpy.mock.calls[0]![0] as { ultimaEntrega: unknown };
    expect(args.ultimaEntrega).toBe(ULTIMA_ENTREGA_FALSA);
  });

  it("usa a MESMA queryKey da lista — senão o watchdog vigia um cache que ninguém lê", async () => {
    renderHook(() => useConversationsRealtime({ status: "open" }, "org-1"), { wrapper });
    await waitFor(() => expect(refetchSegurancaSpy).toHaveBeenCalledTimes(1));
    const args = refetchSegurancaSpy.mock.calls[0]![0] as { queryKey: unknown[] };
    expect(args.queryKey).toEqual(["conversations", { status: "open" }]);
  });

  it("expõe realtimeStatus e seguranca no retorno — não descarta o que o canal e o watchdog dizem", async () => {
    refetchSegurancaSpy.mockReturnValue({ divergencias: 2, ultimaDivergencia: 123, ultimaVerificacao: 456 });
    realtimeChannelSpy.mockReturnValue({ status: "channel_error", ultimaEntrega: ULTIMA_ENTREGA_FALSA });
    const { result } = renderHook(() => useConversationsRealtime({}, "org-1"), { wrapper });
    await waitFor(() => expect(getSpy).toHaveBeenCalled());
    expect(result.current.realtimeStatus).toBe("channel_error");
    expect(result.current.seguranca).toEqual({ divergencias: 2, ultimaDivergencia: 123, ultimaVerificacao: 456 });
  });

  it("a assinatura é sensível a: contagem de conversas + maior last_message_at + o id dono dele", async () => {
    renderHook(() => useConversationsRealtime({}, "org-1"), { wrapper });
    await waitFor(() => expect(refetchSegurancaSpy).toHaveBeenCalledTimes(1));
    const { assinatura } = refetchSegurancaSpy.mock.calls[0]![0] as {
      assinatura: (d: unknown) => string;
    };
    const dado = {
      pages: [
        {
          data: [
            { id: "c1", last_message_at: "2026-08-14T01:00:00Z", updated_at: "2026-08-14T01:00:00Z" },
            { id: "c2", last_message_at: "2026-08-14T02:00:00Z", updated_at: "2026-08-14T01:30:00Z" },
          ],
        },
      ],
    };
    expect(assinatura(dado)).toBe("2:2026-08-14T02:00:00Z:c2");
    expect(assinatura(undefined)).toBe("0::");
  });

  it("disabled quando não há orgId — não fica vigiando um canal que nunca assina", async () => {
    renderHook(() => useConversationsRealtime({}, null), { wrapper });
    await waitFor(() => expect(refetchSegurancaSpy).toHaveBeenCalledTimes(1));
    const args = refetchSegurancaSpy.mock.calls[0]![0] as { enabled: boolean };
    expect(args.enabled).toBe(false);
  });
});

describe("useMessagesRealtime — fiação da rede de segurança", () => {
  const getMsgSpy = vi.fn(async (_url: string) => ({ data: [], meta: { has_more: false, cursor: null } }));
  beforeEach(() => {
    getMsgSpy.mockClear();
  });

  it("chama useRealtimeChannel UMA vez por conversa — sem subscription duplicada", async () => {
    getSpy.mockImplementation(getMsgSpy);
    renderHook(() => useMessagesRealtime("conv-1"), { wrapper });
    await waitFor(() => expect(getSpy).toHaveBeenCalled());
    expect(realtimeChannelSpy).toHaveBeenCalledTimes(1);
  });

  it("repassa a MESMA ref ultimaEntrega do canal pro watchdog", async () => {
    renderHook(() => useMessagesRealtime("conv-1"), { wrapper });
    await waitFor(() => expect(refetchSegurancaSpy).toHaveBeenCalledTimes(1));
    const args = refetchSegurancaSpy.mock.calls[0]![0] as { ultimaEntrega: unknown };
    expect(args.ultimaEntrega).toBe(ULTIMA_ENTREGA_FALSA);
  });

  it("usa a queryKey da conversa aberta", async () => {
    renderHook(() => useMessagesRealtime("conv-42"), { wrapper });
    await waitFor(() => expect(refetchSegurancaSpy).toHaveBeenCalledTimes(1));
    const args = refetchSegurancaSpy.mock.calls[0]![0] as { queryKey: unknown[] };
    expect(args.queryKey).toEqual(["messages", "conv-42"]);
  });

  it("a assinatura é sensível a: contagem de mensagens + id da mais recente por created_at", async () => {
    renderHook(() => useMessagesRealtime("conv-1"), { wrapper });
    await waitFor(() => expect(refetchSegurancaSpy).toHaveBeenCalledTimes(1));
    const { assinatura } = refetchSegurancaSpy.mock.calls[0]![0] as {
      assinatura: (d: unknown) => string;
    };
    const dado = {
      pages: [
        { data: [{ id: "m1", created_at: "2026-08-14T01:00:00Z" }] },
        { data: [{ id: "m2", created_at: "2026-08-14T02:00:00Z" }] },
      ],
    };
    expect(assinatura(dado)).toBe("2:m2");
  });

  it("sem conversationId — desligado, e sem chamar useRealtimeChannel-postgresChanges", async () => {
    renderHook(() => useMessagesRealtime(null), { wrapper });
    await waitFor(() => expect(realtimeChannelSpy).toHaveBeenCalledTimes(1));
    const optsCanal = realtimeChannelSpy.mock.calls[0]![0] as { enabled: boolean };
    expect(optsCanal.enabled).toBe(false);
    const optsSeg = refetchSegurancaSpy.mock.calls[0]![0] as { enabled: boolean };
    expect(optsSeg.enabled).toBe(false);
  });

  it("COSTURA: mensagem nova invalida a THREAD aberta E a LISTA de conversas — os dois painéis não discordam", async () => {
    const invalidateSpy = vi.fn();
    function Wrapper({ children }: { children: ReactNode }) {
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const original = qc.invalidateQueries.bind(qc);
      qc.invalidateQueries = ((...args: Parameters<typeof original>) => {
        invalidateSpy(...args);
        return original(...args);
      }) as typeof qc.invalidateQueries;
      return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    }

    renderHook(() => useMessagesRealtime("conv-1"), { wrapper: Wrapper });
    await waitFor(() => expect(realtimeChannelSpy).toHaveBeenCalledTimes(1));

    const onChange = (realtimeChannelSpy.mock.calls[0]![0] as { onChange: (p: unknown) => void }).onChange;
    onChange({ tipo: "mensagem-nova-de-teste" });

    const chaves = () =>
      invalidateSpy.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
    expect(chaves(), "não invalidou a thread da conversa aberta").toContain(JSON.stringify(["messages", "conv-1"]));
    // A invalidação de `["conversations"]` passou a ser AGRUPADA
    // (`agendarRecargaDasConversas`, janela de 150ms) para uma rajada de
    // eventos virar uma busca só — por isso espera a janela, não confere na
    // hora. Ver o cabeçalho de `hooks/inbox/recargaDasConversas.ts`.
    await waitFor(() =>
      expect(chaves(), "não invalidou a lista de conversas — a costura quebrou").toContain(
        JSON.stringify(["conversations"]),
      ),
    );
  });
});

describe("status publicado — a mesma âncora que o board/dossiê já expõem para QA", () => {
  it("ConversationList publica data-realtime-status", () => {
    const fonte = readFileSync("components/inbox/ConversationList.tsx", "utf8");
    expect(fonte).toMatch(/data-realtime-status=\{q\.realtimeStatus\.toLowerCase\(\)\}/);
  });

  it("ChatThread publica data-realtime-status", () => {
    const fonte = readFileSync("components/inbox/ChatThread.tsx", "utf8");
    expect(fonte).toMatch(/data-realtime-status=\{q\.realtimeStatus\.toLowerCase\(\)\}/);
  });
});

describe("reconexão de canal (CLOSED/TIMED_OUT/CHANNEL_ERROR) — herdada, não duplicada", () => {
  // O Inbox NUNCA implementa reconexão própria: delega inteiramente a
  // `useRealtimeChannel`, que já reconecta com backoff (provado em
  // `tests/unit/realtime-reconecta.test.ts`). Este caso trava a delegação —
  // se algum dia um hook do Inbox importar outra coisa no lugar, ou criar
  // `new WebSocket`/reconectar por conta própria, ele aponta o dedo aqui.
  it("useConversationsRealtime e useMessagesRealtime importam o ÚNICO useRealtimeChannel", () => {
    const a = readFileSync("hooks/inbox/useConversationsRealtime.ts", "utf8");
    const b = readFileSync("hooks/inbox/useMessagesRealtime.ts", "utf8");
    for (const fonte of [a, b]) {
      expect(fonte).toMatch(/import \{ useRealtimeChannel \} from "@\/hooks\/realtime\/useRealtimeChannel"/);
      expect(fonte).not.toMatch(/new WebSocket/);
    }
  });
});
