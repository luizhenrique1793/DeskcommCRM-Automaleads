import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `lib/channels/gateway.ts` — quem grava `channel_sessions.status` para o
 * canal UAZAPI, e por que o valor nunca pode vir de fora.
 *
 * Homologação real, 2026-08-13: criar a conexão com QR (telefone de
 * pareamento vazio) derrubava o INSERT — `channel_sessions_status_check` só
 * aceita `STARTING|SCAN_QR_CODE|WORKING|STOPPED|FAILED`, e a rota gravava
 * `"connecting"` (minúsculo, vocabulário do UAZAPI). A correção: `status`
 * deixou de ser parâmetro de `saveGatewaySession` — a função escolhe
 * `STARTING` sozinha, e `disconnectGateway` escolhe pelo mapper — nenhum
 * chamador externo pode mais escrever um palpite.
 */

const credsRef: { current: unknown } = { current: null };
vi.mock("@/lib/channels/uazapi/credentials", () => ({
  resolveUazapiCreds: async () => credsRef.current,
}));

const disconnectMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/channels/uazapi/client", () => ({
  uazapiClient: { disconnect: (...args: unknown[]) => disconnectMock(...args) },
}));

import { disconnectGateway, saveGatewaySession } from "@/lib/channels/gateway";

const CREDS = { instanceId: "r183e2ef9597845", token: "tok", baseUrl: "https://x", source: "session" as const };

interface Op {
  tabela: string;
  op: "insert" | "update";
  payload: Record<string, unknown>;
  filtroId?: string;
}
let ops: Op[] = [];

function fakeAdmin() {
  return {
    from: (tabela: string) => ({
      insert: (payload: Record<string, unknown>) => {
        ops.push({ tabela, op: "insert", payload });
        return Promise.resolve({ error: null });
      },
      update: (payload: Record<string, unknown>) => ({
        eq: (_col: string, val: string) => {
          ops.push({ tabela, op: "update", payload, filtroId: val });
          return Promise.resolve({ error: null });
        },
      }),
    }),
  } as never;
}

beforeEach(() => {
  ops = [];
  credsRef.current = CREDS;
  disconnectMock.mockClear();
});

// 1 — criação inicial da sessão
describe("saveGatewaySession — criação inicial", () => {
  it("grava status STARTING no INSERT — não aceita status vindo de fora", async () => {
    await saveGatewaySession(fakeAdmin(), {
      organizationId: "org-1",
      existingId: null,
      instanceId: "r183e2ef9597845",
      baseUrl: "https://gw.exemplo.com",
      tokenEncrypted: "\\xdead",
      webhookPathToken: "tok123",
      webhookSecretEncrypted: "\\xbeef",
      phoneNumber: null,
      displayName: "Teste",
    });
    const ins = ops.find((o) => o.tabela === "channel_sessions" && o.op === "insert");
    expect(ins?.payload.status).toBe("STARTING");
  });

  it("grava STARTING também ao RESSUSCITAR (update) uma conexão existente", async () => {
    await saveGatewaySession(fakeAdmin(), {
      organizationId: "org-1",
      existingId: "sess-existente",
      instanceId: "r183e2ef9597845",
      baseUrl: "https://gw.exemplo.com",
      tokenEncrypted: "\\xdead",
      webhookPathToken: "tok123",
      webhookSecretEncrypted: "\\xbeef",
      phoneNumber: null,
      displayName: "Teste",
    });
    const upd = ops.find((o) => o.tabela === "channel_sessions" && o.op === "update");
    expect(upd?.payload.status).toBe("STARTING");
    expect(upd?.filtroId).toBe("sess-existente");
  });

  // TypeScript já reprova em compilação um `status` extra no input (o campo
  // saiu da interface) — este caso prova a MESMA garantia em runtime, contra
  // um chamador que ignore o tipo (`as any`, JS puro, etc).
  it("ignora um `status` estranho passado por fora do tipo — sempre grava STARTING", async () => {
    await saveGatewaySession(fakeAdmin(), {
      organizationId: "org-1",
      existingId: null,
      instanceId: "r183e2ef9597845",
      baseUrl: "https://gw.exemplo.com",
      tokenEncrypted: "\\xdead",
      webhookPathToken: "tok123",
      webhookSecretEncrypted: "\\xbeef",
      phoneNumber: null,
      displayName: "Teste",
      status: "connecting",
    } as unknown as Parameters<typeof saveGatewaySession>[1]);
    const ins = ops.find((o) => o.tabela === "channel_sessions" && o.op === "insert");
    expect(ins?.payload.status).toBe("STARTING");
  });
});

// desconectado
describe("disconnectGateway — desconectar", () => {
  it("desconecta no transporte e grava STOPPED (via mapper) na sessão", async () => {
    const ok = await disconnectGateway(fakeAdmin(), "r183e2ef9597845", "sess-1");
    expect(ok).toBe(true);
    expect(disconnectMock).toHaveBeenCalledWith(CREDS);
    const upd = ops.find((o) => o.tabela === "channel_sessions" && o.op === "update");
    expect(upd?.payload.status).toBe("STOPPED");
    expect(upd?.filtroId).toBe("sess-1");
  });

  it("sem credencial — não desconecta, não grava, devolve false", async () => {
    credsRef.current = null;
    const ok = await disconnectGateway(fakeAdmin(), "r183e2ef9597845", "sess-1");
    expect(ok).toBe(false);
    expect(disconnectMock).not.toHaveBeenCalled();
    expect(ops.some((o) => o.tabela === "channel_sessions")).toBe(false);
  });
});
