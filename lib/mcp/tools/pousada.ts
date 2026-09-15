/**
 * Capacidades da POUSADA — reservas de hospedagem do Parque Aquático Pôr do Sol.
 *
 * Migrado do fluxo n8n "Agente Mestre PRINCIPAL DE RESERVAS" (ago/2026): o
 * PMS proprietário da pousada (`POUSADA_PMS_BASE_URL`) continua sendo a fonte
 * da verdade de quartos/disponibilidade/reservas/PIX — estas tools só dão ao
 * agente de IA o mesmo acesso HTTP que o n8n tinha. O que muda é onde a
 * reserva fica visível para humanos: cada reserva criada também vira um card
 * no pipeline "Reservas" (crm_leads), então a equipe acompanha pelo Kanban.
 *
 * O PMS não tem autenticação própria (rede fechada + headers fixos simulando
 * o front-end oficial — herdado do n8n original, não é invenção daqui) e usa
 * certificado autoassinado, por isso `rejectUnauthorized: false` em pmsRequest.
 *
 * Service role bypassa RLS: TODA query filtra `organization_id` manualmente, e a
 * fonte é sempre `ctx.organizationId` (token/cookie), NUNCA o input.
 */
import { z } from "zod";

import { createLeadHandler } from "@/app/api/v1/leads/_handler";
import { createLeadSchema } from "@/lib/schemas/leads";
import { unwrapPmsObject, extrairId, formatarTelefoneBR } from "@/lib/pousada/pms-client";
import { loadPousadaSettings } from "@/lib/pousada/settings";
import { executarChamadaPousada } from "@/lib/pousada/executor";
import { getAdapter, resolveSessionRef, CHANNEL_SESSION_REF_COLUMNS } from "@/lib/channels";
import type { ChannelProvider, ChannelSessionRef } from "@/lib/channels";
import type { McpContext, McpToolDefinition } from "../types";

/**
 * CPF só com dígito verificador batendo — antes disso qualquer coisa que
 * "parecesse" CPF (`00000000000`, `11111111111`, 11 dígitos aleatórios)
 * passava pro PMS e virava cadastro de hóspede com CPF falso. Achado
 * revisando as 3 tools que recebem CPF (hospede/reserva/PIX) — nenhuma delas
 * valida o dígito, só o formato (`^\d{11}$`).
 */
