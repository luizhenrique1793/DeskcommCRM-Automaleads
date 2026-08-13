import { beforeEach, describe, expect, it, vi } from "vitest";

import { pmsRequest } from "./pms-client";
import { loadCapabilityCall, type CapabilityCallRow } from "./capability-config";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { executarChamadaPousada } from "./executor";

vi.mock("./pms-client", () => ({ pmsRequest: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock("./capability-config", async () => {
  const actual = await vi.importActual<typeof import("./capability-config")>("./capability-config");
  return { ...actual, loadCapabilityCall: vi.fn() };
});
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: vi.fn() }));

const supabase = {} as never;

function baseArgs() {
  return {
    supabase,
    organizationId: "org-1",
    toolName: "pousada_consultar_disponibilidade",
    callKey: "default",
    method: "POST" as const,
    path: "/api/quartos/BuscarQuartosSemReservasEntreDatas",
    baseUrl: "https://pordosol.ddns.net:5004",
    body: { DataDeEntrada: "2026-12-20", IDDoUsuario: 1 },
  };
}

function emptyConfig(overrides: Partial<CapabilityCallRow> = {}): CapabilityCallRow {
  return {
    toolName: "pousada_consultar_disponibilidade",
    callKey: "default",
    enabled: true,
    method: null,
    baseUrl: null,
    endpointPath: null,
    headers: [],
    queryParams: [],
    pathParams: [],
    bodyType: "json",
    legacyBodyOverrides: {},
    bodyFieldMap: [],
    timeoutMs: null,
    verifyTls: null,
    authType: "none",
    authKeyName: null,
    authSecretEnc: null,
    specificConfig: {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(pmsRequest).mockClear().mockResolvedValue({ ok: true });
  vi.mocked(loadCapabilityCall).mockReset();
  vi.mocked(decryptWebhookSecret).mockReset();
});

describe("executarChamadaPousada — compatibilidade sem configuração", () => {
  it("sem linha na tabela (null): chama pmsRequest exatamente como o call-site hardcoded, sem 5º argumento", async () => {
    vi.mocked(loadCapabilityCall).mockResolvedValue(null);
    const args = baseArgs();

    await executarChamadaPousada(args);

    expect(pmsRequest).toHaveBeenCalledTimes(1);
    expect(pmsRequest).toHaveBeenCalledWith(args.method, args.path, args.baseUrl, args.body);
  });

  it("linha enabled=true mas todos os campos vazios: produz o mesmo method/URL/body/timeout/TLS do hardcoded", async () => {
    vi.mocked(loadCapabilityCall).mockResolvedValue(emptyConfig());
    const args = baseArgs();

    await executarChamadaPousada(args);

    expect(pmsRequest).toHaveBeenCalledTimes(1);
    const [method, url, baseUrlEfetiva, body, options] = vi.mocked(pmsRequest).mock.calls[0]!;
    expect(method).toBe(args.method);
    expect(new URL(url, args.baseUrl).toString()).toBe(new URL(args.path, args.baseUrl).toString());
    expect(baseUrlEfetiva).toBe(args.baseUrl);
    expect(body).toEqual(args.body);
    expect(options).toEqual({ timeoutMs: undefined, verifyTls: undefined, extraHeaders: {} });
  });
});

describe("executarChamadaPousada — configuração aplicada", () => {
  it("aplica method/base_url/endpoint configurados por cima do hardcoded", async () => {
    vi.mocked(loadCapabilityCall).mockResolvedValue(
      emptyConfig({
        method: "GET",
        baseUrl: "https://novo-dominio.example",
        endpointPath: "/v2/disponibilidade",
      }),
    );
    const args = baseArgs();

    await executarChamadaPousada(args);

    const [method, url, baseUrlEfetiva] = vi.mocked(pmsRequest).mock.calls[0]!;
    expect(method).toBe("GET");
    expect(url).toBe("https://novo-dominio.example/v2/disponibilidade");
    expect(baseUrlEfetiva).toBe("https://novo-dominio.example");
  });

  it("resolve path params e query params dinâmicos a partir do input do agente", async () => {
    vi.mocked(loadCapabilityCall).mockResolvedValue(
      emptyConfig({
        baseUrl: "https://example.com",
        endpointPath: "/api/foo/{id}",
        pathParams: [{ key: "id", source: "fixed", value: "123" }],
        queryParams: [{ key: "q", source: "agent_field", value: "termo" }],
      }),
    );
    const args = { ...baseArgs(), input: { termo: "abc" } };

    await executarChamadaPousada(args);

    const [, url] = vi.mocked(pmsRequest).mock.calls[0]!;
    expect(url).toBe("https://example.com/api/foo/123?q=abc");
  });

  it("aplica legacy_body_overrides (deep-merge) e depois body_field_map (agent_field) sobre o corpo hardcoded", async () => {
    vi.mocked(loadCapabilityCall).mockResolvedValue(
      emptyConfig({
        legacyBodyOverrides: { IDDoUsuario: 99 },
        bodyFieldMap: [
          { api_field_path: "quantidadeAdultos", source: "agent_field", value: "adultos" },
        ],
      }),
    );
    const args = {
      ...baseArgs(),
      body: { DataDeEntrada: "2026-12-20", IDDoUsuario: 1 },
      input: { adultos: 3 },
    };

    await executarChamadaPousada(args);

    const [, , , body] = vi.mocked(pmsRequest).mock.calls[0]!;
    expect(body).toEqual({ DataDeEntrada: "2026-12-20", IDDoUsuario: 99, quantidadeAdultos: 3 });
  });

  it("autenticação bearer decifra o segredo e injeta o header authorization", async () => {
    vi.mocked(loadCapabilityCall).mockResolvedValue(
      emptyConfig({
        baseUrl: "https://example.com",
        authType: "bearer",
        authSecretEnc: "deadbeef",
      }),
    );
    vi.mocked(decryptWebhookSecret).mockResolvedValue("token-secreto");
    const args = baseArgs();

    await executarChamadaPousada(args);

    const [, , , , options] = vi.mocked(pmsRequest).mock.calls[0]!;
    expect(options).toMatchObject({ extraHeaders: { authorization: "Bearer token-secreto" } });
  });

  it("linha desabilitada (enabled=false) é tratada como null pelo loader — não chega a este teste, mas o executor não deve confiar em enabled=false vindo do loader", async () => {
    // loadCapabilityCall já filtra enabled=false e devolve null (ver capability-config.ts) —
    // este teste documenta essa garantia de contrato entre os dois módulos.
    vi.mocked(loadCapabilityCall).mockResolvedValue(null);
    const args = baseArgs();
    await executarChamadaPousada(args);
    expect(pmsRequest).toHaveBeenCalledWith(args.method, args.path, args.baseUrl, args.body);
  });
});
