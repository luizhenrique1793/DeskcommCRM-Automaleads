-- manifest: Forward-fix do merge upstream × Automaleads (2026-10): a 0387 (canal_datafy, upstream) é a última migration da cadeia a nomear `channel_sessions_provider_check`, `channel_sessions_provider_ref_check` e `webhook_events_log_provider_check`, e foi escrita sem conhecer o provider `uazapi` que a 0565 (ex-0266, Automaleads) já tinha somado — gate `tests/unit/check-do-baseline-nao-diverge-da-cadeia.test.ts` reprovava com "falta: uazapi" nas três. O apêndice do `baseline.sql` já estava correto (bloco único, união dos dois lados); esta migration só traz a CADEIA para o mesmo vocabulário. Alargamento puro nas três, idempotente.
-- 0568: forward-fix do merge upstream × Automaleads (2026-10) — a cadeia de
-- migrations e o apêndice do baseline.sql divergiam em três constraints.
--
-- A 0387 (canal_datafy, upstream) é a última migration da CADEIA a nomear
-- `channel_sessions_provider_check`, `channel_sessions_provider_ref_check` e
-- `webhook_events_log_provider_check` — e foi escrita sem conhecer o 'uazapi'
-- que a 0565 (ex-0266, Automaleads) já tinha somado. O apêndice do
-- baseline.sql JÁ está correto (bloco único, união dos dois lados); esta
-- migration só traz a CADEIA para o mesmo vocabulário, forward-fix, sem tocar
-- nas migrations já aplicadas (0387, 0565, 0566). Achado por
-- `tests/unit/check-do-baseline-nao-diverge-da-cadeia.test.ts`.
--
-- Alargamento puro nas três: nenhuma linha existente passa a violar.
alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_check;
alter table public.channel_sessions
  add constraint channel_sessions_provider_check
  check (provider = any (array['waha'::text, 'meta_cloud'::text, 'zernio'::text, 'uazapi'::text, 'wacalls'::text, 'zernio_social'::text, 'datafy'::text]));

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_ref_check;
alter table public.channel_sessions
  add constraint channel_sessions_provider_ref_check check (
    (provider = 'waha'       and waha_session_name    is not null) or
    (provider = 'meta_cloud' and meta_phone_number_id is not null) or
    (provider in ('zernio', 'zernio_social') and zernio_account_id is not null) or
    (provider = 'uazapi'     and uazapi_instance_id    is not null) or
    (provider = 'wacalls'    and wacalls_session_id    is not null) or
    (provider = 'datafy'     and datafy_phone_number_id is not null)
  );

alter table public.webhook_events_log
  drop constraint if exists webhook_events_log_provider_check;
alter table public.webhook_events_log
  add constraint webhook_events_log_provider_check check (provider in (
    'waha', 'nuvemshop', 'generic', 'meta_cloud', 'zernio', 'uazapi', 'datafy'
  ));