function cpfValido(cpf: string): boolean {
  if (!/^\d{11}$/.test(cpf)) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false; // todos os dígitos iguais — formato válido, CPF nunca é
  const digitos = cpf.split("").map(Number);
  const calcularDigito = (fatorInicial: number): number => {
    let soma = 0;
    for (let i = 0; i < fatorInicial - 1; i++) soma += digitos[i]! * (fatorInicial - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  return calcularDigito(10) === digitos[9] && calcularDigito(11) === digitos[10];
}

const CPF_MSG = "CPF inválido (dígito verificador não confere) — confirme o número com o hóspede.";
const cpfSchema = z.string().regex(/^\d{11}$/).refine(cpfValido, { message: CPF_MSG });

/**
 * O PMS responde HTTP 200 com `idDoQuarto` preenchido mesmo quando não há
 * pacote/tarifa cadastrada pro período (visto ao vivo: agosto/2026 devolve
 * `valorTotal: 0` e `descricaoPacotes: "Pacote não encontrado"`, enquanto
 * dezembro/2026 devolve um valor e nome de pacote reais). Sem esta checagem a
 * tool diria "disponível, total R$ 0,00" — a pousada não configurou preço pro
 * período, o que não é a mesma coisa que "sem quarto livre", mas também não
 * pode virar orçamento real pro hóspede.
 */
function pacoteValido(valorTotal: number, descricaoPacotes: string): boolean {
  return (
    valorTotal > 0 && descricaoPacotes.trim() !== "" && !/não encontrado/i.test(descricaoPacotes)
  );
}

/** Pipeline "Reservas" (slug fixo, seedado na criação da organização) + etapa por slug. */
async function localizarEtapaReservas(
  supabase: McpContext["supabase"],
  organizationId: string,
  stageSlug: string,
): Promise<{ pipelineId: string; stageId: string }> {
  const { data: pipeline, error: pErr } = await supabase
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("slug", "reservas")
    .maybeSingle();
  if (pErr) throw new Error(`pipeline_reservas_erro: ${pErr.message}`);
  if (!pipeline) {
    throw new Error(
      "pipeline_reservas_nao_encontrado: crie o pipeline 'Reservas' (slug reservas) para esta organização antes de usar esta tool.",
    );
  }
  const { data: stage, error: sErr } = await supabase
    .from("crm_stages")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("pipeline_id", (pipeline as { id: string }).id)
    .eq("slug", stageSlug)
    .maybeSingle();
  if (sErr) throw new Error(`etapa_reservas_erro: ${sErr.message}`);
  if (!stage) throw new Error(`etapa_${stageSlug}_nao_encontrada`);
  return { pipelineId: (pipeline as { id: string }).id, stageId: (stage as { id: string }).id };
}

// ---------------------------------------------------------------------------
// pousada_consultar_disponibilidade
// ---------------------------------------------------------------------------

const disponibilidadeInputShape = {
  checkin: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("Data de entrada, formato YYYY-MM-DD."),
  checkout: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("Data de saída, formato YYYY-MM-DD."),
  quantidade_adultos: z.number().int().min(0).describe("Pessoas com 13 anos ou mais."),
  quantidade_criancas: z.number().int().min(0).describe("Crianças de 0 a 10 anos."),
  quantidade_11_12: z.number().int().min(0).describe("Crianças de 11 a 12 anos."),
};

export const pousadaConsultarDisponibilidade: McpToolDefinition<typeof disponibilidadeInputShape> =
  {
    name: "pousada_consultar_disponibilidade",
    description:
      "Consulta disponibilidade de quartos no sistema da pousada para o período informado, e devolve numa única " +
      "chamada o quarto selecionado, o valor total e o pacote incluso. Chame uma única vez por combinação de " +
      "checkin/checkout/quantidades — não repita a consulta se nada mudou.",
    inputSchema: disponibilidadeInputShape,
    category: "read",
    requiresRole: "agent",
    requiresScope: "mcp:read",
    handler: async (input, ctx) => {
      const totalPessoas =
        input.quantidade_adultos + input.quantidade_criancas + input.quantidade_11_12;
      if (totalPessoas <= 0) {
        return {
          disponivel: false,
          mensagem: "Informe ao menos um hóspede para consultar disponibilidade.",
        };
      }
      const settings = await loadPousadaSettings(ctx.supabase, ctx.organizationId);
      const corpoDisponibilidade = {
        DataDeEntrada: input.checkin,
        DataDeSaida: input.checkout,
        TotalPessoas: totalPessoas,
        quantidadeAdultos: input.quantidade_adultos,
        quantidadeCriancas: input.quantidade_criancas,
        quantidade11_12: input.quantidade_11_12,
        IDDoUsuario: 1,
      };
      const raw = await executarChamadaPousada({
        supabase: ctx.supabase,
        organizationId: ctx.organizationId,
        toolName: "pousada_consultar_disponibilidade",
        callKey: "default",
        method: "POST",
        path: "/api/quartos/BuscarQuartosSemReservasEntreDatas",
        baseUrl: settings.pmsBaseUrl,
        body: corpoDisponibilidade,
        input,
      });
      const data = unwrapPmsObject(raw);
      const quartos = Array.isArray(data.quartos) ? (data.quartos as unknown[]) : [];
      const idDoQuarto = Number(data.idDoQuarto ?? data.selecaoQuartoIa ?? 0);
      if (!quartos.length || !idDoQuarto) {
        return {
          disponivel: false,
          mensagem: "Não encontramos disponibilidade para o período informado.",
        };
      }
      const valorTotal = Number(data.valorTotal ?? 0);
      const pacote = String(data.descricaoPacotes ?? "");
      if (!pacoteValido(valorTotal, pacote)) {
        return {
          disponivel: false,
          mensagem:
            "Há quarto livre, mas ainda não temos tarifa cadastrada para esse período. Peça pra falar com a recepção ou tente outra data.",
        };
      }
      return {
        disponivel: true,
        quarto_id: idDoQuarto,
        numero_quarto: Number(data.numeroDoQuarto ?? 0) || null,
        valor_total: valorTotal,
        pacote,
      };
    },
  };

// ---------------------------------------------------------------------------
// pousada_verificar_ou_cadastrar_hospede
// ---------------------------------------------------------------------------

const hospedeInputShape = {
  cpf: cpfSchema.describe("CPF do titular da reserva, só dígitos (11 números)."),
  nome: z.string().min(2).describe("Nome completo do titular."),
  // Zod .email() usa lookahead negativo no regex padrão (`(?!\.)`, `(?!.*\.\.)`)
  // para barrar ponto duplicado/inicial — a Anthropic aceita esse regex no JSON
  // Schema da tool, mas a validação da OpenAI recusa lookaround com "Invalid
  // JSON schema: regex lookaround is not supported", e o agent_turn inteiro
  // morre pra QUALQUER org (esta tool está no catálogo fixo de todas, não só
  // de quem usa o nicho pousada). Regex sem lookaround, permissivo o bastante
  // pro caso de uso (campo opcional, validação de tool call).
  email: z
    .string()
    .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)
    .optional()
    .describe("E-mail do titular, se informado."),
  data_nascimento: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("Data de nascimento, formato YYYY-MM-DD."),
  telefone: z
    .string()
    .min(8)
    .describe("Telefone do titular com DDI, ex: 5511999998888 (use o número do WhatsApp)."),
};

export const pousadaVerificarOuCadastrarHospede: McpToolDefinition<typeof hospedeInputShape> = {
  name: "pousada_verificar_ou_cadastrar_hospede",
  description:
    "Procura o titular da reserva pelo CPF no sistema da pousada; se ele nunca se hospedou, cadastra um hóspede " +
    "novo. Devolve id_titular — guarde esse valor, ele é necessário para criar a reserva.",
  inputSchema: hospedeInputShape,
  category: "write",
  // Sem equivalente humano na tela (ninguém cadastra hóspede do PMS clicando
  // no CRM) — não entra na exceção de "trabalho de atendente", então o piso é
  // ai_operator (ver tests/unit/capacidade-alcancavel-pelo-agente.test.ts).
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const settings = await loadPousadaSettings(ctx.supabase, ctx.organizationId);
    // Confirmado ao vivo com o dono do PMS (2026-08-18): este endpoint é POST
    // com corpo JSON (`Documento`/`TipoReserva`, maiúsculos), NÃO GET com
    // query string — a versão anterior (herdada do fluxo n8n, mas transcrita
    // errado aqui) sempre batia 404 e mandava a tool achar QUALQUER hóspede
    // "não encontrado", cadastrando duplicado a cada conversa nova do mesmo
    // hóspede. "Não encontrado" nesta API é HTTP 200 com `jaExistia:false` e
    // `id:0` — não HTTP 404. O catch abaixo continua existindo por segurança
    // (rede fora do ar, 5xx), mas não é mais o caminho normal de "não achei".
    let busca: Record<string, unknown> = {};
    try {
      busca = unwrapPmsObject(
        await executarChamadaPousada({
          supabase: ctx.supabase,
          organizationId: ctx.organizationId,
          toolName: "pousada_verificar_ou_cadastrar_hospede",
          callKey: "buscar_hospede",
          method: "POST",
          path: "/api/hospedes/buscaPorDocumentoTitular",
          baseUrl: settings.pmsBaseUrl,
          body: { Documento: input.cpf, TipoReserva: "RESERVA" },
          input,
        }),
      );
    } catch (err) {
      if (!(err instanceof Error) || !/pms_http_404/.test(err.message)) throw err;
    }
    const jaExistia = busca.jaExistia === true;
    const idBusca = extrairId(busca, "id");
    // proteção contra o PMS devolver o próprio CPF ou um id vazio como "encontrado".
    const idBuscaValido =
      idBusca && idBusca !== "0" && idBusca !== input.cpf && idBusca.length !== 11;

    if (jaExistia && idBuscaValido) {
      return {
        status: "found" as const,
        id_titular: idBusca,
        nome: String(busca.nome ?? input.nome),
        email: busca.email ? String(busca.email) : null,
        data_nascimento: busca.data_nascimento
          ? String(busca.data_nascimento)
          : input.data_nascimento,
        telefone: busca.telefone ? String(busca.telefone) : formatarTelefoneBR(input.telefone),
        bloqueio: Boolean(busca.bloqueio),
      };
    }

    const telefoneFmt = formatarTelefoneBR(input.telefone);
    const corpoCadastro = {
      nome: input.nome.toUpperCase(),
      cpfCnpj: input.cpf,
      rg: null,
      passaporte: null,
      dataNascimento: input.data_nascimento,
      email: input.email?.trim() || null,
      telefone: telefoneFmt,
      titular: true,
    };
    const criado = unwrapPmsObject(
      await executarChamadaPousada({
        supabase: ctx.supabase,
        organizationId: ctx.organizationId,
        toolName: "pousada_verificar_ou_cadastrar_hospede",
        callKey: "cadastrar_hospede",
        method: "POST",
        path: "/api/hospedes/CadastrarHospede",
        baseUrl: settings.pmsBaseUrl,
        body: corpoCadastro,
        input,
      }),
    );
    const idCriado = extrairId(criado, "id");
    if (!idCriado) {
      throw new Error(
        "cadastro_hospede_falhou: o sistema da pousada não retornou o id do hóspede cadastrado",
      );
    }
    return {
      status: "created" as const,
      id_titular: idCriado,
      nome: input.nome,
      email: input.email ?? null,
      data_nascimento: input.data_nascimento,
      telefone: telefoneFmt,
      bloqueio: false,
    };
  },
};

