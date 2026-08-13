import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type * as LibChannels from "@/lib/channels";

/**
 * `GET /api/v1/channel-sessions/[id]` — o health-check ao vivo que alimenta
 * a aba "Números por QR".
 *
 * Homologação real, 2026-08-13: uma instância UAZAPI já `connected` de
 * verdade aparecia como "Conectando…" / "Ainda não verificado" nesta aba.
 * Causa: a rota só perguntava ao transporte quando `provider === 'waha'` —
 * todo outro provider caía direto no "waha_configured: false" e devolvia o
 * status congelado do banco, sem nunca perguntar de verdade. A correção
 * pergunta ao ADAPTER (`getAdapter(provider).checkHealth`), o mesmo seam que
 * `cron/channel-health` já usa — sem citar "uazapi" nesta rota.
 */

const loadAuthUserMock = vi.fn();
const resolveActiveOrgMock = vi.fn();
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: (...a: unknown[]) => loadAuthUserMock(...a),
  resolveActiveOrg: (...a: unknown[]) => resolveActiveOrgMock(...a),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const getWahaClientMock = vi.fn(() => null);
vi.mock("@/lib/waha/client", () => ({
  getWahaClient: () => getWahaClientMock(),
  wahaFriendlyError: (m: string) => m,
}));

const checkHealthMock = vi.fn();
vi.mock("@/lib/channels", async (importOriginal) => {
  const real = await importOriginal<typeof LibChannels>();
  return {
    ...real,
    getAdapter: vi.fn(() => ({
      provider: "uazapi",
      checkHealth: (...a: unknown[]) => checkHealthMock(...a),
    })),
  };
});

const ORG = "org-1";
const SESSAO_ID = "sess-1";

let sessionRow: Record<string, unknown>;
let updates: Record<string, unknown>[];

function fakeSupabase() {
  return {
    from: (_tabela: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: sessionRow, error: null }),
          }),
        }),
      }),
      update: (patch: Record<string, unknown>) => ({
        eq: () => ({
          eq: async () => {
            updates.push(patch);
            return { error: null };
          },
        }),
      }),
      delete: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
    }),
  } as never;
}

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => fakeSupabase()) }));

import { createClient } from "@/lib/supabase/server";
import { GET } from "@/app/api/v1/channel-sessions/[id]/route";

beforeEach(() => {
  vi.clearAllMocks();
  updates = [];
  loadAuthUserMock.mockResolvedValue({ id: "user-1" });
  resolveActiveOrgMock.mockResolvedValue({ orgId: ORG, role: "admin" });
  getWahaClientMock.mockReturnValue(null);
  (createClient as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(fakeSupabase());
});

function req(): NextRequest {
  return new NextRequest(`https://x/api/v1/channel-sessions/${SESSAO_ID}`);
}

describe("canal UAZAPI (não-WAHA) — pergunta ao adapter genérico", () => {
  beforeEach(() => {
    sessionRow = {
      id: SESSAO_ID,
      provider: "uazapi",
      waha_session_name: null,
      meta_phone_number_id: null,
      zernio_account_id: null,
      uazapi_instance_id: "r183e2ef9597845",
      display_name: "UAZAPI",
      phone_number: null,
      status: "STARTING",
    };
  });

  it("connected real vira WORKING gravado + last_health_check_at carimbado", async () => {
    checkHealthMock.mockResolvedValue({ reachable: true, status: "WORKING", detail: null });
    const res = await GET(req(), { params: Promise.resolve({ id: SESSAO_ID }) });
    const body = (await res.json()) as { data: { status: string; last_health_check_at: string } };

    expect(checkHealthMock).toHaveBeenCalledWith({ sessionRef: "r183e2ef9597845" });
    expect(body.data.status).toBe("WORKING");
    expect(body.data.last_health_check_at).toBeTruthy();

    const upd = updates.find((u) => "status" in u);
    expect(upd).toMatchObject({ status: "WORKING" });
    expect(updates.some((u) => "last_health_check_at" in u)).toBe(true);
  });

  it("não alcançável — mantém o status do banco, não inventa", async () => {
    checkHealthMock.mockResolvedValue({ reachable: false, status: null, detail: "timeout" });
    const res = await GET(req(), { params: Promise.resolve({ id: SESSAO_ID }) });
    const body = (await res.json()) as { data: { status: string } };
    expect(body.data.status).toBe("STARTING");
    expect(updates.some((u) => "status" in u)).toBe(false);
    // Ainda assim carimba que TENTOU perguntar.
    expect(updates.some((u) => "last_health_check_at" in u)).toBe(true);
  });

  it("adapter sem checkHealth — devolve o DB sem tentar, waha_configured:false", async () => {
    checkHealthMock.mockResolvedValue(undefined);
    // Simula um provider hipotético sem o método reatribuindo o mock do adapter.
    const channels = await import("@/lib/channels");
    (channels.getAdapter as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      provider: "uazapi",
    });
    const res = await GET(req(), { params: Promise.resolve({ id: SESSAO_ID }) });
    const body = (await res.json()) as { data: { waha_configured: boolean } };
    expect(body.data.waha_configured).toBe(false);
    expect(updates.length).toBe(0);
  });
});

describe("canal WAHA — comportamento intocado", () => {
  beforeEach(() => {
    sessionRow = {
      id: SESSAO_ID,
      provider: "waha",
      waha_session_name: "sessao-1",
      meta_phone_number_id: null,
      zernio_account_id: null,
      uazapi_instance_id: null,
      display_name: "WAHA",
      phone_number: null,
      status: "STARTING",
    };
  });

  it("sem WAHA configurado, devolve waha_configured:false e NÃO chama o adapter genérico", async () => {
    getWahaClientMock.mockReturnValue(null);
    const res = await GET(req(), { params: Promise.resolve({ id: SESSAO_ID }) });
    const body = (await res.json()) as { data: { waha_configured: boolean } };
    expect(body.data.waha_configured).toBe(false);
    expect(checkHealthMock).not.toHaveBeenCalled();
  });
});
