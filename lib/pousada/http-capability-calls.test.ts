import { describe, expect, it } from "vitest";

import {
  chamadasDaTool,
  montarUrlFinal,
  toolsComChamadaHttp,
  POUSADA_HTTP_CAPABILITY_CALLS,
} from "./http-capability-calls";

describe("montarUrlFinal", () => {
  it("usa base/endpoint hardcoded quando nada está configurado", () => {
    expect(
      montarUrlFinal({
        hardcodedBaseUrl: "https://pordosol.ddns.net:5004",
        hardcodedEndpointPath: "/api/quartos/BuscarQuartosSemReservasEntreDatas",
      }),
    ).toBe("https://pordosol.ddns.net:5004/api/quartos/BuscarQuartosSemReservasEntreDatas");
  });

  it("configurado tem precedência sobre o hardcoded", () => {
    expect(
      montarUrlFinal({
        baseUrl: "https://novo-dominio.example",
        endpointPath: "/v2/rota",
        hardcodedBaseUrl: "https://antigo.example",
        hardcodedEndpointPath: "/v1/rota",
      }),
    ).toBe("https://novo-dominio.example/v2/rota");
  });

  it("substitui path params por chave {placeholder}", () => {
    expect(
      montarUrlFinal({
        baseUrl: "https://example.com",
        endpointPath: "/api/reservas/{reservaId}/status",
        pathParams: [{ key: "reservaId", value: "42" }],
      }),
    ).toBe("https://example.com/api/reservas/42/status");
  });

  it("anexa query params", () => {
    expect(
      montarUrlFinal({
        baseUrl: "https://example.com",
        endpointPath: "/api/hospedes",
        queryParams: [
          { key: "Documento", value: "12345678900" },
          { key: "tipoReserva", value: "RESERVA" },
        ],
      }),
    ).toBe("https://example.com/api/hospedes?Documento=12345678900&tipoReserva=RESERVA");
  });

  it("devolve null sem nenhuma base URL disponível", () => {
    expect(montarUrlFinal({ endpointPath: "/api/foo" })).toBeNull();
  });

  it("devolve null com base URL inválida", () => {
    expect(montarUrlFinal({ baseUrl: "não é uma url", endpointPath: "" })).toBeNull();
  });
});

describe("chamadasDaTool / toolsComChamadaHttp", () => {
  it("devolve as chamadas de uma tool em ordem", () => {
    const chamadas = chamadasDaTool("pousada_criar_reserva");
    expect(chamadas.map((c) => c.callKey)).toEqual(["revalidar_disponibilidade", "criar_reserva"]);
  });

  it("tool sem chamada HTTP (data atual) não aparece na lista de tools elegíveis", () => {
    expect(toolsComChamadaHttp()).not.toContain("pousada_consultar_data_atual");
  });

  it("são 7 chamadas físicas ao todo, cobrindo as 5 tools HTTP da pousada", () => {
    expect(POUSADA_HTTP_CAPABILITY_CALLS).toHaveLength(7);
    expect(toolsComChamadaHttp()).toHaveLength(5);
  });
});
