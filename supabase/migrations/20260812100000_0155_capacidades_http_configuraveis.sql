-- 0155: capacidades HTTP editáveis pelo painel (estilo node "HTTP Request" do n8n)
--
-- Hoje toda chamada HTTP que uma tool MCP da pousada faz ao PMS (método,
-- endpoint, headers, timeout, TLS, corpo) está hardcoded em
-- lib/mcp/tools/pousada.ts — só a base URL é dinâmica (organizations.settings
-- .pousada.pms_base_url). Esta migration cria a tabela que passa a guardar,
-- por organização, a configuração técnica de cada CHAMADA HTTP física feita
-- por uma capacidade (não por "tool" — duas tools fazem duas chamadas físicas
-- cada, ver call_key abaixo).
--
-- Mesmo padrão de tabela+RLS+view segura de ai_provider_credentials (0023) e
-- mesma infra de cifra at-rest de fn_encrypt_oauth/fn_decrypt_oauth (0041) —
-- nenhuma cifra nova, nenhum secret novo em texto puro.
--
-- Idempotente e portável em psql puro.

create table if not exists public.mcp_http_capability_calls (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- `tool_name` é o `name` de McpToolDefinition (lib/mcp/types.ts). `call_key`
  -- identifica UMA chamada HTTP física dentro da tool — a fonte única dos
  -- valores válidos é lib/pousada/http-capability-calls.ts. A maioria das
  -- tools tem só a chamada 'default'; duas tools fazem duas chamadas cada
  -- (buscar+cadastrar hóspede; revalidar disponibilidade+criar reserva).
  tool_name text not null,
  call_key text not null default 'default',
  call_label text not null,
  call_order smallint not null default 0,

  -- false (ou linha ausente) = comportamento 100% hardcoded de hoje, sem
  -- nenhuma alteração — é o que garante compatibilidade sem depender de
  -- nenhuma organização ter preenchido nada.
  enabled boolean not null default false,

  method text check (method in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
  base_url text,
  endpoint_path text,

  headers jsonb not null default '[]'::jsonb,       -- [{key, value}]
  query_params jsonb not null default '[]'::jsonb,  -- [{key, source:'fixed'|'agent_field', value}]
  path_params jsonb not null default '[]'::jsonb,   -- idem, preenche {placeholders} no endpoint_path

  body_type text not null default 'json' check (body_type in ('json', 'form', 'none')),
  -- Mesmo shape do field_overrides atual (lib/pousada/overrides.ts) — chave
  -- aninhada igual ao corpo, aplicado por deep-merge, SEM reescrever esse
  -- mecanismo já testado em produção.
  legacy_body_overrides jsonb not null default '{}'::jsonb,
  -- Mapeamento novo: [{api_field_path, source:'fixed'|'agent_field', value}],
  -- aplicado DEPOIS do legacy_body_overrides sobre o mesmo objeto.
  body_field_map jsonb not null default '[]'::jsonb,

  -- Só metadado exibido na UI ("esta chamada espera encontrar X em
  -- data.qrCode") — não altera o parsing real da resposta em runtime, que
  -- continua hardcoded no handler (heurísticas de formato do PMS).
  response_field_map jsonb not null default '[]'::jsonb,

  timeout_ms integer check (timeout_ms between 1000 and 120000),
  verify_tls boolean,

  auth_type text not null default 'none'
    check (auth_type in ('none', 'bearer', 'api_key_header', 'api_key_query', 'basic')),
  auth_key_name text,
  auth_secret_enc bytea,
  auth_secret_last4 text,

  -- Config específica da capacidade que não é "chamada HTTP" (ex:
  -- pix_deposit_percent/pix_expiration_seconds só fazem sentido na linha de
  -- pousada_gerar_cobranca_pix).
  specific_config jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),

  constraint mcp_http_capability_calls_unique unique (organization_id, tool_name, call_key)
);

create index if not exists mcp_http_capability_calls_org_tool_idx
  on public.mcp_http_capability_calls (organization_id, tool_name);

alter table public.mcp_http_capability_calls enable row level security;

drop policy if exists tenant_isolation_mcp_http_capability_calls_select on public.mcp_http_capability_calls;
create policy tenant_isolation_mcp_http_capability_calls_select on public.mcp_http_capability_calls
  for select
  using (organization_id in (select * from public.fn_user_org_ids()));

drop policy if exists tenant_isolation_mcp_http_capability_calls_modify on public.mcp_http_capability_calls;
create policy tenant_isolation_mcp_http_capability_calls_modify on public.mcp_http_capability_calls
  for all
  using (organization_id in (select * from public.fn_user_org_ids()))
  with check (organization_id in (select * from public.fn_user_org_ids()));

revoke all on public.mcp_http_capability_calls from anon;

-- View segura: SELECT sem nenhuma coluna de segredo. security_invoker garante
-- que a RLS da tabela base se aplica (mesmo padrão de ai_provider_credentials_safe).
drop view if exists public.mcp_http_capability_calls_safe;
create view public.mcp_http_capability_calls_safe
  with (security_invoker = true)
  as
  select id, organization_id, tool_name, call_key, call_label, call_order, enabled,
         method, base_url, endpoint_path, headers, query_params, path_params,
         body_type, legacy_body_overrides, body_field_map, response_field_map,
         timeout_ms, verify_tls, auth_type, auth_key_name, auth_secret_last4,
         specific_config, created_at, updated_at, created_by
  from public.mcp_http_capability_calls;

revoke all on public.mcp_http_capability_calls_safe from anon;
grant select on public.mcp_http_capability_calls_safe to authenticated;

drop trigger if exists trg_mcp_http_capability_calls_audit on public.mcp_http_capability_calls;
create trigger trg_mcp_http_capability_calls_audit
  after insert or update or delete on public.mcp_http_capability_calls
  for each row execute function public.fn_audit_log_row();

drop trigger if exists trg_mcp_http_capability_calls_updated_at on public.mcp_http_capability_calls;
create trigger trg_mcp_http_capability_calls_updated_at
  before update on public.mcp_http_capability_calls
  for each row execute function public.fn_set_updated_at();

-- =============================================================================
-- Backfill: uma linha por (organização, call_key) para toda org que já tem
-- organizations.settings.pousada preenchido. `enabled` nasce false (o legado
-- em settings.pousada continua sendo lido por lib/pousada/settings.ts como
-- fallback) — é o dono da conta quem liga pela tela nova, deliberadamente.
-- `legacy_body_overrides` é copiado VERBATIM (sem transformação) do
-- field_overrides atual; as duas linhas de disponibilidade
-- (pousada_consultar_disponibilidade e a revalidação dentro de
-- pousada_criar_reserva) recebem o MESMO override de origem, porque hoje
-- código consulta o mesmo settings.fieldOverrides.pousada_consultar_disponibilidade
-- para as duas (lib/mcp/tools/pousada.ts). Idempotente via ON CONFLICT.
-- =============================================================================

do $$
declare
  org record;
  raw jsonb;
  base_url text;
  overrides jsonb;
  disponibilidade_overrides jsonb;
  pix_specific jsonb;
  calls jsonb := '[
    {"tool_name":"pousada_consultar_disponibilidade","call_key":"default","call_label":"Consultar disponibilidade e orçamento","call_order":0,"overrides_key":"pousada_consultar_disponibilidade"},
    {"tool_name":"pousada_verificar_ou_cadastrar_hospede","call_key":"buscar_hospede","call_label":"Buscar hóspede pelo CPF","call_order":0,"overrides_key":null},
    {"tool_name":"pousada_verificar_ou_cadastrar_hospede","call_key":"cadastrar_hospede","call_label":"Cadastrar hóspede novo","call_order":1,"overrides_key":"pousada_verificar_ou_cadastrar_hospede"},
    {"tool_name":"pousada_criar_reserva","call_key":"revalidar_disponibilidade","call_label":"Revalidar disponibilidade (antes de reservar)","call_order":0,"overrides_key":"pousada_consultar_disponibilidade"},
    {"tool_name":"pousada_criar_reserva","call_key":"criar_reserva","call_label":"Criar a reserva","call_order":1,"overrides_key":"pousada_criar_reserva"},
    {"tool_name":"pousada_gerar_cobranca_pix","call_key":"default","call_label":"Gerar cobrança PIX","call_order":0,"overrides_key":"pousada_gerar_cobranca_pix"},
    {"tool_name":"pousada_consultar_status_reserva","call_key":"default","call_label":"Consultar status da reserva","call_order":0,"overrides_key":null}
  ]'::jsonb;
  c jsonb;
  overrides_key text;
