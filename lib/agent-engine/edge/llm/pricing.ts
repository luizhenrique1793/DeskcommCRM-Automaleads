/**
 * Tabela de preços versionada (stack.md §2: usage × pricing.ts → llm_calls.cost_cents).
 * ÚNICO lugar com preço de modelo no repo.
 *
 * Fonte Anthropic: https://docs.claude.com/en/docs/about-claude/pricing (conferida 2026-07);
 * cache write cotado no TTL 1h (2× input) — o TTL adotado pela doutrina de caching
 * (CLAUDE.md regra 15); cache read = 0.1× input.
 *
 * Fonte OpenAI: espelhado de `ai_models.input_price_per_million_cents` /
 * `output_price_per_million_cents` (migration 0104, conferida 2026-08) — mesma tabela
 * que alimenta o seletor de modelo em /app/ai/providers, para as duas fontes não
 * desalinharem de novo. `ai_models` não tem coluna de preço de cache, então aqui
 * seguimos a convenção padrão de prompt caching da OpenAI: cache read = 0.5× input
 * (desconto de 50%, sem tarifa própria de "escrita" — cachear não tem sobretaxa),
 * cache write = 1× input.
 *
 * Modelo fora da tabela → custo NULL (desconhecido): mais honesto que inventar 0 —
 * o budget soma coalesce(cost_cents, 0), então modelo sem preço não consome teto;
 * quem habilitar um modelo novo para uma org adiciona a linha de preço aqui.
 *
 * IMPORTANTE: ordem dos prefixos importa — o match é o primeiro `model.startsWith(prefix)`
 * que bater, então prefixos mais específicos (ex.: 'gpt-5.4-mini') precisam vir antes
 * dos mais genéricos que os contêm (ex.: 'gpt-5.4', 'gpt-5').
 */

/** USD por MILHÃO de tokens; match por prefixo do id (cobre sufixo de data do vendor). */
const USD_PER_MTOK: Record<string, { input: number; output: number; cacheRead: number; cacheWrite1h: number }> = {
  'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3, cacheWrite1h: 6 },
  'claude-haiku-4': { input: 1, output: 5, cacheRead: 0.1, cacheWrite1h: 2 },
  'claude-opus-4': { input: 15, output: 75, cacheRead: 1.5, cacheWrite1h: 30 },
  'gpt-5.6-terra': { input: 2, output: 12, cacheRead: 1, cacheWrite1h: 2 },
  'gpt-5.6-luna': { input: 0.2, output: 1.2, cacheRead: 0.1, cacheWrite1h: 0.2 },
  'gpt-5.6-sol': { input: 5, output: 30, cacheRead: 2.5, cacheWrite1h: 5 },
  'gpt-5.5-pro': { input: 30, output: 180, cacheRead: 15, cacheWrite1h: 30 },
  'gpt-5.5': { input: 5, output: 30, cacheRead: 2.5, cacheWrite1h: 5 },
  'gpt-5.4-mini': { input: 0.75, output: 4.5, cacheRead: 0.375, cacheWrite1h: 0.75 },
  'gpt-5.4-nano': { input: 0.2, output: 1.25, cacheRead: 0.1, cacheWrite1h: 0.2 },
  'gpt-5.4-pro': { input: 30, output: 180, cacheRead: 15, cacheWrite1h: 30 },
  'gpt-5.4': { input: 2.5, output: 15, cacheRead: 1.25, cacheWrite1h: 2.5 },
  'gpt-5-mini': { input: 1.5, output: 6, cacheRead: 0.75, cacheWrite1h: 1.5 },
  'gpt-4o': { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite1h: 2.5 },
  'gpt-5': { input: 5, output: 40, cacheRead: 2.5, cacheWrite1h: 5 },
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Custo em CENTS (fracionário; coluna numeric) ou null se o modelo não tem preço
 * conhecido. `inputTokens` aqui é o TOTAL do usage do SDK — a parcela cacheada é
 * descontada e cobrada pela tarifa de cache.
 */
export function costCents(model: string, usage: TokenUsage): number | null {
  const priceKey = Object.keys(USD_PER_MTOK).find((prefix) => model.startsWith(prefix));
  if (priceKey === undefined) {
    return null;
  }
  const p = USD_PER_MTOK[priceKey];
  if (p === undefined) {
    return null; // inalcançável (key veio de Object.keys); satisfaz noUncheckedIndexedAccess
  }
  const noCacheInput = Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens);
  const usd =
    (noCacheInput * p.input +
      usage.cacheReadTokens * p.cacheRead +
      usage.cacheWriteTokens * p.cacheWrite1h +
      usage.outputTokens * p.output) /
    1_000_000;
  return usd * 100;
}