// ---------------------------------------------------------------------------
// pousada_criar_reserva
// ---------------------------------------------------------------------------

const criarReservaInputShape = {
  checkin: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  checkout: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  quantidade_adultos: z.number().int().min(0),
  quantidade_criancas: z.number().int().min(0),
  quantidade_11_12: z.number().int().min(0),
  id_titular: z
    .string()
    .min(1)
    .describe("id_titular devolvido por pousada_verificar_ou_cadastrar_hospede."),
  titular_nome: z.string().min(2),
  cpf_titular: cpfSchema,
  total_cotado: z
    .number()
    .positive()
    .describe("Valor total apresentado ao hóspede em pousada_consultar_disponibilidade (reais)."),
  pacote_cotado: z.string().min(1),
  contact_id: z
    .string()
    .uuid()
    .optional()
    .describe("Contato do CRM a vincular ao card da reserva, se conhecido."),
};

export const pousadaCriarReserva: McpToolDefinition<typeof criarReservaInputShape> = {
  name: "pousada_criar_reserva",
  description:
    "Cria a pré-reserva no sistema da pousada. Revalida a disponibilidade e seleciona o quarto NO MOMENTO da " +
    "criação (nunca reusa um quarto de uma cotação anterior), para não reservar algo que já não está mais livre. " +
    "Ao criar com sucesso, também abre o card da reserva no funil do CRM. Chame só depois que o hóspede confirmar " +
    "que quer a pré-reserva e você já tiver id_titular.",
  inputSchema: criarReservaInputShape,
  category: "write",
  // Sem equivalente humano na tela — mesma régua de pousada_verificar_ou_cadastrar_hospede.
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const idTitular = input.id_titular.replace(/\D/g, "");
    if (
      !idTitular ||
      idTitular === "0" ||
      idTitular === input.cpf_titular ||
      idTitular.length === 11
    ) {
      return {
        ok: false,
        erro: "id_titular_invalido",
        mensagem:
          "Não foi possível identificar o cadastro interno do titular. Verifique ou fale com a recepção.",
      };
    }

    // Trava de duplicidade: hoje só existe uma instrução no PROMPT pedindo pro
    // modelo não criar reserva repetida — frágil (o modelo pode reformular a
    // pergunta do hóspede e concluir que é um pedido novo, ou reprocessar após
    // timeout). Aqui é código, não sugestão: mesmo titular + mesmas datas nas
    // últimas 6h já vira reserva no PMS, e um duplicado real também duplica
    // COBRANÇA — o hóspede recebendo dois PIX pra pagar a mesma estadia é pior
    // do que a tool recusar e o agente perguntar antes de tentar de novo.
    const { data: possivelDuplicata } = await ctx.supabase
      .from("crm_leads")
      .select("id, custom_fields")
      .eq("organization_id", ctx.organizationId)
      .contains("custom_fields", {
        cpf_titular: input.cpf_titular,
        checkin: input.checkin,
        checkout: input.checkout,
      })
      .gte("created_at", new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString())
      .limit(1)
      .maybeSingle();
    if (possivelDuplicata) {
      const reservaExistente = (possivelDuplicata.custom_fields as Record<string, unknown> | null)
        ?.pms_reserva_id;
      return {
        ok: false,
        erro: "reserva_possivelmente_duplicada",
        reserva_id_existente: reservaExistente ? String(reservaExistente) : null,
        mensagem:
          "Já existe uma reserva recente (últimas 6h) para este mesmo hóspede e período — confirme com " +
          "ele se já reservou antes de criar outra. Se for engano do sistema, peça pra recepção verificar.",
      };
    }

    const settings = await loadPousadaSettings(ctx.supabase, ctx.organizationId);
    const totalPessoas =
      input.quantidade_adultos + input.quantidade_criancas + input.quantidade_11_12;
    // Mesma chamada física de pousada_consultar_disponibilidade, mas é uma
    // linha própria e editável na aba Capacidades (call_key
    // "revalidar_disponibilidade") — pode divergir da outra se editada
    // separadamente; o editor tem um botão "copiar desta capacidade" pra isso.
    const corpoRevalidacao = {
      DataDeEntrada: input.checkin,
      DataDeSaida: input.checkout,
      TotalPessoas: totalPessoas,
      quantidadeAdultos: input.quantidade_adultos,
      quantidadeCriancas: input.quantidade_criancas,
      quantidade11_12: input.quantidade_11_12,
      IDDoUsuario: 1,
    };
    const dispRaw = await executarChamadaPousada({
      supabase: ctx.supabase,
      organizationId: ctx.organizationId,
      toolName: "pousada_criar_reserva",
      callKey: "revalidar_disponibilidade",
      method: "POST",
      path: "/api/quartos/BuscarQuartosSemReservasEntreDatas",
      baseUrl: settings.pmsBaseUrl,
      body: corpoRevalidacao,
      input,
    });
    const disp = unwrapPmsObject(dispRaw);
    const quartos = Array.isArray(disp.quartos)
      ? (disp.quartos as Array<Record<string, unknown>>)
      : [];
    const idDoQuarto = Number(disp.idDoQuarto ?? disp.selecaoQuartoIa ?? 0);

    if (!quartos.length) {
      return {
        ok: false,
        erro: "sem_quartos_disponiveis",
        mensagem: "Não encontramos quartos disponíveis para esse período.",
      };
    }
    if (!idDoQuarto || !quartos.some((q) => Number(q.id) === idDoQuarto)) {
      return {
        ok: false,
        erro: "quarto_fora_da_lista_disponivel",
        mensagem:
          "O quarto cotado não está mais disponível. Consulte a disponibilidade de novo antes de tentar a reserva.",
      };
    }
    if (!pacoteValido(Number(disp.valorTotal ?? 0), String(disp.descricaoPacotes ?? ""))) {
      return {
        ok: false,
        erro: "tarifa_nao_disponivel",
        mensagem:
          "Não há mais tarifa cadastrada para esse período — não é possível confirmar a reserva agora.",
      };
    }
    const numeroDoQuarto = Number(disp.numeroDoQuarto ?? 0);

    const corpoReserva = {
      reserva: {
        valorBruto: String(input.total_cotado),
        valorDeAcrescimo: "0",
        valorDoDesconto: "0",
        valorLiquido: String(input.total_cotado),
        dataDeEntrada: `${input.checkin}T12:00:00.000Z`,
        dataDeSaida: `${input.checkout}T12:00:00.000Z`,
        status: "Reservado",
        tipo: "Familia",
        idUsuario: 1,
        idTitular: Number(idTitular),
        QuantidadeAdultosSELEC: input.quantidade_adultos,
        QuantidadeCriancas1112SELEC: input.quantidade_11_12,
        QuantidadeCriancasSELEC: input.quantidade_criancas,
        QuantidadeDeAdultos: String(input.quantidade_adultos),
        QuantidadeDeCriancas: String(input.quantidade_criancas),
        QuantidadeDeCriancas_11_12: String(input.quantidade_11_12),
        observacao: "Reserva via atendimento automático (DeskcommCRM)",
        descricaoPacotes: input.pacote_cotado,
      },
      pacotes: [{}],
      quartoHospede: [
        {
          idDoQuarto,
          hospedes: [
            {
              id: Number(idTitular),
              nome: input.titular_nome,
              dataNascimento: "0001-01-01T00:00:00.000Z",
              tipoDeDocumento: "CPF",
              tipoDocumentoDaHospedagem: "CPF",
              cpf: input.cpf_titular,
              rg: null,
              passaporte: null,
              certidao: null,
              titular: 1,
            },
          ],
        },
      ],
    };
    const reservaRaw = await executarChamadaPousada({
      supabase: ctx.supabase,
      organizationId: ctx.organizationId,
      toolName: "pousada_criar_reserva",
      callKey: "criar_reserva",
      method: "POST",
      path: "/api/reservas/AddReserva",
      baseUrl: settings.pmsBaseUrl,
      body: corpoReserva,
      input,
    });

    const reservaId = extrairId(reservaRaw, "idReserva", "reserva_id", "id", "response", "data");
    if (!reservaId) {
      return {
        ok: false,
        erro: "reserva_nao_criada",
        mensagem:
          "A reserva não foi criada — o sistema da pousada não retornou o número da reserva.",
      };
    }

    let leadId: string | null = null;
    try {
      const { pipelineId, stageId } = await localizarEtapaReservas(
        ctx.supabase,
        ctx.organizationId,
        "aguardando-pagamento",
      );
      const parsed = createLeadSchema.parse({
        pipeline_id: pipelineId,
        stage_id: stageId,
        title: `Reserva #${reservaId} — ${input.titular_nome}`,
        contact_id: input.contact_id ?? null,
        value_cents: Math.round(input.total_cotado * 100),
        currency: "BRL",
        source: "ai_agent",
        tags: ["hospedagem"],
      });
      const lead = await createLeadHandler(
        ctx.supabase,
        { organization_id: ctx.organizationId, actor: ctx.actor, requestId: ctx.requestId },
        {
          ...parsed,
          custom_fields: {
            checkin: input.checkin,
            checkout: input.checkout,
            // Grava pra trava de duplicidade (acima nesta mesma função) conseguir
            // comparar reserva nova × reservas recentes deste titular.
            cpf_titular: input.cpf_titular,
            quantidade_adultos: input.quantidade_adultos,
            quantidade_criancas: input.quantidade_criancas,
            quantidade_11_12: input.quantidade_11_12,
            pacote: input.pacote_cotado,
            pms_reserva_id: reservaId,
            pms_quarto_id: idDoQuarto,
            numero_quarto: numeroDoQuarto || null,
            pix_status: null,
          },
        },
      );
      leadId = (lead as { id?: string }).id ?? null;
    } catch (err) {
      // A reserva JÁ FOI criada no PMS — não falhar a tool por causa do card do
      // CRM. O card fica pendente de criação manual; o número da reserva (fonte
      // da verdade) já volta pro agente e pro hóspede normalmente.
      console.error(
        "[pousada_criar_reserva] falha ao criar card no CRM (reserva já existe no PMS):",
        err,
      );
    }

    return {
      ok: true,
      status: "reserva_criada" as const,
      reserva_id: reservaId,
      lead_id: leadId,
      quarto_id: idDoQuarto,
      numero_quarto: numeroDoQuarto || null,
      total: input.total_cotado,
      pacote: input.pacote_cotado,
    };
  },
};

