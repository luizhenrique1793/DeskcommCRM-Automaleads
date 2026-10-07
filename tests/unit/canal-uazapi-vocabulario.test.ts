import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * O vocabulário do quarto canal — o que entra ANTES do transporte.
 *
 * Mesmo papel de `canal-zernio-vocabulario.test.ts`: tipo, matriz de
 * capabilities, coluna de ref e CHECKs do banco nasceram JUNTOS. O transporte
 * em si está em `channel-adapter-uazapi.test.ts`, contra o contrato medido no
 * OpenAPI oficial 2.1.1.
 */
import {
  CHANNEL_CAPABILITIES,
  CHANNEL_PROVIDER_UAZAPI,
  capabilitiesOf,
} from "@/lib/channels/capabilities";
import { getAdapter } from "@/lib/channels";
import { CHANNEL_SESSION_REF_COLUMNS, resolveSessionRef } from "@/lib/channels/session-ref";

const UAZAPI = CHANNEL_PROVIDER_UAZAPI;

describe("capabilities do gateway próprio", () => {
  it("é auto-restrição, como o WAHA — QR não oficial, o WhatsApp bane por abuso", () => {
    expect(capabilitiesOf(UAZAPI)).toEqual({
      freeformOutsideWindow: true,
      requiresTemplates: false,
      canManageTemplates: false,
      banRisk: true,
      minIntervalMs: null,
      voiceNote: "opus-only",
      groups: "none",
      costPerMessage: false,
      canSaveContact: true,
      canShowTyping: true,
      canSendButtons: true,
      alteraMensagemEnviada: false,
    });
  });

  it("NÃO herda voiceNote do WAHA — sem evidência de conversão server-side no OpenAPI, é conservador", () => {
    const porQr = CHANNEL_CAPABILITIES.waha;
    expect(porQr.voiceNote).toBe("server-convert");
    expect(capabilitiesOf(UAZAPI).voiceNote).toBe("opus-only");
  });

  it("groups é 'none' — a ingestão pula grupo de propósito, declarar mais prometeria o que não existe", () => {
    expect(capabilitiesOf(UAZAPI).groups).toBe("none");
  });

  it("as duas famílias de restrição não coexistem", () => {
    const c = capabilitiesOf(UAZAPI);
    expect(c.banRisk && c.requiresTemplates).toBe(false);
  });

  it("é o único provider com canSaveContact — /contact/add é endpoint real, medido no OpenAPI", () => {
    for (const [p, c] of Object.entries(CHANNEL_CAPABILITIES)) {
      if (p === "uazapi") continue;
      expect(c.canSaveContact, `${p} não deveria declarar canSaveContact`).toBe(false);
    }
    expect(capabilitiesOf(UAZAPI).canSaveContact).toBe(true);
  });
});

describe("identificador da sessão", () => {
  it("resolve pelo ID DA INSTÂNCIA — não pelo token, que é segredo", () => {
    expect(
      resolveSessionRef({ provider: UAZAPI as "uazapi", uazapi_instance_id: "r183e2ef9597845" }),
    ).toBe("r183e2ef9597845");
  });

  it("a coluna entra no select — sem ela o ref volta indefinido em runtime", () => {
    expect(CHANNEL_SESSION_REF_COLUMNS).toContain("uazapi_instance_id");
  });

  it("cada canal resolve pela SUA coluna", () => {
    expect(resolveSessionRef({ provider: "waha", waha_session_name: "s1" })).toBe("s1");
    expect(
      resolveSessionRef({ provider: "zernio", zernio_account_id: "acc_1" }),
    ).toBe("acc_1");
  });
});

describe("o canal tem transporte", () => {
  it("getAdapter devolve o adapter do canal, não o de outro (fail-closed em vez de cair no WAHA)", () => {
    expect(getAdapter(UAZAPI).provider).toBe(UAZAPI);
  });

  it("os códigos de erro nomeiam o canal", () => {
    expect(getAdapter(UAZAPI).codes.sendFailed).toContain("uazapi");
  });

  it("declara saveContact — a feature testa a PRESENÇA do método, nunca o nome do provider", () => {
    expect(typeof getAdapter(UAZAPI).saveContact).toBe("function");
  });
});

describe("banco e TypeScript falam o mesmo vocabulário", () => {
  const baseline = readFileSync("supabase/baseline.sql", "utf8");

  it("o CHECK de provider do baseline conhece o canal novo", () => {
    expect(baseline).toMatch(/channel_sessions_provider_check[\s\S]{0,400}'uazapi'/);
  });

  it("o CHECK de ref exige a coluna do canal novo", () => {
    expect(baseline).toMatch(/provider = 'uazapi'\s+and uazapi_instance_id\s+is not null/);
  });

  it("os CHECKs continuam num BLOCO ÚNICO — a constraint não é reconstruída em série", () => {
    // Regra de `tests/unit/baseline-constraint-reconstruida.test.ts`: um
    // `drop`+`add` a mais faria o `update.sh` de um clone com dados falhar em
    // cadeia e deixar a tabela sem constraint entre os blocos.
    const ocorrencias = (
      baseline.match(/add constraint channel_sessions_provider_check/g) ?? []
    ).length;
    expect(ocorrencias).toBe(1);
  });

  it("as três colunas nascem antes do CHECK que as referencia", () => {
    const col = baseline.indexOf("add column if not exists uazapi_instance_id");
    const check = baseline.indexOf("provider = 'uazapi'");
    expect(col).toBeGreaterThan(-1);
    expect(col).toBeLessThan(check);
  });

  it("a migration versionada existe junto do apêndice — clone atualiza pelas duas vias", () => {
    // Renumerada de 0266 para 0565 no merge com upstream/main (2026-10): 0266
    // colidia com uma migration diferente do upstream.
    const mig = readFileSync(
      "supabase/migrations/20260813180000_0565_uazapi_channel_provider.sql",
      "utf8",
    );
    expect(mig).toContain("uazapi_instance_id");
    expect(readFileSync("supabase/migrations/MANIFEST.md", "utf8")).toContain(
      "0565_uazapi_channel_provider",
    );
  });
});

describe("o lint de canal reconhece o nome novo", () => {
  it("SEPARADO e PASCAL cobrem 'uazapi'", async () => {
    const { nomeiaProvider } = await import("@/scripts/lint-channels.pattern");
    expect(nomeiaProvider("UAZAPI_BASE_URL")).toBe(true);
    expect(nomeiaProvider("uazapi_instance_id")).toBe(true);
    expect(nomeiaProvider("provider === 'uazapi'")).toBe(true);
  });
});
