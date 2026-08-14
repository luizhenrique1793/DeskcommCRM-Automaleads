import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Reconectar o gateway próprio (UAZAPI caiu do lado do servidor — medido em
 * homologação: o plano de teste expira/rotaciona o token) forçava redigitar
 * URL e id da instância do ZERO, porque `GET /api/v1/channels/gateway` nunca
 * devolvia esses dois campos — só o token é segredo de verdade
 * (`uazapi_token_encrypted`); URL e id ficavam presos no banco sem forma de
 * chegar de volta na tela.
 */

vi.mock("@/lib/auth/server", () => ({
  requireAuth: vi.fn(async () => ({ id: "user-1" })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: "org-1", role: "admin" })),
}));

const findGatewaySessionMock = vi.fn();
const getGatewayLiveStatusMock = vi.fn();
vi.mock("@/lib/channels/gateway", () => ({
  GATEWAY_CHANNEL_LABEL: "UAZAPI",
  findGatewaySession: (...a: unknown[]) => findGatewaySessionMock(...a),
  getGatewayLiveStatus: (...a: unknown[]) => getGatewayLiveStatusMock(...a),
  registerGatewayWebhook: vi.fn(),
  saveGatewaySession: vi.fn(),
  startGatewayConnection: vi.fn(),
  validateGatewayCredentials: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/webhooks/secrets", () => ({ encryptWebhookSecret: vi.fn() }));

import { GET } from "@/app/api/v1/channels/gateway/route";

function req(): NextRequest {
  return new NextRequest("https://x/api/v1/channels/gateway");
}

describe("GET /api/v1/channels/gateway — reconexão não pede tudo de novo", () => {
  it("conectado: devolve base_url e instance_id (não são segredo) junto do resto", async () => {
    findGatewaySessionMock.mockResolvedValue({
      instanceId: "pordosol2",
      baseUrl: "https://free.uazapi.com",
      phoneNumber: "554488347632",
      displayName: "UAZAPI",
      status: "WORKING",
      webhookPathToken: "tok-caminho",
      archivedAt: null,
    });
    getGatewayLiveStatusMock.mockResolvedValue({
      status: "connected",
      qrcode: null,
      paircode: null,
      profileName: "Reservas",
    });

    const res = await GET(req());
    const body = (await res.json()) as { data: { base_url: string; instance_id: string } };

    expect(body.data.base_url).toBe("https://free.uazapi.com");
    expect(body.data.instance_id).toBe("pordosol2");
  });

  it("não conectado: não inventa base_url/instance_id de sessão nenhuma", async () => {
    findGatewaySessionMock.mockResolvedValue(null);

    const res = await GET(req());
    const body = (await res.json()) as { data: { connected: boolean; base_url?: unknown; instance_id?: unknown } };

    expect(body.data.connected).toBe(false);
    expect(body.data.base_url).toBeUndefined();
    expect(body.data.instance_id).toBeUndefined();
  });

  it("nunca devolve o token — só os dois campos não-secretos", async () => {
    findGatewaySessionMock.mockResolvedValue({
      instanceId: "pordosol2",
      baseUrl: "https://free.uazapi.com",
      phoneNumber: null,
      displayName: "UAZAPI",
      status: "WORKING",
      webhookPathToken: "tok-caminho",
      archivedAt: null,
    });
    getGatewayLiveStatusMock.mockResolvedValue(null);

    const res = await GET(req());
    const corpo = JSON.stringify(await res.json());

    expect(corpo.toLowerCase()).not.toContain("token_encrypted");
    expect(corpo).not.toMatch(/"token"\s*:/);
  });
});
