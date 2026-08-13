"use client";
/**
 * Lista chave/valor editável — headers, query params, path params, mapeamento
 * de campos (agente→API) e campos esperados no retorno do
 * EditorDeCapacidadeHttp usam este mesmo componente, só trocando os
 * placeholders e ligando (ou não) o seletor de origem fixo/dinâmico.
 */
import * as React from "react";
import { Trash, Plus } from "@/lib/ui/icons";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface KeyValueRow {
  key: string;
  value: string;
  source?: "fixed" | "agent_field";
}

interface Props {
  rows: KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  /** Mostra o seletor "valor fixo" vs "campo do agente" (query/path params, mapeamento de corpo). */
  withSource?: boolean;
  addLabel?: string;
  disabled?: boolean;
}

export function KeyValueListEditor({
  rows,
  onChange,
  keyPlaceholder = "chave",
  valuePlaceholder = "valor",
  withSource = false,
  addLabel = "Adicionar",
  disabled,
}: Props) {
  function atualizar(i: number, patch: Partial<KeyValueRow>) {
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function remover(i: number) {
    onChange(rows.filter((_, idx) => idx !== i));
  }
  function adicionar() {
    onChange([
      ...rows,
      withSource ? { key: "", value: "", source: "fixed" } : { key: "", value: "" },
    ]);
  }

  return (
    <div className="space-y-2">
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            value={row.key}
            onChange={(e) => atualizar(i, { key: e.target.value })}
            placeholder={keyPlaceholder}
            disabled={disabled}
            className="flex-1"
          />
          {withSource ? (
            <Select
              value={row.source ?? "fixed"}
              onValueChange={(v) => atualizar(i, { source: v as "fixed" | "agent_field" })}
              disabled={disabled}
            >
              <SelectTrigger className="w-40 shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fixed">Valor fixo</SelectItem>
                <SelectItem value="agent_field">Campo do agente</SelectItem>
              </SelectContent>
            </Select>
          ) : null}
          <Input
            value={row.value}
            onChange={(e) => atualizar(i, { value: e.target.value })}
            placeholder={
              withSource && row.source === "agent_field"
                ? "nome do campo, ex: checkin"
                : valuePlaceholder
            }
            disabled={disabled}
            className="flex-1"
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => remover(i)}
            disabled={disabled}
            aria-label="Remover"
          >
            <Trash />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={adicionar} disabled={disabled}>
        <Plus />
        {addLabel}
      </Button>
    </div>
  );
}