// ---------------------------------------------------------------------------
// pousada_gerar_cobranca_pix
// ---------------------------------------------------------------------------

const gerarPixInputShape = {
  reserva_id: z.string().min(1).describe("Número da reserva devolvido por pousada_criar_reserva."),
  nome_cliente: z.string().min(2),
  cpf_cliente: cpfSchema.describe("CPF do titular, só dígitos."),
};

export const pousadaGerarCobrancaPix: McpToolDefinition<typeof gerarPixInputShape> = {
  name: "pousada_gerar_cobranca_pix",
  description:
    "Gera a cobrança PIX da reserva já criada e devolve o código copia-e-cola. TEMPORÁRIO (PSP Cielo, " +
    "ago/2026): a cobrança é do VALOR INTEGRAL da reserva, não de uma entrada parcial — o valor devolvido " +
    "em valor_pix é sempre o que veio da tool, nunca invente ou recalcule. IMPORTANTE: ao repassar o " +
    "código PIX ao hóspede, mande-o em uma mensagem própria, exatamente como veio, sem " +
    "negrito/markdown/formatação — qualquer alteração no texto invalida o código.",
  inputSchema: gerarPixInputShape,
  category: "write",
  // Sem equivalente humano na tela — mesma régua das outras duas escritas da pousada.
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const settings = await loadPousadaSettings(ctx.supabase, ctx.organizationId);
    const reservaIdDigits = input.reserva_id.replace(/\D/g, "");
    const { data: lead, error } = await ctx.supabase
      .from("crm_leads")
      .select("id, value_cents, custom_fields")
      .eq("organization_id", ctx.organizationId)
      .contains("custom_fields", { pms_reserva_id: reservaIdDigits })
      .maybeSingle();
    if (error) throw new Error(`buscar_reserva_falhou: ${error.message}`);
    if (!lead) {
      return {
        ok: false,
        erro: "reserva_nao_encontrada",
        mensagem:
          "Não encontrei essa reserva no CRM. Confira o número ou crie a reserva antes de gerar o PIX.",
      };
    }
    const valorTotalCents = Number((lead as { value_cents: number | null }).value_cents ?? 0);
    if (valorTotalCents <= 0) {
      return {
        ok: false,
        erro: "valor_reserva_invalido",
        mensagem: "Reserva sem valor registrado — não é possível calcular a entrada.",
      };
    }
    // A pousada trocou de PSP para Cielo (ago/2026) — rota nova é /api/Cielo/GerarCobrancaPix,
    // e ela NÃO aceita `valor`/`expiracaoSegundos`: cobra o valor cheio da reserva e define a
    // expiração sozinha. Enquanto o dev da pousada não devolve suporte a valor parcial (entrada
    // de X%) nesse endpoint, não tem como cobrar só a entrada por aqui — por isso não computamos
    // mais `entradaCents` pra mandar no corpo. Confiamos no que a Cielo devolver (`pix.valor`,
    // `pix.dataExpiracao`) em vez de prever o valor/prazo aqui, pra continuar correto assim que
    // o suporte a parcial voltar do lado deles, sem precisar mexer neste arquivo de novo.
    const corpoPix = {
      descricao: `Reserva #${reservaIdDigits} — Parque Aquático Pôr do Sol`,
      nomeCliente: input.nome_cliente,
      cpfCnpjCliente: input.cpf_cliente,
      empresaGeralId: 1,
      ReservaId: Number(reservaIdDigits),
    };
    const pixRaw = await executarChamadaPousada({
      supabase: ctx.supabase,
      organizationId: ctx.organizationId,
      toolName: "pousada_gerar_cobranca_pix",
      callKey: "default",
      method: "POST",
      path: "/api/Cielo/GerarCobrancaPix",
      baseUrl: settings.pmsBaseUrl,
      body: corpoPix,
      input,
    });
    const pix = unwrapPmsObject(pixRaw);
    const qrCode = String(pix.qrCode ?? pix.qrcode ?? pix.copiaECola ?? pix.pix ?? "");
    if (!qrCode) {
      return {
        ok: false,
        erro: "pix_nao_gerado",
        mensagem:
          "O sistema da pousada não retornou o código PIX. Tente novamente ou fale com a recepção.",
      };
    }
    const valorPix = Number(pix.valor ?? valorTotalCents / 100);
    const expiraEm = pix.dataExpiracao
      ? new Date(String(pix.dataExpiracao)).toISOString()
      : new Date(Date.now() + settings.pixExpirationSeconds * 1000).toISOString();

    const customFields = {
      ...((lead as { custom_fields: Record<string, unknown> }).custom_fields ?? {}),
    };
    customFields.pix_status = "pending";
    customFields.pix_valor_cents = Math.round(valorPix * 100);
    customFields.pix_expira_em = expiraEm;
    customFields.pix_txid = pix.paymentId ? String(pix.paymentId) : null;
    const { error: updErr } = await ctx.supabase
      .from("crm_leads")
      .update({ custom_fields: customFields, updated_at: new Date().toISOString() })
      .eq("organization_id", ctx.organizationId)
      .eq("id", (lead as { id: string }).id);
    if (updErr) console.error("[pousada_gerar_cobranca_pix] falha ao marcar pix pendente:", updErr);

    return {
      ok: true,
      qr_code: qrCode,
      valor_pix: valorPix,
      valor_e_integral: true,
      expira_em: expiraEm,
      instrucao: "Envie qr_code numa mensagem própria, sem formatação nenhuma.",
    };
  },
};

