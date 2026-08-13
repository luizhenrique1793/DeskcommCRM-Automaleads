/**
 * Conexão do canal "gateway próprio" (UAZAPI) — do lado de dentro do seam.
 *
 * Mesmo papel de `./connect.ts` para o canal intermediado: a tela e a rota não
 * podem nomear o provider (invariante 1 da doutrina), então este módulo — e só
 * ele — sabe que "gateway" quer dizer UAZAPI. Por isso mora direto em
 * `lib/channels/`, e não em `lib/channels/uazapi/`: um import de
 * `@/lib/channels/gateway` não carrega o nome do provider no CAMINHO, que é
 * exatamente o que `scripts/lint-channels.ts` varre em arquivo fora daqui.
 *
 * ─── Por que este canal não é "conta parceira" ──────────────────────────────
 *
 * `./connect.ts` valida uma CONTA já existente numa plataforma BSP. Este canal
 * é QR/pairing (como o WAHA) com credencial por instância — mais perto do
 * "número por QR" que da "conta parceira". Por isso os campos pedidos são
 * outros (URL do servidor + token da instância, não accountId+apiKey de uma
 * conta oficial), e há um passo a mais que os outros canais não têm: pedir o
 * QR/pairing code e ACOMPANHAR a conexão até `connected` — o token sozinho não
 * basta, porque a instância pode existir e ainda não estar logada num
 * WhatsApp.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ARCHIVED_AT, queryTolerantToMissingArchived } from "./archived";
import { CHANNEL_PROVIDER_UAZAPI } from "./capabilities";
import { resolveUazapiCreds } from "./uazapi/credentials";
import { uazapiClient } from "./uazapi/client";
import { mapUazapiHealthStatus, type CanonicalChannelStatus } from "./uazapi/webhook";
import type { ChannelProvider } from "./types";

export const GATEWAY_CHANNEL_PROVIDER: ChannelProvider = CHANNEL_PROVIDER_UAZAPI;
export const GATEWAY_CHANNEL_LABEL = "UAZAPI";

export interface GatewayCredentialsInput {
  baseUrl: string;
  instanceId: string;
  token: string;
}

export type GatewayValidation =
  | { ok: true; profileName: string | null; ownerJid: string | null }
  | { ok: false; reason: string };

/**
 * A credencial presta? Chama `/instance/status` direto — é o único endpoint
 * que confirma token+id juntos SEM efeito colateral (não inicia conexão nova,
 * diferente de `/instance/connect`).
 */
export async function validateGatewayCredentials(
  input: GatewayCredentialsInput,
): Promise<GatewayValidation> {
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
  const instanceId = input.instanceId.trim();
  const token = input.token.trim();
  if (!baseUrl || !instanceId || !token) {
    return { ok: false, reason: "Informe a URL do servidor, o id da instância e o token." };
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    return { ok: false, reason: "A URL do servidor precisa começar com http:// ou https://." };
  }

  let status: Awaited<ReturnType<typeof uazapiClient.getStatus>>;
  try {
    status = await uazapiClient.getStatus({ baseUrl, instanceId, token, source: "session" });
  } catch {
    return { ok: false, reason: "Não foi possível falar com o servidor UAZAPI. Confira a URL." };
  }
  if (!status) return { ok: false, reason: "Token recusado pelo servidor." };

  return { ok: true, profileName: status.profileName, ownerJid: status.ownerJid };
}

export interface GatewaySession {
  id: string;
  instanceId: string | null;
  baseUrl: string | null;
  phoneNumber: string | null;
  displayName: string | null;
  status: string | null;
  webhookPathToken: string | null;
  hasToken: boolean;
  archivedAt: string | null;
}

const COLUNAS =
  "id, uazapi_instance_id, uazapi_base_url, phone_number, display_name, status, webhook_path_token, uazapi_token_encrypted";

function toGatewaySession(row: Record<string, unknown> | null): GatewaySession | null {
  if (!row) return null;
  return {
    id: row.id as string,
    instanceId: (row.uazapi_instance_id as string) ?? null,
    baseUrl: (row.uazapi_base_url as string) ?? null,
    phoneNumber: (row.phone_number as string) ?? null,
    displayName: (row.display_name as string) ?? null,
    status: (row.status as string) ?? null,
    webhookPathToken: (row.webhook_path_token as string) ?? null,
    hasToken: !!row.uazapi_token_encrypted,
    archivedAt: (row.archived_at as string) ?? null,
  };
}

export async function findGatewaySession(
  admin: SupabaseClient,
  organizationId: string,
): Promise<GatewaySession | null> {
  const buscar = (colunas: string) =>
    admin
      .from("channel_sessions")
      .select(colunas)
      .eq("organization_id", organizationId)
      .eq("provider", GATEWAY_CHANNEL_PROVIDER)
      .maybeSingle();

  const { data } = await queryTolerantToMissingArchived(
    () => buscar(`${COLUNAS}, ${ARCHIVED_AT}`),
    () => buscar(COLUNAS),
  );
  return toGatewaySession(data as Record<string, unknown> | null);
}

