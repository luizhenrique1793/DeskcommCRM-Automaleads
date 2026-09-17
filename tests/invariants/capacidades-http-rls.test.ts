import { beforeAll, describe, expect, it } from "vitest";

import {
  countAs,
  GOV_ADMIN,
  GOV_AGENT_A,
  GOV_MANAGER,
  GOV_ORG,
  GOV_VIEWER,
  seedGov,
  sql,
  writeCountAs,
} from "./gov-helpers";

/**
 * mcp_http_capability_calls (migration 0265, RBAC na 0269) — achada pela
 * varredura de rls-completude-varredura.test.ts como tabela tenant-aware
 * NOVA sem prova comportamental nenhuma.
 *
 * Não entra em `TABLES` (rls-isolation.test.ts): aquele loop genérico seeda
 * o usuário com role 'agent' e mede um SELECT roleless — mas a 0269 tornou
 * o SELECT desta tabela manager+. O controle positivo do loop genérico
 * falharia por ACERTO da RLS (agent corretamente recusado), não por defeito
 * da suíte. Precisa de prova própria, nos dois eixos da migration: papel
 * (SELECT manager+, escrita admin+) e tenant (isolamento cross-org).
 */

const TENANT_ORG_A = "dddddddd-0000-4000-8000-000000000001";
const TENANT_ORG_B = "dddddddd-0000-4000-8000-000000000002";
const TENANT_MANAGER_A = "dddddddd-1111-4000-8000-000000000001";
const TENANT_MANAGER_B = "dddddddd-1111-4000-8000-000000000002";

function seedTenant(org: string, manager: string, tag: string): string {
  return `
    insert into auth.users (id, email) values ('${manager}', 'capacidades-http-${tag}@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${org}', 'capacidades-http-${tag}', 'Capacidades HTTP ${tag}', 'Cap HTTP ${tag}')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${manager}', '${org}', 'manager', now())
      on conflict do nothing;
    insert into public.mcp_http_capability_calls (organization_id, tool_name, call_label)
      values ('${org}', 'rls_invariant_tool', 'RLS invariant capability')
      on conflict do nothing;
  `;
}

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.mcp_http_capability_calls (organization_id, tool_name, call_label)
      values ('${GOV_ORG}', 'rls_invariant_tool', 'RLS invariant capability')
      on conflict do nothing;
  `);
  sql(seedTenant(TENANT_ORG_A, TENANT_MANAGER_A, "a") + seedTenant(TENANT_ORG_B, TENANT_MANAGER_B, "b"));
});

describe("mcp_http_capability_calls — RBAC de papel (migration 0269)", () => {
  it("viewer não lê (SELECT é manager+)", () => {
    expect(
      countAs(GOV_VIEWER, `select count(*) from public.mcp_http_capability_calls where organization_id = '${GOV_ORG}';`),
    ).toBe(0);
  });

  it("agent não lê (SELECT é manager+)", () => {
    expect(
      countAs(GOV_AGENT_A, `select count(*) from public.mcp_http_capability_calls where organization_id = '${GOV_ORG}';`),
    ).toBe(0);
  });

  it("manager lê (controle positivo do papel)", () => {
    expect(
      countAs(GOV_MANAGER, `select count(*) from public.mcp_http_capability_calls where organization_id = '${GOV_ORG}';`),
    ).toBeGreaterThanOrEqual(1);
  });

  it("manager não escreve (a escrita é admin+)", () => {
    expect(
      writeCountAs(
        GOV_MANAGER,
        `update public.mcp_http_capability_calls set call_label = 'tentativa de manager' where organization_id = '${GOV_ORG}'`,
      ),
    ).toBe(0);
  });

  it("admin escreve (controle positivo da escrita)", () => {
    expect(
      writeCountAs(
        GOV_ADMIN,
        `update public.mcp_http_capability_calls set call_label = 'atualizado por admin' where organization_id = '${GOV_ORG}'`,
      ),
    ).toBeGreaterThanOrEqual(1);
  });
});

describe("mcp_http_capability_calls — isolamento cross-tenant (migration 0265)", () => {
  it("manager de A não lê a linha de B", () => {
    expect(
      countAs(TENANT_MANAGER_A, `select count(*) from public.mcp_http_capability_calls where organization_id = '${TENANT_ORG_B}';`),
    ).toBe(0);
  });

  it("manager de A ainda lê a própria linha (controle positivo do tenant)", () => {
    expect(
      countAs(TENANT_MANAGER_A, `select count(*) from public.mcp_http_capability_calls where organization_id = '${TENANT_ORG_A}';`),
    ).toBeGreaterThanOrEqual(1);
  });
});
