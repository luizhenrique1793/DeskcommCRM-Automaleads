-- 0156: UAZAPI como quarto provider de canal (lib/channels)
--
-- Mesmo padrão de provider por credencial da 0087 (waha/meta_cloud) e da
-- 0131/0132 (zernio): `provider` continua tagged union via CHECK, e a coluna
-- de referência do novo ramo nasce NULLABLE (nenhuma linha existente tem
-- provider='uazapi', então nada a deduplicar antes da constraint).
--
-- `uazapi_instance_id` é o `id` da instância UAZAPI (NÃO-secreto, devolvido
-- por /instance/create e /instance/status) — é o `sessionRef` que atravessa
-- `OutboundEnvelope`, aparece em log e mensagem de erro. O TOKEN da instância
-- (que autentica cada chamada, header `token` da API) é secreto e fica só em
-- `uazapi_token_encrypted`, cifrado por `fn_encrypt_oauth` — resolvido a
-- partir do `instance_id` por `resolveUazapiCreds`
-- (lib/channels/uazapi/credentials.ts). Separar os dois evita que o segredo
-- atravesse qualquer caminho pensado para um identificador não-secreto.
--
-- `uazapi_base_url` é NULLABLE: sem linha, o adapter cai no fallback
-- `UAZAPI_BASE_URL` do ambiente (instalação de instância única, sem tela) —
-- mesma degradação de `zernioBaseUrl()`.
--
-- Os dois CHECKs (`channel_sessions_provider_check`,
-- `channel_sessions_provider_ref_check`) são RECRIADOS com o vocabulário
-- completo — mesma técnica da 0116/0131, porque `drop`+`add` idempotente é
-- portátil em psql puro e um `alter constraint` de CHECK não existe no
-- Postgres para trocar a expressão.
alter table public.channel_sessions
  add column if not exists uazapi_instance_id text,
  add column if not exists uazapi_token_encrypted bytea,
  add column if not exists uazapi_base_url text;

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_check
  check (provider = any (array['waha'::text, 'meta_cloud'::text, 'zernio'::text, 'uazapi'::text]));

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_ref_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_ref_check check (
    (provider = 'waha'       and waha_session_name    is not null) or
    (provider = 'meta_cloud' and meta_phone_number_id is not null) or
    (provider = 'zernio'     and zernio_account_id    is not null) or
    (provider = 'uazapi'     and uazapi_instance_id    is not null)
  );

comment on column public.channel_sessions.uazapi_instance_id is
  'Id da instância UAZAPI (não-secreto, devolvido por /instance/create e /instance/status). Endereça envio e webhook. O token fica só em uazapi_token_encrypted. Espelhado em lib/channels/session-ref.ts.';

comment on column public.channel_sessions.uazapi_token_encrypted is
  'Token da instância UAZAPI, cifrado por fn_encrypt_oauth. Por SESSÃO (não por instalação) — mesma decisão da 0087/0132 para os canais oficial e intermediado.';

comment on column public.channel_sessions.uazapi_base_url is
  'Base do servidor UAZAPI desta instância. NULLABLE: sem linha, resolveUazapiCreds cai no fallback UAZAPI_BASE_URL do ambiente.';