// ---------------------------------------------------------------------------
// pousada_enviar_botao_copiar_pix
// ---------------------------------------------------------------------------

const enviarBotaoPixInputShape = {
  conversation_id: z
    .string()
    .uuid()
    .describe("A mesma conversa em que você já mandou o qr_code em texto."),
  codigo_pix: z
    .string()
    .min(10)
    .describe("O MESMO qr_code que pousada_gerar_cobranca_pix devolveu, sem nenhuma alteração."),
};

/**
 * Botão de "copiar código" como mensagem EXTRA, fora da tabela `messages` de
 * propósito (não entra no histórico do CRM nem nos crons de retry) — ver o
 * doc de `ChannelAdapter.sendButtonCopy`. Falha aqui NUNCA é motivo pra
 * avisar o hóspede que algo deu errado: o código já foi entregue em texto
 * antes desta tool ser chamada (regra dura do PIX), isto é só conveniência.
 */
export const pousadaEnviarBotaoCopiarPix: McpToolDefinition<typeof enviarBotaoPixInputShape> = {
  name: "pousada_enviar_botao_copiar_pix",
  description:
    "Manda uma mensagem EXTRA com um botão de 'copiar código' pro código PIX. Chame isto DEPOIS de já " +
    "ter mandado o qr_code em texto puro, numa mensagem própria (regra do PIX não muda) — este botão é só " +
    "um toque a mais de conveniência, nunca o único jeito de entregar o código. Se o canal não suportar ou " +
    "o envio falhar, a tool devolve enviado=false; nesse caso não fale sobre nenhum botão pro cliente.",
  inputSchema: enviarBotaoPixInputShape,
  category: "write",
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const { data: conversa, error: convErr } = await ctx.supabase
      .from("conversations")
      .select("contact_id, channel_session_id, is_group, group_chat_id")
      .eq("organization_id", ctx.organizationId)
      .eq("id", input.conversation_id)
      .maybeSingle();
    if (convErr) throw new Error(`buscar_conversa_falhou: ${convErr.message}`);
    if (!conversa) {
      console.error("[pousada_enviar_botao_copiar_pix] conversa_nao_encontrada", input.conversation_id);
      return { enviado: false, motivo: "conversa_nao_encontrada" };
    }
    const cv = conversa as {
      contact_id: string;
      channel_session_id: string;
      is_group: boolean;
      group_chat_id: string | null;
    };

    const { data: contato, error: ctErr } = await ctx.supabase
      .from("contacts")
      .select("phone_number, wa_identity, wa_lid")
      .eq("organization_id", ctx.organizationId)
      .eq("id", cv.contact_id)
      .maybeSingle();
    if (ctErr) throw new Error(`buscar_contato_falhou: ${ctErr.message}`);
    if (!contato) {
      console.error("[pousada_enviar_botao_copiar_pix] contato_nao_encontrado", cv.contact_id);
      return { enviado: false, motivo: "contato_nao_encontrado" };
    }
    const ct = contato as { phone_number: string | null; wa_identity: string | null; wa_lid: string | null };

    const { data: sessao, error: csErr } = await ctx.supabase
      .from("channel_sessions")
      .select(CHANNEL_SESSION_REF_COLUMNS)
      .eq("organization_id", ctx.organizationId)
      .eq("id", cv.channel_session_id)
      .maybeSingle();
    if (csErr) throw new Error(`buscar_canal_falhou: ${csErr.message}`);
    if (!sessao) {
      console.error("[pousada_enviar_botao_copiar_pix] canal_nao_encontrado", cv.channel_session_id);
      return { enviado: false, motivo: "canal_nao_encontrado" };
    }
    const cs = sessao as unknown as ChannelSessionRef;

    const adapter = getAdapter(cs.provider as ChannelProvider);
    if (!adapter.sendButtonCopy) {
      console.error("[pousada_enviar_botao_copiar_pix] canal_sem_suporte_a_botao", cs.provider);
      return { enviado: false, motivo: "canal_sem_suporte_a_botao" };
    }

    const to = adapter.resolveRecipient({
      isGroup: cv.is_group,
      groupChatId: cv.group_chat_id,
      phoneNumber: ct.phone_number,
      waIdentity: ct.wa_identity,
      waLid: ct.wa_lid,
    });
    if (to === null) {
      console.error("[pousada_enviar_botao_copiar_pix] destinatario_nao_resolvivel", cv.contact_id);
      return { enviado: false, motivo: "destinatario_nao_resolvivel" };
    }

    const enviado = await adapter.sendButtonCopy({
      sessionRef: resolveSessionRef(cs),
      to,
      text: "Toque para copiar o código PIX:",
      buttonLabel: "Copiar código PIX",
      copyValue: input.codigo_pix,
    });
    console.error("[pousada_enviar_botao_copiar_pix] resultado", { enviado, conversation_id: input.conversation_id });

    return { enviado };
  },
};

