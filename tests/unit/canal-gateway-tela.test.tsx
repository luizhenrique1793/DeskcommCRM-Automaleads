import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Reconectar o gateway próprio (UAZAPI caiu do lado do servidor — comum em
 * plano de teste, medido em homologação) exigia redigitar URL do servidor e
 * id da instância do ZERO, mesmo os dois já estando gravados: o formulário
 * nascia sempre vazio. Só o TOKEN precisa continuar vazio — é o único campo
 * que o servidor nunca devolve, de propósito (segredo, cifrado).
 */

const getMock = vi.fn();
const postMock = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (...a: unknown[]) => getMock(...a),
    post: (...a: unknown[]) => postMock(...a),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CanalGatewayClient } from "@/components/connections/CanalGatewayClient";

const conectado = {
  data: {
    label: "UAZAPI",
    connected: true,
    phone_number: "554488347632",
    display_name: "Reservas",
    status: "connected",
    qrcode: null,
    paircode: null,
    webhook_url: "https://crm.exemplo/api/v1/webhooks/channel/tok123",
    base_url: "https://free.uazapi.com",
    instance_id: "pordosol2",
  },
};

const desconectado = {
  data: {
    label: "UAZAPI",
    connected: false,
    status: null,
    qrcode: null,
    paircode: null,
  },
};

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
});

describe("reconexão — o formulário chega pré-preenchido", () => {
  it("URL do servidor e id da instância vêm preenchidos quando já há conexão", async () => {
    getMock.mockResolvedValue(conectado);
    render(<CanalGatewayClient />);

    const url = (await screen.findByLabelText(/Endereço do servidor/)) as HTMLInputElement;
    const id = screen.getByLabelText(/Id da instância/) as HTMLInputElement;
    // O campo já existe no primeiro render (formulário sempre visível); o
    // VALOR só chega depois do GET resolver e do efeito de pré-preenchimento
    // rodar — por isso espera o valor, não só a existência do campo.
    await waitFor(() => expect(url.value).toBe("https://free.uazapi.com"));
    expect(id.value).toBe("pordosol2");
  });

  it("o TOKEN continua sempre vazio — o único segredo que o servidor nunca devolve", async () => {
    getMock.mockResolvedValue(conectado);
    render(<CanalGatewayClient />);

    await screen.findByLabelText(/Endereço do servidor/);
    const token = screen.getByLabelText(/Token da instância/) as HTMLInputElement;
    expect(token.value).toBe("");
    expect(token).toHaveAttribute("type", "password");
  });

  it("o botão vira 'Reconectar' quando já há conexão, e só falta colar o token novo", async () => {
    getMock.mockResolvedValue(conectado);
    render(<CanalGatewayClient />);

    const botao = await screen.findByRole("button", { name: /reconectar/i });
    // URL e id já preenchidos, mas o token está vazio — o botão continua
    // desabilitado até colar o token novo, e é isso que sobra pra fazer.
    expect(botao).toBeDisabled();
  });

  it("sem conexão nenhuma, os campos nascem vazios normalmente (nada a preencher)", async () => {
    getMock.mockResolvedValue(desconectado);
    render(<CanalGatewayClient />);

    const url = (await screen.findByLabelText(/Endereço do servidor/)) as HTMLInputElement;
    expect(url.value).toBe("");
    expect(screen.getByRole("button", { name: /^conectar$/i })).toBeInTheDocument();
  });
});
