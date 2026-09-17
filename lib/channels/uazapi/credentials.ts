/**
 * Credenciais do UAZAPI — **por sessão**, com env como fallback.
 *
 * Mesmo desenho de `../zernio/credentials.ts`, e pelo mesmo motivo: duas
 * organizações com instâncias diferentes na mesma instalação é o multi-tenant
 * do `CLAUDE.md` desde o dia 1.
 *
 * ─── Por que `sessionRef` NÃO é o token ──────────────────────────────────────
 *
 * O `token` do UAZAPI é ao mesmo tempo endereço E segredo — é o único header
 * que autentica toda chamada de instância (`token`, ver OpenAPI 2.1.1). Se ele
 * fosse o `sessionRef`, atravessaria `OutboundEnvelope.sessionRef`, apareceria
 * em mensagem de erro, em `echoExternalIds`, em log — todo lugar que hoje
 * passa `sessionRef` sem pensar que pode ser segredo.
 *
 * Por isso o `sessionRef` (e a coluna `uazapi_instance_id` do CHECK) é o `id`
 * da instância — não-secreto, devolvido por `/instance/create` e
 * `/instance/status` — e o `token` fica SÓ aqui, cifrado, atrás de
 * `resolveUazapiCreds`.
 *
 * ─── Por que a busca leva a ORGANIZAÇÃO junto (issue #236) ──────────────────
 * Mesma razão do canal parceiro/intermediado (`../zernio/credentials.ts`):
 * `uazapi_instance_id` é identificador do PROVIDER, duas organizações podem
 * ter a mesma instância por configuração legítima, e `maybeSingle()` com duas
 * linhas devolve `data: null` + `PGRST116` — com o `error` descartado, as duas
 * organizações caem na conta do `.env`. Filtro de aplicação aqui, invariante
 * em `tests/unit/canal-consulta-por-organizacao.test.ts`.
 *
 * ⚠️ DÍVIDA DECLARADA: os outros dois providers (`meta_phone_number_id`,
 * `zernio_account_id`) também têm índice único PARCIAL no banco
 * (`channel_sessions_<provider>_ativo_unique`, migration 0165), que barra a
 * colisão na ORIGEM. `uazapi_instance_id` ainda não tem o equivalente — falta
 * uma migration nova que crie `channel_sessions_uazapi_instance_id_ativo_unique`
 * pelo mesmo desenho (dedupe por `-conflito-<id>` antes do `create unique
 * index`). Este arquivo sozinho impede o vazamento de credencial entre
 * organizações; não impede duas linhas ativas com o mesmo `instance_id`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ARCHIVED_AT, queryTolerantToMissingArchived } from "../archived";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

export interface UazapiCredentials {
  instanceId: string;
  token: string;
  baseUrl: string;
  /** De onde veio — aparece no log de diagnóstico, nunca no payload. */
  source: "session" | "env";
}

/** A chave da busca. `organizationId` NÃO é decoração: ver o cabeçalho. */
export interface UazapiCredsLookup {
  /** Resolvido de fonte confiável (sessão, linha já escopada, token do webhook). */
  organizationId: string;
  /** `channel_sessions.uazapi_instance_id` — o `sessionRef` deste canal. */
  instanceId: string;
}

/**
 * Base do servidor UAZAPI. Explícita e sobrescrevível: o UAZAPI é tipicamente
 * self-hosted junto com o resto do kit (como o WAHA), então não há um host
 * fixo — sem env configurada, não há default utilizável.
 */
export function uazapiBaseUrl(): string | null {
  return process.env.UAZAPI_BASE_URL?.trim() || null;
}

/**
 * Credencial do ambiente. Útil para instalação de instância única (uma
 * organização, um número) sem passar pela tela. `null` quando não configurada
 * — o chamador trata como canal não conectado (noop), nunca como erro.
 */
export function uazapiCredsFromEnv(): UazapiCredentials | null {
  const baseUrl = uazapiBaseUrl();
  const instanceId = process.env.UAZAPI_INSTANCE_ID;
  const token = process.env.UAZAPI_INSTANCE_TOKEN;
  if (!baseUrl || !instanceId || !token) return null;
  return { instanceId, token, baseUrl, source: "env" };
}

/**
 * Credencial gravada na sessão que atende esta instância.
 *
 * `null` significa "esta sessão não tem token gravado" — o chamador cai no
 * env. NÃO significa erro.
 */
export async function uazapiCredsForInstanceId(
  admin: SupabaseClient,
  lookup: UazapiCredsLookup,
): Promise<UazapiCredentials | null> {
  const { organizationId, instanceId } = lookup;
  if (!organizationId || !instanceId) return null;

  // `organization_id` À MÃO (service role bypassa RLS) e `archived_at is null`
  // pelo MESMO recorte que os outros dois providers usam (ver o cabeçalho):
  // fora do recorte não há trava nenhuma alcançando, e a busca deixaria de
  // ser exata exatamente onde ninguém a garante.
  const base = () =>
    admin
      .from("channel_sessions")
      .select("uazapi_instance_id, uazapi_token_encrypted, uazapi_base_url")
      .eq("organization_id", organizationId)
      .eq("uazapi_instance_id", instanceId);
  const { data, error } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).maybeSingle(),
    () => base().maybeSingle(),
  );
  if (error) {
    throw new Error(
      `uazapi_creds_lookup_failed: ${error.code ?? "sem_codigo"} ${error.message ?? ""}`.trim(),
    );
  }

  const cifrado = data?.uazapi_token_encrypted;
  if (!data || !cifrado) return null;

  const token = await decryptWebhookSecret(admin, cifrado as unknown as string);
  // Decifra que falha devolve null: a chave (GUC) pode não estar configurada
  // nesta instalação. Cair no env é melhor que derrubar o envio.
  if (!token) return null;

  const baseUrl = (data.uazapi_base_url as string | null) ?? uazapiBaseUrl();
  if (!baseUrl) return null;

  return { instanceId: data.uazapi_instance_id as string, token, baseUrl, source: "session" };
}

/**
 * A credencial em vigor para esta instância: **sessão primeiro, env como
 * fallback**. Mesma ordem e mesma razão do canal intermediado: com o token
 * gravado na tela, um env esquecido não pode silenciar a configuração.
 */
export async function resolveUazapiCreds(
  admin: SupabaseClient,
  lookup: UazapiCredsLookup,
): Promise<UazapiCredentials | null> {
  return (await uazapiCredsForInstanceId(admin, lookup)) ?? uazapiCredsFromEnv();
}

/**
 * O `uazapi_instance_id` gravado numa sessão, pelo `channel_session_id` — não
 * pelo instance_id (que é o que se quer CONFERIR, não o que se tem em mãos).
 *
 * Existe para o webhook cruzar o `instance` do envelope (`WebhookEvent`)
 * contra a sessão que o `webhook_path_token` já resolveu — ver
 * `../inbound.ts`. Não decifra nada: só lê o ponteiro não-secreto.
 */
export async function uazapiInstanceIdOfSession(
  admin: SupabaseClient,
  channelSessionId: string,
): Promise<string | null> {
  const { data } = await admin
    .from("channel_sessions")
    .select("uazapi_instance_id")
    .eq("id", channelSessionId)
    .maybeSingle();
  return (data?.uazapi_instance_id as string | null) ?? null;
}
