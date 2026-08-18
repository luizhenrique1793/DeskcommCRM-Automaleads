import { beforeEach, describe, expect, it, vi } from "vitest";

import { executarChamadaPousada } from "@/lib/pousada/executor";
import { loadPousadaSettings } from "@/lib/pousada/settings";
import {
  pousadaConsultarDisponibilidade,
  pousadaConsultarDataAtual,
  pousadaConsultarStatusReserva,
  pousadaVerificarOuCadastrarHospede,
  pousadaCriarReserva,
} from "./pousada";
import type { McpContext } from "../types";

vi.mock("@/lib/pousada/executor", () => ({ executarChamadaPousada: vi.fn() }));
vi.mock("@/lib/pousada/settings", () => ({
  loadPousadaSettings: vi.fn().mockResolvedValue({
    pmsBaseUrl: "https://pordosol.ddns.net:5004",
    pixDepositPercent: 30,
    pixExpirationSeconds: 3600,
  }),
}));

function ctx(): McpContext {
  return {
    organizationId: "org-1",
    role: "agent",
    actor: { type: "agent", id: "agent-1", role: "agent" } as never,
    apiTokenId: "tok-1",
    requestId: "req-1",
    supabase: {} as never,
  };
}

const disponibilidadeInput = {
  checkin: "2026-12-20",
  checkout: "2026-12-22",
  quantidade_adultos: 2,
  quantidade_criancas: 0,
  quantidade_11_12: 0,
};

beforeEach(() => {
  vi.mocked(executarChamadaPousada).mockReset();
  vi.mocked(loadPousadaSettings).mockClear();
});

describe("pousadaConsultarDisponibilidade — contrato congelado", () => {
  it("sem hóspede nenhum, não chama o PMS", async () => {
    const out = await pousadaConsultarDisponibilidade.handler(
      { ...disponibilidadeInput, quantidade_adultos: 0 },
      ctx(),
    );
    expect(out).toEqual({
      disponivel: false,
      mensagem: "Informe ao menos um hóspede para consultar disponibilidade.",
    });
    expect(executarChamadaPousada).not.toHaveBeenCalled();
  });

  it("sem quarto na resposta do PMS: disponivel false", async () => {
    vi.mocked(executarChamadaPousada).mockResolvedValue({ quartos: [] });
    const out = await pousadaConsultarDisponibilidade.handler(disponibilidadeInput, ctx());
    expect(out).toEqual({
      disponivel: false,
      mensagem: "Não encontramos disponibilidade para o período informado.",
    });
  });

  it("quarto livre mas sem pacote/tarifa cadastrada: disponivel false com mensagem própria", async () => {
    vi.mocked(executarChamadaPousada).mockResolvedValue({
      quartos: [{ id: 1 }],
      idDoQuarto: 1,
      valorTotal: 0,
      descricaoPacotes: "Pacote não encontrado",
    });
    const out = await pousadaConsultarDisponibilidade.handler(disponibilidadeInput, ctx());
    expect(out).toMatchObject({ disponivel: false, mensagem: expect.stringContaining("tarifa cadastrada") });
  });

  it("quarto livre com tarifa válida: disponivel true com os campos esperados", async () => {
    vi.mocked(executarChamadaPousada).mockResolvedValue({
      quartos: [{ id: 7 }],
      idDoQuarto: 7,
      numeroDoQuarto: 12,
      valorTotal: 1230,
      descricaoPacotes: "Pacote Standard",
    });
    const out = await pousadaConsultarDisponibilidade.handler(disponibilidadeInput, ctx());
    expect(out).toEqual({
      disponivel: true,
      quarto_id: 7,
      numero_quarto: 12,
      valor_total: 1230,
      pacote: "Pacote Standard",
    });
  });
});

describe("pousadaConsultarStatusReserva — contrato congelado", () => {
  it("404 do PMS vira 'não encontrada', não uma exceção", async () => {
    vi.mocked(executarChamadaPousada).mockRejectedValue(new Error("pms_http_404: not found"));
    const out = await pousadaConsultarStatusReserva.handler({ reserva_id: "123" }, ctx());
    expect(out).toEqual({
      status: "não encontrada",
      confirmada: false,
      mensagem: "Não encontrei nenhuma reserva com esse número. Confira o número com o hóspede.",
    });
  });

  it("erro diferente de 404 propaga", async () => {
    vi.mocked(executarChamadaPousada).mockRejectedValue(new Error("pms_http_500: boom"));
    await expect(pousadaConsultarStatusReserva.handler({ reserva_id: "123" }, ctx())).rejects.toThrow(
      "pms_http_500",
    );
  });

  it("reconhece 'reserva confirmada' (case-insensitive) como confirmada", async () => {
    vi.mocked(executarChamadaPousada).mockResolvedValue("Reserva Confirmada");
    const out = await pousadaConsultarStatusReserva.handler({ reserva_id: "123" }, ctx());
    expect(out).toEqual({ status: "Reserva Confirmada", confirmada: true });
  });
});

