-- 0157: webhook_events_log aceita o quarto canal (UAZAPI)
--
-- Espelho idempotente da 0151 (`_0151_arquivo_do_webhook_por_canal.sql`), que
-- já tinha aberto esta constraint para meta_cloud/zernio. Achado em
-- homologação real da 0156: todo POST no webhook genérico do UAZAPI (real ou
-- de teste) derrubava o INSERT em `webhook_events_log` com "violates check
-- constraint webhook_events_log_provider_check" — silencioso
-- (`abrirArquivoDoWebhook` captura e só `logger.warn`, não impede a
-- ingestão), então a mensagem seguia processando normalmente, mas o arquivo
-- do corpo cru — o único instrumento para investigar o que chegou de fato —
-- ficava permanentemente vazio para este canal.
--
-- Alargamento puro: um CHECK que aceita MAIS valores não pode ser violado por
-- linha que já passava pelo antigo, então não precisa de backfill antes. O
-- bloco único desta constraint no baseline (regra da issue #159) é editado
-- em vez de acrescentar um segundo — dois blocos fariam o `update.sh` de um
-- clone com dados falhar no primeiro e deixar a tabela sem constraint entre
-- o `drop` e o `add` que funciona.
alter table public.webhook_events_log
  drop constraint if exists webhook_events_log_provider_check;
alter table public.webhook_events_log
  add constraint webhook_events_log_provider_check check (provider in (
    'waha', 'nuvemshop', 'generic', 'meta_cloud', 'zernio', 'uazapi'
  ));