// ---------------------------------------------------------------------------
// pousada_consultar_status_reserva
// ---------------------------------------------------------------------------

const statusReservaInputShape = {
  reserva_id: z.string().min(1),
};

export const pousadaConsultarStatusReserva: McpToolDefinition<typeof statusReservaInputShape> = {
  name: "pousada_consultar_status_reserva",
  description:
    "Consulta no sistema da pousada se uma reserva já foi confirmada (PIX pago) ou ainda está aguardando " +
    "pagamento. Use quando o hóspede perguntar se a reserva/pagamento caiu, nunca invente o status.",
  inputSchema: statusReservaInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const settings = await loadPousadaSettings(ctx.supabase, ctx.organizationId);
    const idDigits = input.reserva_id.replace(/\D/g, "");
    let raw: unknown;
    try {
      // Confirmado ao vivo com o dono do PMS (2026-08-18), mesma classe do bug
      // de buscaPorDocumentoTitular: este endpoint é POST com corpo JSON
      // (`IdReserva` numérico), não GET com query string — a versão GET nunca
      // funcionou (sempre 404, com ou sem token). Exige `X-Api-Key` (401 sem
      // ele), configurado na aba Capacidades → Autenticação, não em código.
      raw = await executarChamadaPousada({
        supabase: ctx.supabase,
        organizationId: ctx.organizationId,
        toolName: "pousada_consultar_status_reserva",
        callKey: "default",
        method: "POST",
        path: "/api/Reservas/BuscarStatus",
        baseUrl: settings.pmsBaseUrl,
        body: { IdReserva: Number(idDigits) },
        input,
      });
    } catch (err) {
      // O PMS responde 404 pra reserva_id inexistente/errado — informação de
      // negócio comum (número digitado errado), não uma falha do sistema.
      if (err instanceof Error && /pms_http_404/.test(err.message)) {
        return {
          status: "não encontrada",
          confirmada: false,
          mensagem:
            "Não encontrei nenhuma reserva com esse número. Confira o número com o hóspede.",
        };
      }
      throw err;
    }
    const status = typeof raw === "string" ? raw : String(unwrapPmsObject(raw).status ?? raw ?? "");
    // "reserva confirmada" nunca foi visto vindo do PMS de verdade — o único
    // exemplo real capturado até agora (reserva sem pagamento) devolve
    // status:"Reservado". Sem um exemplo real de reserva PAGA, não dá pra
    // saber a string exata que o PMS usa pra "confirmada" (pode ser
    // "Confirmada", "Pago", outra coisa) — perguntar ao dev em vez de adivinhar.
    return {
      status,
      confirmada: status.trim().toLowerCase() === "reserva confirmada",
    };
  },
};

// ---------------------------------------------------------------------------
// pousada_consultar_data_atual
// ---------------------------------------------------------------------------

const dataAtualInputShape = {};

const MESES_PT = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];

export const pousadaConsultarDataAtual: McpToolDefinition<typeof dataAtualInputShape> = {
  name: "pousada_consultar_data_atual",
  description:
    "Devolve a data e hora atuais (fuso de Brasília). Chame sempre que o hóspede usar uma data relativa " +
    "('amanhã', 'esse fim de semana', 'semana que vem') antes de calcular checkin/checkout — nunca chute o ano " +
    "ou a data de hoje a partir de memória.",
  inputSchema: dataAtualInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async () => {
    const agora = new Date();
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const partes = fmt.formatToParts(agora).reduce<Record<string, string>>((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});
    const hoje = `${partes.year}-${partes.month}-${partes.day}`;
    const diaSemana = new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      weekday: "long",
    }).format(agora);
    const diaMes = Number(partes.day);
    const mesNome = MESES_PT[Number(partes.month) - 1];
    return {
      hoje,
      hoje_por_extenso: `${diaSemana}, ${diaMes} de ${mesNome} de ${partes.year}`,
      fuso: "America/Sao_Paulo",
    };
  },
};
