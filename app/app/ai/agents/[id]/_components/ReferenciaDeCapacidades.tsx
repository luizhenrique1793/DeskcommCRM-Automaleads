"use client";
/**
 * Referência rápida dos nomes técnicos das capacidades LIGADAS neste agente —
 * pra copiar direto ao escrever o prompt (ex.: "SEMPRE USE A TOOL
 * pousada_consultar_data_atual"). Fica dentro do card do prompt, que é onde o
 * nome técnico é realmente usado — o ToolPicker já mostra o mesmo nome no
 * "modo avançado", mas numa aba/seção onde você não está escrevendo o texto.
 *
 * Só leitura, zero mutação: não muda nada em como a tool é chamada (isso
 * continua sendo function-calling da API do modelo — o prompt é só instrução
 * em português pro modelo saber QUANDO chamar). Mesma queryKey ["mcp","tools"]
 * do ToolPicker — o React Query dedupe a request, então não dobra rede.
 */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api/client";
import { copyToClipboard } from "@/lib/clipboard";
import { Copy, CaretDown, CaretUp, Robot } from "@/lib/ui/icons";

interface ToolMetaResumo {
  id: string;
  name: string;
  rotulo: string;
  o_que_toca: string;
}
interface ApiResponse {
  data: { tools: Array<Omit<ToolMetaResumo, "name">> };
}

export function ReferenciaDeCapacidades({ toolIds }: { toolIds: string[] }) {
  // Aberto por padrão — a primeira versão nascia colapsada e discreta demais
  // (texto cinza pequeno), passando batido de quem rolava a tela procurando o
  // nome técnico pra citar no prompt (achado ao vivo com o usuário: ele achou
  // o "modo avançado" do ToolPicker, em outra seção, e nunca viu este bloco).
  const [aberto, setAberto] = React.useState(true);

  // MESMA queryKey do ToolPicker (["mcp","tools"]) de propósito — dedupe de
  // rede. Por isso o shape devolvido aqui tem que ser IDÊNTICO ao de lá
  // (inclusive o `name: t.id`, que só esta função usaria sem o merge): como o
  // React Query cacheia por chave, quem "vencer" a corrida populando o cache
  // dita o dado que o OUTRO componente também vê. Divergir o shape aqui fazia
  // o ToolPicker herdar tools sem `name` — o Map de busca dele colapsava pra
  // 1 entrada e as 11 capacidades do agente apareciam como "órfãs" (achado ao
  // vivo, 2026-08-19).
  const query = useQuery({
    queryKey: ["mcp", "tools"],
    queryFn: async () =>
      (await apiClient.get<ApiResponse>("/api/v1/mcp/tools")).data.tools.map((t) => ({
        ...t,
        name: t.id,
      })),
    staleTime: 60_000,
  });

  if (toolIds.length === 0) return null;

  const porId = new Map((query.data ?? []).map((t) => [t.id, t]));
  const ligadas = toolIds
    .map((id) => porId.get(id) ?? { id, rotulo: id, o_que_toca: "" })
    .sort((a, b) => a.rotulo.localeCompare(b.rotulo, "pt-BR"));

  async function copiar(nome: string) {
    const ok = await copyToClipboard(nome);
    if (ok) {
      toast.success(`Copiado: ${nome}`);
    } else {
      toast.error("Não consegui copiar — selecione o texto manualmente.");
    }
  }

  return (
    <div
      className="border-primary/30 bg-primary/5 rounded-md border"
      data-testid="referencia-capacidades"
    >
      <button
        type="button"
        onClick={() => setAberto((v) => !v)}
        className="flex w-full items-center justify-between gap-2 p-3 text-left"
        aria-expanded={aberto}
        data-testid="referencia-capacidades-toggle"
      >
        <span className="flex items-center gap-2 text-sm font-semibold">
          <Robot size={16} aria-hidden />
          Nomes técnicos das {toolIds.length}{" "}
          {toolIds.length === 1 ? "capacidade ligada" : "capacidades ligadas"} — copie pra citar
          no prompt
        </span>
        {aberto ? <CaretUp size={16} aria-hidden /> : <CaretDown size={16} aria-hidden />}
      </button>
      {aberto ? (
        <ul className="divide-border/60 border-primary/20 divide-y border-t">
          {query.isLoading ? (
            <li className="p-2 text-xs text-muted-foreground">Carregando…</li>
          ) : (
            ligadas.map((t) => (
              <li
                key={t.id}
                className="bg-background flex items-center gap-2 p-2"
                data-testid={`referencia-${t.id}`}
              >
                <div className="min-w-0 flex-1">
                  <code className="block truncate font-mono text-xs font-semibold">{t.id}</code>
                  <span className="text-[11px] text-muted-foreground">
                    {t.rotulo}
                    {t.o_que_toca ? ` · ${t.o_que_toca}` : ""}
                  </span>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0"
                  onClick={() => copiar(t.id)}
                  aria-label={`Copiar nome técnico de ${t.rotulo}`}
                >
                  <Copy size={12} aria-hidden />
                  Copiar
                </Button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