begin
  for org in select id, settings from public.organizations where settings ? 'pousada' loop
    raw := org.settings -> 'pousada';
    base_url := nullif(trim(both from (raw ->> 'pms_base_url')), '');
    overrides := coalesce(raw -> 'field_overrides', '{}'::jsonb);
    pix_specific := jsonb_strip_nulls(jsonb_build_object(
      'pix_deposit_percent', raw -> 'pix_deposit_percent',
      'pix_expiration_seconds', raw -> 'pix_expiration_seconds'
    ));

    for c in select * from jsonb_array_elements(calls) loop
      overrides_key := c ->> 'overrides_key';
      insert into public.mcp_http_capability_calls
        (organization_id, tool_name, call_key, call_label, call_order, enabled,
         base_url, legacy_body_overrides, specific_config)
      values (
        org.id,
        c ->> 'tool_name',
        c ->> 'call_key',
        c ->> 'call_label',
        (c ->> 'call_order')::smallint,
        false,
        base_url,
        case when overrides_key is not null then coalesce(overrides -> overrides_key, '{}'::jsonb) else '{}'::jsonb end,
        case when c ->> 'tool_name' = 'pousada_gerar_cobranca_pix' then pix_specific else '{}'::jsonb end
      )
      on conflict (organization_id, tool_name, call_key) do nothing;
    end loop;
  end loop;
end$$;
