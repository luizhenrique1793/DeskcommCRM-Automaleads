-- 0269: RBAC faltando em mcp_http_capability_calls (0265)
--
-- A 0265 criou a tabela com policy `ALL` só de tenancy — qualquer papel do
-- tenant (inclusive viewer) conseguia ler e ESCREVER config de chamada HTTP
-- de capacidade (inclusive credencial cifrada de PMS de terceiro), mesmo com
-- a API já gating GET em manager+ e PUT em admin
-- (app/api/v1/ai/capability-http-configs/route.ts) — a RLS não acompanhava
-- o app, e RLS é a última linha de defesa contra quem fala direto com o
-- PostgREST. Pego pelo invariante 0150 (tests/invariants/rbac-config-ia-canais
-- .test.ts, "nenhuma tabela NOVA entra com policy ALL só-tenancy"), o mesmo
-- gate que pegou ai_provider_credentials e as outras 7 da 0150.
--
-- Mesmo padrão da 0150: SELECT em manager+ (espelha o GET da API),
-- INSERT/UPDATE/DELETE em admin+ (espelha o PUT). fn_role_at_least já é
-- hierárquico (admin passa no manager+), então não precisa de policy dupla.
--
-- Idempotente e portável em psql puro.

drop policy if exists tenant_isolation_mcp_http_capability_calls_select on public.mcp_http_capability_calls;
create policy tenant_isolation_mcp_http_capability_calls_select on public.mcp_http_capability_calls
  for select
  using (
    organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager')
  );

drop policy if exists tenant_isolation_mcp_http_capability_calls_modify on public.mcp_http_capability_calls;
drop policy if exists tenant_isolation_mcp_http_capability_calls_write on public.mcp_http_capability_calls;
create policy tenant_isolation_mcp_http_capability_calls_write on public.mcp_http_capability_calls
  for all
  using (
    organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin')
  )
  with check (
    organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin')
  );

-- PostgREST guarda o schema em cache; sem isto as policies novas só valem no
-- próximo reload dele.
notify pgrst, 'reload schema';
