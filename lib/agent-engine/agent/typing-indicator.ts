/**
 * "Digitando…" no início do turno — puramente cosmético, NUNCA bloqueia nem
 * derruba o turno. Ver `ChannelAdapter.sendTyping` (lib/channels/types.ts)
 * para o contrato; aqui só resolve quem é o destinatário e chama.
 *
 * Isolado do resto de inbound-turn.ts pelo mesmo motivo de split-message.ts/
 * aux-model-args.ts: função pequena o bastante pra testar sem montar
 * job/queue inteiros, e o call site em runAgentTurn fica em poucas linhas.
 *
 * Regra dura nº 4 (message-plane não fala com o canal direto) NÃO se aplica
 * aqui — presença não é status de sessão (isso continua vindo só do espelho
 * durável do watchdog), é uma chamada de ENVIO cosmética, mesma classe de
 * `adapter.send`/`adapter.saveContact`, que também falam com o transporte.
 */
import type pg from 'pg';

import { getAdapter, resolveSessionRef, CHANNEL_SESSION_REF_COLUMNS } from '@/lib/channels';
import type { ChannelSessionRef } from '@/lib/channels';
import type { Logger } from '../obs/logger';

/**
 * Teto curto de propósito. Testado em produção em 2026-08-18 com 120_000: o
 * "auto-cancela ao enviar mensagem" de um dos canais não é instantâneo — a
 * renovação periódica do lado deles pode não pegar o cancelamento a tempo, e o
 * indicador reaparece sozinho minutos depois de a resposta já ter saído (sem
 * nada pra cancelar contra). 30s é o teto de ÚLTIMO RECURSO — o caminho
 * normal agora é `cancelarDigitando` (chamado por runAgentTurn nos 3 pontos
 * onde o turno termina SEM mandar mensagem: handoff, opt-out, e "acabou e não
 * mandou nada"), que cancela na hora via `presence: "paused"`. Este teto só
 * entra em jogo se `cancelarDigitando` também falhar (rede caiu, etc.).
 */
const TYPING_DURATION_MS = 30_000;

/**
 * As colunas de identidade do canal vêm de `ChannelSessionRef` (lib/channels)
 * — nenhum nome de provider nasce aqui, só o resto que a query precisa.
 */
type ConversaParaDigitandoRow = {
  is_group: boolean;
  group_chat_id: string | null;
  phone_number: string | null;
  wa_identity: string | null;
  wa_lid: string | null;
} & ChannelSessionRef;

async function resolverDestinoDigitando(
  pool: pg.Pool,
  tenantId: string,
  conversationId: string,
): Promise<{ sessionRef: string; to: string; sendTyping: NonNullable<ReturnType<typeof getAdapter>['sendTyping']> } | null> {
  const { rows } = await pool.query<ConversaParaDigitandoRow>(
    `select cv.is_group, cv.group_chat_id,
            ct.phone_number, ct.wa_identity, ct.wa_lid,
            ${CHANNEL_SESSION_REF_COLUMNS.split(', ').map((c) => `cs.${c}`).join(', ')}
     from conversations cv
     join contacts ct on ct.id = cv.contact_id
     join channel_sessions cs on cs.id = cv.channel_session_id
     where cv.organization_id = $1 and cv.id = $2`,
    [tenantId, conversationId],
  );
  const r = rows[0];
  if (r === undefined) return null;

  const adapter = getAdapter(r.provider);
  if (!adapter.sendTyping) return null; // canal não suporta — noop silencioso, não é erro

  const to = adapter.resolveRecipient({
    isGroup: r.is_group,
    groupChatId: r.group_chat_id,
    phoneNumber: r.phone_number,
    waIdentity: r.wa_identity,
    waLid: r.wa_lid,
  });
  if (to === null) return null; // grupo, ou contato sem endereço resolvível — mesmo tratamento do envio real

  return { sessionRef: resolveSessionRef(r), to, sendTyping: adapter.sendTyping };
}

/**
 * Dispara o indicador de presença, se o canal suportar — chamada
 * fire-and-forget de propósito: `runAgentTurn` NUNCA `await`s isto no
 * caminho crítico. Toda falha (canal sem o método, sem destinatário
 * resolvível, erro de rede, credencial ausente) é engolida aqui e vira, no
 * pior caso, um log — nunca uma exceção que o chamador precise tratar.
 */
export async function dispararDigitando(
  pool: pg.Pool,
  tenantId: string,
  conversationId: string,
  log: Logger,
): Promise<void> {
  try {
    const destino = await resolverDestinoDigitando(pool, tenantId, conversationId);
    if (destino === null) return;
    await destino.sendTyping({
      organizationId: tenantId,
      sessionRef: destino.sessionRef,
      to: destino.to,
      presence: 'composing',
      durationMs: TYPING_DURATION_MS,
    });
  } catch (err) {
    // Best-effort: o turno segue normalmente sem o indicador.
    log.warn('digitando: não consegui disparar (turno segue normalmente)', {
      error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
    });
  }
}

/**
 * Cancela o indicador ANTES do teto de `TYPING_DURATION_MS` — chamado por
 * runAgentTurn nos pontos onde o turno termina sem mandar mensagem nenhuma
 * (handoff, opt-out, "processou e não mandou nada"), depois de já ter
 * chamado `dispararDigitando`. Mesmo tratamento de erro: best-effort, nunca
 * lança, o turno já terminou de qualquer forma.
 */
export async function cancelarDigitando(
  pool: pg.Pool,
  tenantId: string,
  conversationId: string,
  log: Logger,
): Promise<void> {
  try {
    const destino = await resolverDestinoDigitando(pool, tenantId, conversationId);
    if (destino === null) return;
    await destino.sendTyping({
      organizationId: tenantId,
      sessionRef: destino.sessionRef,
      to: destino.to,
      presence: 'paused',
    });
  } catch (err) {
    log.warn('digitando: não consegui cancelar (some sozinho no teto)', {
      error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
    });
  }
}
