/**
 * Entrada de webhook, do lado de dentro do seam.
 *
 * A rota não pode saber QUAL canal é — o invariante 1 da doutrina proíbe, e o
 * `lint:channels` reprovou a primeira versão desta rota exatamente por isso,
 * que é a catraca funcionando. Então a rota entrega o que sabe (a sessão, o
 * corpo cru, o header de assinatura) e recebe um desfecho; toda a decisão
 * específica de canal mora aqui.
 *
 * Um canal seguinte entra com um `case` neste arquivo e zero linhas na rota.
 *
 * ─── Por que a assinatura é verificada AQUI, e não na rota ──────────────────
 *
 * Porque o esquema é do canal: header, algoritmo e formato mudam por provider
 * (um assina SHA-512 com um nome de header, outro SHA-256 com outro). Uma rota
 * que verificasse teria que perguntar de quem é o payload — o `if (provider ===
 * ...)` que a doutrina existe para impedir.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

import { CHANNEL_PROVIDER_UAZAPI, CHANNEL_PROVIDER_ZERNIO } from "./capabilities";
import { sincronizarSaudeDaConexao } from "./health";
import { uazapiInstanceIdOfSession } from "./uazapi/credentials";
import { ingestUazapiInbound } from "./uazapi/ingest";
import {
  mapUazapiHealthStatus,
  parseUazapiConnection,
  parseUazapiEnvelope,
  parseUazapiMessage,
  parseUazapiStatus,
} from "./uazapi/webhook";
import {
  atualizarEspelhoDoTemplate,
  avisoDoEvento,
  registrarAviso,
  saudeDoEvento,
} from "./zernio/avisos";
import { aplicarEdicaoZernio, ingestZernioInbound } from "./zernio/ingest";
import { parseZernioEdicao, verifyZernioSignature } from "./zernio/webhook";
import type { ChannelProvider } from "./types";

/** Curto demais para ser segredo — placeholder ou lixo de decrypt. */
const MIN_SECRET_LEN = 16;

export interface InboundWebhookInput {
  session: {
    id: string;
    organization_id: string;
    provider: string;
    /** Como o operador chama esta conexão. Entra no título do aviso: com dois
     *  números ligados, "WhatsApp fora do ar" não diz QUAL. */
    display_name?: string | null;
    phone_number?: string | null;
  };
  rawBody: string;
  /** Todos os headers da requisição — cada canal lê o SEU. */
  headers: Headers;
  /** Segredo já decifrado pela rota, ou null quando não foi possível. */
  secret: string | null;
}

export type InboundWebhookOutcome =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; code: "unauthorized" | "provider_mismatch" | "invalid_json"; message: string };

/**
 * Este canal sabe receber webhook? Perguntado pela rota ANTES de qualquer
 * trabalho — e respondido sem nomear provider do lado de fora.
 */
export function acceptsInboundWebhook(provider: string): boolean {
  return provider === CHANNEL_PROVIDER_ZERNIO || provider === CHANNEL_PROVIDER_UAZAPI;
}

export async function handleInboundWebhook(
  admin: SupabaseClient,
  input: InboundWebhookInput,
): Promise<InboundWebhookOutcome> {
  const provider = input.session.provider as ChannelProvider;

  switch (provider) {
    case CHANNEL_PROVIDER_ZERNIO:
      return zernioInbound(admin, input);
    case CHANNEL_PROVIDER_UAZAPI:
      return uazapiInbound(admin, input);
    default:
      // Token de um canal que não entra por aqui. É configuração trocada, não
      // ataque — mas processar seria ler o payload com o parser errado.
      return { ok: false, code: "provider_mismatch", message: "canal não recebe por esta rota" };
  }
}

