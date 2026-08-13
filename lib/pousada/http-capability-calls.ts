/**
 * Fonte única das chamadas HTTP físicas que as capacidades da pousada fazem
 * ao PMS — usada pela migration de backfill (0149), pelo executor
 * (lib/pousada/executor.ts) e pela UI (quantas sub-abas renderizar por tool).
 *
 * Duas tools fazem DUAS chamadas HTTP diferentes cada
 * (pousada_verificar_ou_cadastrar_hospede: busca + cadastro;
 * pousada_criar_reserva: revalida disponibilidade + cria reserva) — cada
 * chamada física vira sua própria linha editável, metáfora "1 node HTTP = 1
 * linha". pousada_consultar_data_atual não faz chamada HTTP nenhuma e por
 * isso não aparece aqui.
 *
 * Client-safe: zero import de zod, supabase ou next/headers — o mesmo
 * espírito de lib/mcp/tools/catalog.ts.
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface HttpCapabilityCallDescriptor {
  toolName: string;
  callKey: string;
  callLabel: string;
  callOrder: number;
}

export const POUSADA_HTTP_CAPABILITY_CALLS: readonly HttpCapabilityCallDescriptor[] = [
  {
    toolName: "pousada_consultar_disponibilidade",
    callKey: "default",
    callLabel: "Consultar disponibilidade e orçamento",
    callOrder: 0,
  },
  {
    toolName: "pousada_verificar_ou_cadastrar_hospede",
    callKey: "buscar_hospede",
    callLabel: "Buscar hóspede pelo CPF",
    callOrder: 0,
  },
  {
    toolName: "pousada_verificar_ou_cadastrar_hospede",
    callKey: "cadastrar_hospede",
    callLabel: "Cadastrar hóspede novo",
    callOrder: 1,
  },
  {
    toolName: "pousada_criar_reserva",
    callKey: "revalidar_disponibilidade",
    callLabel: "Revalidar disponibilidade (antes de reservar)",
    callOrder: 0,
  },
  {
    toolName: "pousada_criar_reserva",
    callKey: "criar_reserva",
    callLabel: "Criar a reserva",
    callOrder: 1,
  },
  {
    toolName: "pousada_gerar_cobranca_pix",
    callKey: "default",
    callLabel: "Gerar cobrança PIX",
    callOrder: 0,
  },
  {
    toolName: "pousada_consultar_status_reserva",
    callKey: "default",
    callLabel: "Consultar status da reserva",
    callOrder: 0,
  },
] as const;

export function chamadasDaTool(toolName: string): HttpCapabilityCallDescriptor[] {
  return POUSADA_HTTP_CAPABILITY_CALLS.filter((c) => c.toolName === toolName).sort(
    (a, b) => a.callOrder - b.callOrder,
  );
}

/** As tools de pousada que fazem alguma chamada HTTP (elegíveis ao editor). */
export function toolsComChamadaHttp(): string[] {
  return [...new Set(POUSADA_HTTP_CAPABILITY_CALLS.map((c) => c.toolName))];
}

export interface ParamEntradaUrl {
  key: string;
  value: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface MontarUrlFinalInput {
  baseUrl?: string | null;
  endpointPath?: string | null;
  pathParams?: ParamEntradaUrl[];
  queryParams?: ParamEntradaUrl[];
  /** Usado quando a linha não tem base_url/endpoint_path configurados (fallback hardcoded). */
  hardcodedBaseUrl?: string | null;
  hardcodedEndpointPath?: string | null;
}

/**
 * Monta a URL final (para preview na UI e para o executor). Pura e
 * determinística — sem I/O. Retorna null quando não há base URL nenhuma
 * disponível (nem configurada, nem hardcoded).
 */
export function montarUrlFinal(input: MontarUrlFinalInput): string | null {
  const base = input.baseUrl?.trim() || input.hardcodedBaseUrl?.trim() || "";
  if (!base) return null;
  let path = input.endpointPath?.trim() || input.hardcodedEndpointPath?.trim() || "";

  for (const p of input.pathParams ?? []) {
    if (!p.key) continue;
    path = path.replace(
      new RegExp(`\\{${escapeRegExp(p.key)}\\}`, "g"),
      encodeURIComponent(p.value),
    );
  }

  let url: URL;
  try {
    url = new URL(path, base);
  } catch {
    return null;
  }

  for (const q of input.queryParams ?? []) {
    if (!q.key) continue;
    url.searchParams.set(q.key, q.value);
  }

  return url.toString();
}
