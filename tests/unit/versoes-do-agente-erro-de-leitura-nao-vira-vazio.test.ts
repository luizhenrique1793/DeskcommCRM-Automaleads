import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * A TELA DO AGENTE TEM DE FALHAR ALTO QUANDO NÃO CONSEGUE LER AS VERSÕES —
 * NUNCA FINGIR QUE O AGENTE NÃO TEM VERSÃO NENHUMA.
 *
 * Achado em produção (fork Automaleads): `app/app/ai/agents/[id]/page.tsx`
 * buscava `ai_agent_versions` e fazia `(versionsRes.data ?? [])` sem nunca
 * conferir `versionsRes.error`. Uma falha TRANSITÓRIA desta consulta (lock,
 * timeout, hiccup de conexão) virava, em silêncio, "este agente não tem
 * versão nenhuma" — a tela abria `AgentForm` com `draft`/`published` nulos,
 * que é EXATAMENTE o estado de um agente que nunca teve versão: prompt
 * padrão, `tool_ids: []`, nenhum aviso na tela.
 *
 * O próximo "Salvar" persistia esse `[]` como uma versão nova — e foi assim
 * que o Solzinho (v25, 22 capacidades ligadas: crm_search_knowledge, as 6
 * ferramentas da pousada, crm_request_human_handoff, …) publicou a v26 com
 * ZERO capacidades.
 *
 * Esta cerca não executa a página (é Server Component, com `cookies()`,
 * Supabase e um grafo de dependências que tornaria o teste pesado e frágil
 * pela forma errada de motivo) — mede o TEXTO-FONTE, como outras cercas
 * desta casa (ex.: `rascunho-superado-nao-e-regravado.test.ts`, bloco final).
 * O que se prova é que a conferência de erro existe e vem ANTES do
 * `?? []` que decide "este agente não tem versão" — não o comportamento via
 * execução.
 */

const CAMINHO = "app/app/ai/agents/[id]/page.tsx";

function semComentarios(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("page.tsx do agente — leitura de versões sem erro escondido", () => {
  const fonte = semComentarios(readFileSync(CAMINHO, "utf8"));

  it("confere versionsRes.error antes de decidir 'sem versão'", () => {
    const iQuery = fonte.indexOf('.from("ai_agent_versions")');
    expect(iQuery, "a consulta de ai_agent_versions sumiu ou mudou de forma — sonda cega").toBeGreaterThan(
      -1,
    );
    const iErroCheck = fonte.indexOf("versionsRes.error", iQuery);
    const iFallbackVazio = fonte.indexOf("versionsRes.data ?? []", iQuery);
    expect(iErroCheck, "nenhuma conferência de versionsRes.error encontrada após a consulta").toBeGreaterThan(
      -1,
    );
    expect(iFallbackVazio, "o fallback 'data ?? []' sumiu — a forma do código mudou").toBeGreaterThan(-1);
    expect(
      iErroCheck,
      "o fallback para lista vazia roda ANTES da conferência de erro — uma falha de leitura " +
        "ainda viraria 'este agente não tem versão nenhuma' em silêncio",
    ).toBeLessThan(iFallbackVazio);
  });

  it("lança (não retorna um valor neutro) quando a conferência acusa erro", () => {
    const trecho = fonte.slice(
      fonte.indexOf("if (versionsRes.error)"),
      fonte.indexOf("if (versionsRes.error)") + 300,
    );
    expect(trecho, "o bloco de conferência do erro não lança — voltaria a mascarar a falha").toContain(
      "throw",
    );
  });
});