async function zernioInbound(
  admin: SupabaseClient,
  input: InboundWebhookInput,
): Promise<InboundWebhookOutcome> {
  // Fail-closed, sem a exceção que virou regra no canal por QR: lá, "não
  // consegui verificar" virava "processa assim mesmo", e isso deixou toda
  // instalação aceitando mensagem forjada de quem soubesse a URL. Este provider
  // assina sempre, então não há dilema a herdar.
  if (!input.secret || input.secret.length < MIN_SECRET_LEN) {
    return { ok: false, code: "unauthorized", message: "webhook_secret_unavailable" };
  }

  const assinatura = input.headers.get("x-zernio-signature");
  if (!verifyZernioSignature(input.rawBody, assinatura, input.secret)) {
    return { ok: false, code: "unauthorized", message: "bad_signature" };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody);
  } catch {
    return { ok: false, code: "invalid_json", message: "invalid_json" };
  }

  // ─── O que a plataforma decide sozinha ───────────────────────────────────
  //
  // Revisão de modelo e mudança de estado do número não são mensagens, mas são
  // o tipo de coisa que só se descobre no disparo que não sai — com a campanha
  // montada e o cliente esperando. Vira aviso na Central, onde o humano já
  // procura o que está errado.
  const aviso = avisoDoEvento(payload);
  if (aviso) {
    // O espelho local também: o aviso empurra para olhar, e a tela de modelos
    // precisa mostrar o estado novo. Ver o estado velho depois de ler o aviso é
    // pior que não ter avisado.
    const espelhado = await atualizarEspelhoDoTemplate(admin, input.session.organization_id, payload);

    // ─── Evento de CONEXÃO passa pelo vigia, não por um insert cru ──────────
    //
    // `sincronizarSaudeDaConexao` é quem grava o episódio, carimba
    // `ref_kind`+`ref_id` no ítem e — a metade que faltava — RESOLVE o aviso
    // quando a conta volta. Chamando `registrarAviso` direto, o crítico ficava
    // aberto para sempre e a reconexão abria um `info` novo ao lado dele.
    //
    // Um caminho só: quem entra aqui NÃO passa também pelo insert cru, senão a
    // Central mostraria o mesmo problema duas vezes.
    const saude = saudeDoEvento(payload);
    if (saude) {
      const desfecho = await sincronizarSaudeDaConexao(
        admin,
        // O `status` que vai para `channel_session_health` é o OBSERVADO agora,
        // não o guardado: quem acabou de falar foi o provedor, e a linha do
        // episódio serve justamente para registrar o que ele disse.
        { id: input.session.id, organization_id: input.session.organization_id, status: saude.status },
        saude,
        // O APELIDO da conexão, não o texto do evento. Passar `aviso.title` aqui
        // produzia `WhatsApp "Número SUSPENSO — não é possível enviar." fora do
        // ar (FAILED)`: título quebrado que não identifica a conexão — exatamente
        // o que o apelido existe para resolver. E fica gravado na linha.
        input.session.display_name ?? input.session.phone_number ?? "sem nome",
        // Empurrão do provedor: ele é a autoridade sobre o estado do NÚMERO, e
        // por isso a varredura não fecha o que ele abriu.
        "empurrao",
      );
      return { ok: true, body: { status: "saude", kind: aviso.kind, desfecho, espelhado } };
    }

    const desfecho = await registrarAviso(admin, input.session.organization_id, aviso);
    return { ok: true, body: { status: "aviso", kind: aviso.kind, desfecho, espelhado } };
  }

  // ─── Edição e apagamento ────────────────────────────────────────────────
  //
  // Vêm ANTES da ingestão, como os avisos: são correções de linha que já
  // existe, não mensagens novas. Deixá-los cair no `ingest` faria uma edição
  // criar uma conversa do nada, com um texto sem nada antes dele.
  const edicao = parseZernioEdicao(payload);
  if (edicao) {
    const desfecho = await aplicarEdicaoZernio(admin, input.session.organization_id, edicao);
    return { ok: true, body: { status: "edicao", tipo: edicao.tipo, desfecho } };
  }

  const r = await ingestZernioInbound(admin, {
    organizationId: input.session.organization_id,
    channelSessionId: input.session.id,
    payload,
  });
  return { ok: true, body: { ...r } };
}

