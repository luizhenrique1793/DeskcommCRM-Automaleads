import { describe, expect, it } from "vitest";

import { dataBate, reservaDivergente } from "./route";

describe("dataBate", () => {
  it("bate quando a data ISO do PMS tem o mesmo prefixo da nossa data pura", () => {
    expect(dataBate("2026-12-18T12:00:00", "2026-12-18")).toBe(true);
  });

  it("não bate quando as datas divergem — o caso real da colisão de ID (39389)", () => {
    // Nossa reserva de teste: 21-22/12. PMS devolveu a reserva real de outra
    // hóspede pro mesmo número: 26-27/09.
    expect(dataBate("2026-09-26T12:00:00", "2026-12-21")).toBe(false);
  });

  it("sem dado pra comparar (campo ausente/tipo inesperado), NÃO bloqueia — falha pro lado seguro", () => {
    expect(dataBate(undefined, "2026-12-18")).toBe(true);
    expect(dataBate("2026-12-18T12:00:00", undefined)).toBe(true);
    expect(dataBate(null, null)).toBe(true);
  });
});

describe("reservaDivergente — trava contra colisão de ID de reserva no PMS", () => {
  it("reproduz a colisão real (2026-08-18): reserva #39389 nossa × reserva real de outra hóspede", () => {
    const pmsDaOutraHospede = {
      status: "Reserva Confirmada",
      dataEntrada: "2026-09-26T12:00:00",
      dataSaida: "2026-09-27T12:00:00",
    };
    const nossoCustomFields = { checkin: "2026-12-21", checkout: "2026-12-22" };
    expect(reservaDivergente(pmsDaOutraHospede, nossoCustomFields)).toBe(true);
  });

  it("reserva real (sem colisão): datas do PMS batem com o que registramos", () => {
    const pmsDaNossaReserva = {
      status: "Reserva Confirmada",
      dataEntrada: "2026-12-21T12:00:00",
      dataSaida: "2026-12-22T12:00:00",
    };
    const nossoCustomFields = { checkin: "2026-12-21", checkout: "2026-12-22" };
    expect(reservaDivergente(pmsDaNossaReserva, nossoCustomFields)).toBe(false);
  });

  it("resposta sem as datas (contrato do PMS mudou): não bloqueia por falta de prova", () => {
    const pmsSemDatas = { status: "Reserva Confirmada" };
    const nossoCustomFields = { checkin: "2026-12-21", checkout: "2026-12-22" };
    expect(reservaDivergente(pmsSemDatas, nossoCustomFields)).toBe(false);
  });
});
