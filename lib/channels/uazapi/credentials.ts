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
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

export interface UazapiCredentials {
  instanceId: string;
  token: string;
  baseUrl: string;
  /** De onde veio — aparece no log de diagnóstico, nunca no payload. */
  source: "session" | "env";
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
  instanceId: string,
): Promise<UazapiCredentials | null> {
  if (!instanceId) return null;

  const { data } = await admin
    .from("channel_sessions")
    .select("uazapi_instance_id, uazapi_token_encrypted, uazapi_base_url")
    .eq("uazapi_instance_id", instanceId)
    .maybeSingle();

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
  instanceId: string,
): Promise<UazapiCredentials | null> {
  return (await uazapiCredsForInstanceId(admin, instanceId)) ?? uazapiCredsFromEnv();
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
