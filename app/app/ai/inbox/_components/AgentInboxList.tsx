"use client";
import { useMemo, useState } from "react";
import { formatDistanceToNowStrict } from "date-fns";
import { ptBR } from "date-fns/locale";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useAgentInbox,
  useUpdateInboxItem,
  useBulkUpdateInboxItems,
  type AgentInboxItem,
} from "@/hooks/ai/useAgentInbox";
import { kindLabel, SEVERITY_LABEL, type AgentInboxSeverity } from "@/lib/ai/agent-inbox-copy";
import { Bell, Check } from "@/lib/ui/icons";

const SEVERITY_VARIANT: Record<AgentInboxSeverity, "info" | "warning" | "error"> = {
  info: "info",
  warn: "warning",
  critical: "error",
};

export function AgentInboxList({ canResolve }: { canResolve: boolean }) {
  const [tab, setTab] = useState<"open" | "resolved">("open");
  const [selecionados, setSelecionados] = useState<Set<string>>(new Set());
  const query = useAgentInbox(tab);
  const update = useUpdateInboxItem();
  const bulkUpdate = useBulkUpdateInboxItems();

  const items = useMemo(
    () => query.data?.pages.flatMap((p) => p.data.items) ?? [],
    [query.data],
  );
  const openCount = query.data?.pages[0]?.data.open_count;

  function mudarAba(v: string) {
    setTab(v as "open" | "resolved");
    setSelecionados(new Set());
  }

  function alternarSelecao(id: string) {
    setSelecionados((prev) => {
      const proximo = new Set(prev);
      if (proximo.has(id)) proximo.delete(id);
      else proximo.add(id);
      return proximo;
    });
  }

  const todosCarregadosSelecionados = items.length > 0 && selecionados.size === items.length;

  function alternarSelecionarTodos() {
    setSelecionados(todosCarregadosSelecionados ? new Set() : new Set(items.map((i) => i.id)));
  }

  function resolverSelecionados() {
    const ids = [...selecionados];
    const alvo = tab === "open" ? "resolved" : "open";
    bulkUpdate.mutate(
      { ids, status: alvo },
      {
        onSuccess: (res) => {
          toast.success(
            `${res.data.updated} ${res.data.updated === 1 ? "aviso" : "avisos"} atualizado${res.data.updated === 1 ? "" : "s"}.`,
          );
          setSelecionados(new Set());
        },
        onError: () => toast.error("Não consegui atualizar os avisos selecionados."),
      },
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={tab} onValueChange={mudarAba}>
          <TabsList>
            <TabsTrigger value="open">
              Abertos{openCount !== undefined ? ` (${openCount})` : ""}
            </TabsTrigger>
            <TabsTrigger value="resolved">Resolvidos</TabsTrigger>
          </TabsList>
        </Tabs>
        {canResolve && selecionados.size > 0 ? (
          <Button
            size="sm"
            variant="outline"
            disabled={bulkUpdate.isPending}
            onClick={resolverSelecionados}
            data-testid="resolver-selecionados"
          >
            <Check size={14} aria-hidden />
            {bulkUpdate.isPending
              ? "Atualizando…"
              : tab === "open"
                ? `Marcar resolvidos (${selecionados.size})`
                : `Reabrir (${selecionados.size})`}
          </Button>
        ) : null}
      </div>

      {query.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
          <Bell size={28} className="text-muted-foreground/60" aria-hidden />
          <p className="text-sm font-medium">
            {tab === "open" ? "Nenhum aviso em aberto" : "Nenhum aviso resolvido"}
          </p>
          <p className="text-xs text-muted-foreground">
            {tab === "open"
              ? "Quando o assistente precisar de você, o aviso aparece aqui."
              : "Avisos que você marcar como resolvidos ficam aqui."}
          </p>
        </div>
      ) : (
        <>
          {canResolve ? (
            <label className="flex items-center gap-2 px-1">
              <input
                type="checkbox"
                className="h-4 w-4 shrink-0 rounded border-border accent-primary"
                checked={todosCarregadosSelecionados}
                onChange={alternarSelecionarTodos}
                aria-label="Selecionar todos os avisos carregados"
                data-testid="selecionar-todos"
              />
              <span className="text-xs text-muted-foreground">
                Selecionar todos os {items.length} carregados
              </span>
            </label>
          ) : null}
          <ul className="divide-y divide-border rounded-lg border border-border">
            {items.map((item) => (
              <InboxRow
                key={item.id}
                item={item}
                canResolve={canResolve}
                pending={update.isPending}
                selecionado={selecionados.has(item.id)}
                onToggleSelecao={() => alternarSelecao(item.id)}
                onToggle={(status) => update.mutate({ id: item.id, status })}
              />
            ))}
          </ul>
          {query.hasNextPage ? (
            <Button
              variant="outline"
              size="sm"
              className="self-center"
              disabled={query.isFetchingNextPage}
              onClick={() => query.fetchNextPage()}
              data-testid="carregar-mais-avisos"
            >
              {query.isFetchingNextPage ? "Carregando…" : "Carregar mais"}
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}

function InboxRow({
  item,
  canResolve,
  pending,
  selecionado,
  onToggleSelecao,
  onToggle,
}: {
  item: AgentInboxItem;
  canResolve: boolean;
  pending: boolean;
  selecionado: boolean;
  onToggleSelecao: () => void;
  onToggle: (status: "open" | "resolved") => void;
}) {
  const when = formatDistanceToNowStrict(new Date(item.created_at), {
    addSuffix: true,
    locale: ptBR,
  });
  return (
    <li className="flex items-start gap-3 px-4 py-3" data-testid="inbox-item">
      {canResolve ? (
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 shrink-0 rounded border-border accent-primary"
          checked={selecionado}
          onChange={onToggleSelecao}
          aria-label={`Selecionar aviso: ${item.title}`}
        />
      ) : null}
      <Badge variant={SEVERITY_VARIANT[item.severity]} className="mt-0.5 shrink-0">
        {SEVERITY_LABEL[item.severity]}
      </Badge>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{item.title}</p>
        <p className="text-xs text-muted-foreground">
          {kindLabel(item.kind)} · {when}
        </p>
        {item.body ? <p className="mt-1 text-xs text-muted-foreground">{item.body}</p> : null}
      </div>
      {canResolve ? (
        item.status === "resolved" ? (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => onToggle("open")}>
            Reabrir
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => onToggle("resolved")}>
            <Check size={14} aria-hidden />
            Marcar resolvido
          </Button>
        )
      ) : null}
    </li>
  );
}
