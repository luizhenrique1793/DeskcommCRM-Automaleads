/**
 * Capacidades da POUSADA — reservas de hospedagem do Parque Aquático Pôr do
 * Sol. Fala com o sistema de gestão (PMS) próprio da pousada
 * (`POUSADA_PMS_BASE_URL`), que continua sendo a fonte da verdade de
 * quartos, disponibilidade, reservas e cobrança PIX — estas tools só dão ao
 * agente de IA o mesmo acesso que o atendimento humano já tinha.
 *
 * Migrado do fluxo n8n "Agente Mestre PRINCIPAL DE RESERVAS" (ago/2026).
 */
import { declararTools } from "./tipos";

export const TOOLS_POUSADA = declararTools([
  {
    name: "pousada_consultar_disponibilidade",
    category: "read",
    rotulo: "Consultar disponibilidade e orçamento da hospedagem",
    explicacao:
      "Consulta no sistema da pousada se há quarto livre no período pedido e devolve o valor total e o pacote incluso, numa única consulta.",
    oQueToca: "Disponibilidade de quartos",
    risco: "seguro",
    pacotes: ["vender", "atender"],
  },
  {
    name: "pousada_verificar_ou_cadastrar_hospede",
    category: "write",
    rotulo: "Identificar ou cadastrar o hóspede pelo CPF",
    explicacao:
      "Procura o hóspede no sistema da pousada pelo CPF; se ele nunca se hospedou, cadastra um hóspede novo. É o passo antes de criar a reserva.",
    oQueToca: "Cadastro de hóspedes",
    risco: "atencao",
    pacotes: ["vender"],
  },
  {
    name: "pousada_criar_reserva",
    category: "write",
    rotulo: "Criar a pré-reserva no sistema da pousada",
    explicacao:
      "Confere de novo se o quarto ainda está livre (evita reservar algo que já foi ocupado enquanto o cliente decidia) e registra a reserva no sistema da pousada.",
    oQueToca: "Reservas de hospedagem",
    risco: "atencao",
    pacotes: ["vender"],
  },
  {
    name: "pousada_gerar_cobranca_pix",
    category: "write",
    rotulo: "Gerar cobrança PIX da entrada da reserva",
    explicacao:
      "Gera a cobrança PIX de 30% de entrada de uma reserva já criada e devolve o código para o hóspede pagar. Move dinheiro — use só depois da reserva confirmada com o cliente.",
    oQueToca: "Cobrança da reserva",
    risco: "critico",
    pacotes: ["vender"],
  },
  {
    name: "pousada_consultar_status_reserva",
    category: "read",
    rotulo: "Consultar se a reserva já foi paga",
    explicacao:
      "Consulta no sistema da pousada se o PIX de uma reserva já caiu e se ela está confirmada, para responder ao hóspede com o dado real em vez de supor.",
    oQueToca: "Status da reserva",
    risco: "seguro",
    pacotes: ["vender", "atender"],
  },
  {
    name: "pousada_consultar_data_atual",
    category: "read",
    rotulo: "Consultar a data de hoje",
    explicacao:
      "Mostra a data e hora atuais para o assistente calcular certo datas relativas como 'amanhã' ou 'semana que vem'.",
    oQueToca: "Calendário",
    risco: "seguro",
    pacotes: ["vender", "atender"],
  },
]);
