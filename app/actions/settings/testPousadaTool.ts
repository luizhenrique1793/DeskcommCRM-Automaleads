"use server";

import { randomUUID } from "node:crypto";
import { z } from "zod";

import { createAdminClient } from "@/lib/supabase/admin";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { supportWriteError } from "@/lib/impersonate/support";
import type { McpContext, McpToolDefinition } from "@/lib/mcp/types";
import {
  pousadaConsultarDisponibilidade,
  pousadaVerificarOuCadastrarHospede,
  pousadaCriarReserva,
  pousadaGerarCobrancaPix,
  pousadaConsultarStatusReserva,
  pousadaConsultarDataAtual,
} from "@/lib/mcp/tools/pousada";

/**
 * Painel de teste das tools da pousada — chama o MESMO handler que o agente
 * usa (nada de duplicar lógica), com um ator sintético de teste. Existe pra
 * quem está ajustando a integração poder confirmar um campo/endpoint sem
 * simular uma conversa de WhatsApp inteira.
 *
 * Cast via `unknown` pelo mesmo motivo de `lib/mcp/tools/index.ts`
 * (`allTools`): McpToolDefinition<TInput> não é covariante em TInput, e
 * coletar definições heterogêneas num Record exige apagar o shape no nível
 * do map — a validação real acontece no zod de cada tool, abaixo.
 */
const TOOLS: Record<string, McpToolDefinition> = {
  pousada_consultar_disponibilidade: pousadaConsultarDisponibilidade,
  pousada_verificar_ou_cadastrar_hospede: pousadaVerificarOuCadastrarHospede,
  pousada_criar_reserva: pousadaCriarReserva,
  pousada_gerar_cobranca_pix: pousadaGerarCobrancaPix,
  pousada_consultar_status_reserva: pousadaConsultarStatusReserva,
  pousada_consultar_data_atual: pousadaConsultarDataAtual,
} as unknown as Record<string, McpToolDefinition>;

export type TestPousadaToolResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string; details?: unknown };

export async function testPousadaTool(toolName: string, argsJson: string): Promise<TestPousadaToolResult> {
  const tool = TOOLS[toolName];
  if (!tool) return { ok: false, error: "ferramenta desconhecida" };

  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, error: "unauthenticated" };
  // Este painel EXECUTA a tool de verdade — inclusive `pousada_gerar_cobranca_pix`,
  // que move dinheiro. Sessão de suporte/impersonate não pode disparar isso no
  // tenant de outra pessoa.
  if (supportWriteError(authUser.support)) return { ok: false, error: "forbidden_role" };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false, error: "forbidden_tenant" };
  if (!authUser.is_platform_admin && ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    return { ok: false, error: "forbidden_role" };
  }

  let rawArgs: unknown;
  try {
    rawArgs = argsJson.trim() === "" ? {} : JSON.parse(argsJson);
  } catch {
    return { ok: false, error: "JSON dos argumentos inválido — confira vírgulas e aspas." };
  }

  const parsed = z.object(tool.inputSchema).safeParse(rawArgs);
  if (!parsed.success) {
    return { ok: false, error: "argumentos inválidos", details: parsed.error.flatten() };
  }

  const ctx: McpContext = {
    organizationId: activeOrg.orgId,
    role: "admin",
    actor: { type: "user", id: authUser.id, role: "admin" },
    apiTokenId: "settings-test-panel",
    requestId: randomUUID(),
    supabase: createAdminClient(),
  };

  try {
    const result = await tool.handler(parsed.data, ctx);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