/**
 * Grava (ou ressuscita) a sessão. `archived_at: null` sempre, mesma razão do
 * canal intermediado: reconectar por cima de um canal excluído precisa trazê-
 * lo de volta visível para webhook, envio e seletores.
 *
 * `status` NÃO é parâmetro — de propósito. A primeira versão aceitava um
 * `status: string` do chamador, e a rota gravava `"connecting"` (vocabulário
 * do UAZAPI, minúsculo) direto na coluna: `channel_sessions_status_check` só
 * aceita `STARTING | SCAN_QR_CODE | WORKING | STOPPED | FAILED`, e o INSERT
 * derrubava com violação de CHECK — medido em homologação. Toda sessão nasce
 * (ou renasce, numa reconexão) em `STARTING`: acabou de ser criada, ainda não
 * perguntamos nada ao transporte. Quem quiser um status mais preciso pede
 * `getGatewayLiveStatus` depois — nunca escreve um palpite aqui.
 */
export async function saveGatewaySession(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    existingId: string | null;
    instanceId: string;
    baseUrl: string;
    tokenEncrypted: string;
    webhookPathToken: string;
    webhookSecretEncrypted: string;
    phoneNumber: string | null;
    displayName: string;
  },
): Promise<{ error: string | null }> {
  const linha = {
    organization_id: input.organizationId,
    provider: GATEWAY_CHANNEL_PROVIDER,
    uazapi_instance_id: input.instanceId,
    uazapi_base_url: input.baseUrl,
    uazapi_token_encrypted: input.tokenEncrypted,
    webhook_path_token: input.webhookPathToken,
    // NOT NULL na tabela, mas sem uso de verificação para este provider (o
    // UAZAPI não assina webhook — ver `./uazapi/webhook.ts`). Gerado só para
    // satisfazer a coluna compartilhada; nenhum código lê este valor de volta.
    webhook_secret_encrypted: input.webhookSecretEncrypted,
    phone_number: input.phoneNumber,
    display_name: input.displayName,
    status: "STARTING" satisfies CanonicalChannelStatus,
    archived_at: null,
  };

  const { error } = input.existingId
    ? await admin.from("channel_sessions").update(linha).eq("id", input.existingId)
    : await admin.from("channel_sessions").insert(linha);

  return { error: error?.message ?? null };
}

// ---------------------------------------------------------------------------
// Operações de transporte — a rota (`app/api/v1/channels/gateway/*`) NÃO pode
// importar `./uazapi/client` nem `./uazapi/credentials` direto: isso seria a
// segunda camada paralela que a doutrina proíbe (mesmo defeito do
// `partner/route.ts` antigo, que o `lint:channels` reprovou na primeira
// versão). Toda chamada de transporte passa por aqui.
// ---------------------------------------------------------------------------

/** O que a tela mostra do estado ao vivo — QR/pairing atual, sem vocabulário do provider. */
export interface GatewayLiveStatus {
  status: string;
  qrcode: string | null;
  paircode: string | null;
  profileName: string | null;
}

/**
 * O estado AO VIVO da instância — não o que a última escrita gravou. É o que
 * faz o operador ver o QR mudar sem recarregar a página.
 *
 * `null` quando não há credencial (sessão sem token, env ausente) OU quando o
 * servidor recusou o token — os dois casos são "não deu para confirmar", e
 * quem chama decide o que mostrar.
 */
export async function getGatewayLiveStatus(
  admin: SupabaseClient,
  instanceId: string,
): Promise<GatewayLiveStatus | null> {
  const creds = await resolveUazapiCreds(admin, instanceId);
  if (!creds) return null;
  const status = await uazapiClient.getStatus(creds);
  if (!status) return null;
  return {
    status: status.status,
    qrcode: status.qrcode,
    paircode: status.paircode,
    profileName: status.profileName,
  };
}

/**
 * Registra a URL genérica do canal (`/api/v1/webhooks/channel/[token]`) no
 * servidor UAZAPI. `false` quando não há credencial ou o registro falhou —
 * best-effort: a sessão já foi gravada, e o vigia de saúde avisa se o canal
 * ficar mudo depois.
 */
export async function registerGatewayWebhook(
  admin: SupabaseClient,
  instanceId: string,
  url: string,
): Promise<boolean> {
  const creds = await resolveUazapiCreds(admin, instanceId);
  if (!creds) return false;
  return uazapiClient.setWebhook(creds, url).catch(() => false);
}

/**
 * Inicia a conexão — QR sem `phone`, código de pareamento com `phone`.
 * Best-effort: o chamador não trava a gravação da sessão por causa disto,
 * o operador tenta de novo pela tela se falhar.
 */
export async function startGatewayConnection(
  admin: SupabaseClient,
  instanceId: string,
  phone: string | null,
): Promise<void> {
  const creds = await resolveUazapiCreds(admin, instanceId);
  if (!creds) return;
  await uazapiClient.connect(creds, phone).catch(() => {});
}

/**
 * Encerra a sessão do WhatsApp SEM apagar a conexão (linha e token
 * continuam). `false` quando não há credencial para desconectar.
 *
 * Grava o status CANÔNICO aqui dentro — mesma razão de `saveGatewaySession`
 * não aceitar `status` de fora: o chamador não escolhe a palavra, o mapper
 * escolhe. `/instance/disconnect` sempre resulta em `disconnected` do lado do
 * UAZAPI (não precisa perguntar de novo); `mapUazapiHealthStatus` traduz isso
 * para `STOPPED`.
 */
export async function disconnectGateway(
  admin: SupabaseClient,
  instanceId: string,
  channelSessionId: string,
): Promise<boolean> {
  const creds = await resolveUazapiCreds(admin, instanceId);
  if (!creds) return false;
  await uazapiClient.disconnect(creds);
  const status: CanonicalChannelStatus = mapUazapiHealthStatus("disconnected");
  await admin.from("channel_sessions").update({ status }).eq("id", channelSessionId);
  return true;
}
