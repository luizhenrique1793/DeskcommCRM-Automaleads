"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useMemo, useState } from "react";
import Link from "next/link";
import { formatDistanceToNowStrict } from "date-fns";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useAgentInbox,
  useUpdateInboxItem,
  useBulkUpdateInboxItems,
  useResolveAllInboxItems,
  type AgentInboxItem,
} from "@/hooks/ai/useAgentInbox";
import { kindLabel, SEVERITY_LABEL, type AgentInboxSeverity } from "@/lib/ai/agent-inbox-copy";
import { Bell, Check } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";
import { ApiError } from "@/lib/api/types";
import { toast } from "sonner";

const SEVERITY_VARIANT: Record<AgentInboxSeverity, "info" | "warning" | "error"> = {
  info: "info",
  warn: "warning",
  critical: "error",
};

export function AgentInboxList({ canResolve }: { canResolve: boolean }) {
  const t = useT();
  const [tab, setTab] = useState<"open" | "resolved">("open");
  const [selecionados, setSelecionados] = useState<Set<string>>(new Set());
  const query = useAgentInbox(tab);
  const { error, isError, refetch, isFetching } = query;
  const acessoNegado = error instanceof ApiError && (error.status === 401 || error.status === 403);
  const update = useUpdateInboxItem();
  const bulkUpdate = useBulkUpdateInboxItems();
  const resolveAll = useResolveAllInboxItems();

  const items = useMemo(
    () => (acessoNegado ? [] : (query.data?.pages.flatMap((p) => p.data.items) ?? [])),
    [query.data, acessoNegado],
  );
  const openCount = acessoNegado ? undefined : query.data?.pages[0]?.data.open_count;

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
        onError: () => toast.error(t("Não consegui atualizar os avisos selecionados.")),
      },
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={tab} onValueChange={mudarAba}>
          <TabsList>
            <TabsTrigger value="open">
              {t("Abertos")}{openCount !== undefined ? ` (${openCount})` : ""}
            </TabsTrigger>
            <TabsTrigger value="resolved">{t("Resolvidos")}</TabsTrigger>
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
              ? t("Atualizando…")
              : tab === "open"
                ? `${t("Marcar resolvidos")} (${selecionados.size})`
                : `${t("Reabrir")} (${selecionados.size})`}
          </Button>
        ) : canResolve && tab === "open" && items.length > 0 ? (
          <Button
            size="sm"
            variant="outline"
            disabled={resolveAll.isPending}
            onClick={() => resolveAll.mutate()}
          >
            <Check size={14} aria-hidden />
            {t("Marcar todos resolvidos")}
          </Button>
        ) : null}
      </div>

      {isError ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-4 text-sm">
          <p className="min-w-0 flex-1">{t(acessoNegado ? "Seu acesso aos avisos não está disponível. Confira sua sessão e tente novamente." : items.length > 0 ? "Não foi possível atualizar os avisos. A lista abaixo pode estar desatualizada." : "Não foi possível carregar os avisos. Tente novamente.")}</p>
          <Button variant="outline" size="sm" disabled={isFetching} onClick={() => void refetch()}>{t("Tentar novamente")}</Button>
        </div>
      ) : null}
      {update.isError ? <p role="alert" className="text-sm text-destructive">{t("Não foi possível atualizar este aviso. Tente novamente.")}</p> : null}
      {/* O lote pode falhar depois de resolver PARTE dos avisos: a mensagem manda
          conferir a lista em vez de afirmar que nada mudou. Sem isto o clique em
          "Marcar todos resolvidos" não deixaria rastro nenhum quando errasse. */}
      {resolveAll.isError ? <p role="alert" className="text-sm text-destructive">{t("Não foi possível resolver todos os avisos. Confira a lista e tente novamente.")}</p> : null}

      {query.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : isError && items.length === 0 ? null : items.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
          <Bell size={28} className="text-muted-foreground" aria-hidden />
          <p className="text-sm font-medium">
            {tab === "open" ? t("Nenhum aviso em aberto") : t("Nenhum aviso resolvido")}
          </p>
          <p className="text-xs text-muted-foreground">
            {tab === "open"
              ? t("Quando o assistente precisar de você, o aviso aparece aqui.")
              : t("Avisos que você marcar como resolvidos ficam aqui.")}
          </p>
        </div>
      ) : (
        <>
          {tab === "open" ? (
            <p className="-mb-2 text-xs text-muted-foreground">
              {t("Os mais graves primeiro; entre iguais, os mais recentes.")}
            </p>
          ) : null}
          {canResolve ? (
            <label className="flex items-center gap-2 px-1">
              <input
                type="checkbox"
                className="h-4 w-4 shrink-0 rounded-md border-border accent-primary"
                checked={todosCarregadosSelecionados}
                onChange={alternarSelecionarTodos}
                aria-label={t("Selecionar todos os avisos carregados")}
                data-testid="selecionar-todos"
              />
              <span className="text-xs text-muted-foreground">
                {t("Selecionar todos os")} {items.length} {t("carregados")}
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
              {query.isFetchingNextPage ? t("Carregando…") : t("Carregar mais")}
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
  const localeDaData = useLocaleDeData();
  const t = useT();
  const when = formatDistanceToNowStrict(new Date(item.created_at), {
    addSuffix: true,
    locale: localeDaData,
  });
  return (
    <li className="flex flex-wrap items-start gap-3 px-4 py-3" data-testid="inbox-item">
      {canResolve ? (
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 shrink-0 rounded-md border-border accent-primary"
          checked={selecionado}
          onChange={onToggleSelecao}
          aria-label={`${t("Selecionar aviso")}: ${item.title}`}
        />
      ) : null}
      <Badge variant={SEVERITY_VARIANT[item.severity]} className="mt-0.5 shrink-0">
        {t(SEVERITY_LABEL[item.severity])}
      </Badge>
      <div className="min-w-0 flex-1 basis-48 break-words">
        {/* TÍTULO E CORPO SAEM COMO VIERAM — nunca por t().
            São LINHAS de `agent_inbox_items`, escritas pelo runtime no momento do
            evento e recheadas com dado de gente: nome do cliente, número, motivo do
            handoff, o que o operador cadastrou. É a mesma regra que já vale para nome
            de funil, rótulo de etapa e conteúdo de mensagem — e a mesma que o PR #600
            aplicou à Agenda. Passar isso pelo dicionário não traduz nada (a chave é a
            frase inteira, que nunca casa) e, quando casa, troca a palavra que a pessoa
            cadastrou por outra que ela não sabe procurar.
            O que continua traduzido é o que é NOSSO: severidade, rótulo do kind,
            orientação e rótulo do destino. */}
        <p className="text-sm font-medium">{item.title}</p>
        <p className="text-xs text-muted-foreground">
          {kindLabel(item.kind, t)} · {when}
        </p>
        {item.body ? <p className="mt-1 text-xs text-muted-foreground">{item.body}</p> : null}
        {item.destination.orientacao ? <p className="mt-2 text-xs text-muted-foreground">{t(item.destination.orientacao)}</p> : null}
        {item.destination.estado === "disponivel" ? (
          <Button asChild size="sm" variant="link" className="mt-1 h-auto whitespace-normal px-0 text-left">
            <Link href={item.destination.href}>{t(item.destination.rotulo)}</Link>
          </Button>
        ) : null}
      </div>
      {canResolve ? (
        item.status === "resolved" ? (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => onToggle("open")}>
            {t("Reabrir")}
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => onToggle("resolved")}>
            <Check size={14} aria-hidden />
            {t("Marcar resolvido")}
          </Button>
        )
      ) : null}
    </li>
  );
}