/**
 * Sem verificação de assinatura: o UAZAPI não assina o corpo do webhook (ver
 * cabeçalho de `./uazapi/webhook.ts`) — a segurança deste canal é só o
 * `webhook_path_token` que já resolveu esta sessão exata antes de chegar
 * aqui. `input.secret` fica sem uso de propósito, não por esquecimento.
 *
 * ─── O cruzamento de instância ───────────────────────────────────────────────
 *
 * O token já resolve a sessão CERTA — mas o campo `instance` do envelope
 * (`WebhookEvent.instance` no OpenAPI 2.1.1) é uma segunda afirmação de QUEM
 * mandou o evento, e comparar as duas é defesa em profundidade: um token
 * vazado ou um servidor UAZAPI mal configurado servindo duas instâncias no
 * mesmo endereço não teria mais nenhuma barreira sem isto.
 *
 * Regra de fallback, documentada aqui por ser a ÚNICA vez que esta decisão é
 * tomada: a comparação só REJEITA quando os DOIS lados têm valor e DIVERGEM.
 * Se o payload não trouxer `instance` (o schema o marca `required`, mas nada
 * garante que toda instalação de UAZAPI honre isso) OU se a sessão não tiver
 * `uazapi_instance_id` gravado (não deveria acontecer — a constraint do banco
 * exige — mas um clone com dado velho é sempre possível), a checagem não roda
 * e o evento segue pelo caminho normal. Recusar por um dado AUSENTE derrubaria
 * mensagem legítima por um instrumento a menos, não por sinal de ataque.
 */
async function uazapiInbound(
  admin: SupabaseClient,
  input: InboundWebhookInput,
): Promise<InboundWebhookOutcome> {
  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody);
  } catch {
    return { ok: false, code: "invalid_json", message: "invalid_json" };
  }

  const env = parseUazapiEnvelope(payload);
  if (!env) return { ok: true, body: { status: "ignored", reason: "evento_sem_interesse" } };

  if (env.instance) {
    const instanciaDaSessao = await uazapiInstanceIdOfSession(admin, input.session.id);
    if (instanciaDaSessao && env.instance !== instanciaDaSessao) {
      // Diagnóstico SEM segredo: os dois lados são o `instance_id`, que é o
      // ponteiro não-secreto (o token nunca chega até aqui). Não ingere, não
      // cria contato, não mexe em `channel_session_health` — a resposta ao
      // chamador não repete os ids, só o motivo genérico.
      logger.warn("[uazapi] instance do envelope não bate com a sessão resolvida pelo token", {
        channel_session_id: input.session.id,
        instance_esperada: instanciaDaSessao,
        instance_recebida: env.instance,
      });
      return { ok: false, code: "unauthorized", message: "instance_mismatch" };
    }
  }

  const conexao = parseUazapiConnection(env);
  if (conexao) {
    // Traduzido pelo MESMO mapper do adapter antes de sair daqui — nunca o
    // vocabulário cru do UAZAPI (`connected`/`disconnected`/...). Sem isto,
    // `avisoDaConexao` (que compara contra `STATUS_SAUDAVEL`/
    // `STATUS_QUE_AVISAM`, ambos no vocabulário canônico) não reconhecia
    // "CONNECTED"/"DISCONNECTED" em maiúsculas e ficava mudo — nem alertava
    // nem confirmava saúde, silenciosamente, para todo empurrão real.
    const statusCanonico = mapUazapiHealthStatus(conexao.status);
    const desfecho = await sincronizarSaudeDaConexao(
      admin,
      { id: input.session.id, organization_id: input.session.organization_id, status: statusCanonico },
      { reachable: true, status: statusCanonico, detail: null },
      input.session.display_name ?? input.session.phone_number ?? "sem nome",
      "empurrao",
    );
    return { ok: true, body: { status: "conexao", desfecho } };
  }

  const status = parseUazapiStatus(env);
  const msg = status ?? parseUazapiMessage(env);
  if (!msg) return { ok: true, body: { status: "ignored", reason: "evento_sem_interesse" } };

  const r = await ingestUazapiInbound(admin, {
    organizationId: input.session.organization_id,
    channelSessionId: input.session.id,
    msg,
  });
  return { ok: true, body: { ...r } };
}