describe("pousadaVerificarOuCadastrarHospede — contrato congelado", () => {
  const input = {
    cpf: "12345678900",
    nome: "Fulano de Tal",
    email: undefined,
    data_nascimento: "1990-01-01",
    telefone: "5511999998888",
  };

  it("hóspede encontrado (busca sem 404): devolve status found sem cadastrar de novo", async () => {
    vi.mocked(executarChamadaPousada).mockResolvedValueOnce({ jaExistia: true, id: "555", nome: "Fulano" });
    const out = await pousadaVerificarOuCadastrarHospede.handler(input, ctx());
    expect(out).toMatchObject({ status: "found", id_titular: "555" });
    expect(executarChamadaPousada).toHaveBeenCalledTimes(1);
  });

  it("busca 404 (hóspede novo): cadastra e devolve status created", async () => {
    vi.mocked(executarChamadaPousada)
      .mockRejectedValueOnce(new Error("pms_http_404: not found"))
      .mockResolvedValueOnce({ id: "999" });
    const out = await pousadaVerificarOuCadastrarHospede.handler(input, ctx());
    expect(out).toMatchObject({ status: "created", id_titular: "999" });
    expect(executarChamadaPousada).toHaveBeenCalledTimes(2);
  });
});

describe("pousadaCriarReserva — contrato congelado", () => {
  it("id_titular inválido (igual ao CPF) recusa antes de chamar o PMS", async () => {
    const out = await pousadaCriarReserva.handler(
      {
        checkin: "2026-12-20",
        checkout: "2026-12-22",
        quantidade_adultos: 2,
        quantidade_criancas: 0,
        quantidade_11_12: 0,
        id_titular: "12345678900",
        titular_nome: "Fulano",
        cpf_titular: "12345678900",
        total_cotado: 100,
        pacote_cotado: "Pacote",
        contact_id: undefined,
      },
      ctx(),
    );
    expect(out).toMatchObject({ ok: false, erro: "id_titular_invalido" });
    expect(executarChamadaPousada).not.toHaveBeenCalled();
  });

  function ctxComDuplicataDeReserva(duplicata: unknown): McpContext {
    const chain = {
      select: () => chain,
      eq: () => chain,
      contains: () => chain,
      gte: () => chain,
      limit: () => chain,
      maybeSingle: async () => ({ data: duplicata, error: null }),
    };
    return { ...ctx(), supabase: { from: () => chain } as never };
  }

  const inputValido = {
    checkin: "2026-12-20",
    checkout: "2026-12-22",
    quantidade_adultos: 2,
    quantidade_criancas: 0,
    quantidade_11_12: 0,
    id_titular: "555",
    titular_nome: "Fulano",
    cpf_titular: "11144477735",
    total_cotado: 100,
    pacote_cotado: "Pacote",
    contact_id: undefined,
  };

  it("recusa quando já existe reserva recente do mesmo titular+datas (trava de duplicidade)", async () => {
    const out = await pousadaCriarReserva.handler(
      inputValido,
      ctxComDuplicataDeReserva({ id: "lead-1", custom_fields: { pms_reserva_id: "999" } }),
    );
    expect(out).toMatchObject({
      ok: false,
      erro: "reserva_possivelmente_duplicada",
      reserva_id_existente: "999",
    });
    expect(executarChamadaPousada).not.toHaveBeenCalled();
  });

  it("sem duplicata recente: segue e chama o PMS normalmente", async () => {
    vi.mocked(executarChamadaPousada).mockResolvedValue({ quartos: [] }); // corta cedo, só interessa que TENTOU chamar
    const out = await pousadaCriarReserva.handler(inputValido, ctxComDuplicataDeReserva(null));
    expect(out).toMatchObject({ ok: false, erro: "sem_quartos_disponiveis" });
    expect(executarChamadaPousada).toHaveBeenCalled();
  });
});

describe("validação de CPF (dígito verificador) — pousadaVerificarOuCadastrarHospede.cpf", () => {
  const cpfSchema = pousadaVerificarOuCadastrarHospede.inputSchema.cpf;

  it("recusa CPF com todos os dígitos iguais (formato válido, dígito nunca bate)", () => {
    expect(cpfSchema.safeParse("11111111111").success).toBe(false);
    expect(cpfSchema.safeParse("00000000000").success).toBe(false);
  });

  it("recusa CPF com dígito verificador errado", () => {
    expect(cpfSchema.safeParse("12345678900").success).toBe(false);
  });

  it("aceita CPF válido (dígito verificador confere)", () => {
    // 111.444.777-35 — CPF de teste conhecido, matematicamente válido.
    expect(cpfSchema.safeParse("11144477735").success).toBe(true);
  });
});

describe("pousadaConsultarDataAtual — contrato congelado", () => {
  it("devolve hoje/hoje_por_extenso/fuso sem chamar nenhuma API", async () => {
    const out = (await pousadaConsultarDataAtual.handler({}, ctx())) as Record<string, unknown>;
    expect(out.fuso).toBe("America/Sao_Paulo");
    expect(typeof out.hoje).toBe("string");
    expect(typeof out.hoje_por_extenso).toBe("string");
    expect(executarChamadaPousada).not.toHaveBeenCalled();
  });
});
