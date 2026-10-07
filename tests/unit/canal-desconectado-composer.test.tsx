import { readFileSync } from "node:fs";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CanalDesconectadoAviso } from "@/components/inbox/CanalDesconectadoAviso";

/**
 * O ATENDENTE VÊ O CANAL CAÍDO ANTES DE TENTAR ENVIAR, NÃO DEPOIS DO ERRO.
 *
 * ─── O pedido ────────────────────────────────────────────────────────────────
 *
 * "Eu como administrador nem sempre vou saber que desconectou a conexão do
 * cliente." A Central já avisa o admin (`lib/channels/health.ts`,
 * `STATUS_QUE_AVISAM` → `agent_inbox_items`) — mas quem está ATENDENDO só
 * descobria depois de escrever e levar erro no envio.
 *
 * ─── Por que NÃO reroteia para outra conexão ────────────────────────────────
 *
 * Cada conversa é permanentemente vinculada a UM número — o que o cliente
 * está conversando de verdade. Mandar por outra conexão faria o cliente
 * receber resposta de um WhatsApp diferente do que ele escreveu. A única
 * saída correta é reconectar o número original; por isso o aviso aqui é só
 * informativo, sem seletor de canal alternativo (diferente de
 * `JanelaFechadaAviso`, que TEM saída — modelo aprovado — porque ali o
 * transporte continua de pé).
 *
 * ─── Mesma lista canônica da Central, nunca uma segunda regra ──────────────
 *
 * `STATUS_QUE_AVISAM` já decide quando o admin é avisado. Se a tela usasse
 * outra lista, um estado poderia avisar a Central e não avisar quem atende
 * (ou o contrário) — e as duas divergiriam com o tempo.
 */

describe("CanalDesconectadoAviso — o componente", () => {
  it("nomeia a conexão quando tem apelido", () => {
    render(<CanalDesconectadoAviso apelido="Pousada Por do Sol" />);
    expect(screen.getByText(/"Pousada Por do Sol" está desconectada/)).toBeInTheDocument();
  });

  it("sem apelido, ainda avisa — nunca fica em branco", () => {
    render(<CanalDesconectadoAviso apelido={null} />);
    expect(screen.getByText(/A conexão desta conversa está desconectada/)).toBeInTheDocument();
  });

  it("diz que a NOTA interna continua funcionando — não deixa o atendente achar que está tudo travado", () => {
    render(<CanalDesconectadoAviso apelido={null} />);
    expect(screen.getByText(/Notas internas continuam funcionando/)).toBeInTheDocument();
  });

  it("aponta o caminho — reconectar em Conexões", () => {
    render(<CanalDesconectadoAviso apelido={null} />);
    const link = screen.getByRole("link", { name: /Conexões/i });
    expect(link).toHaveAttribute("href", "/app/connections");
  });

  it("NÃO oferece seletor de canal alternativo — reroteamento troca o número que o cliente vê", () => {
    render(<CanalDesconectadoAviso apelido={null} />);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("os elos que somem sem barulho", () => {
  it("a coluna status chega no embed — sem ela todo canal pareceria saudável", () => {
    const fonte = readFileSync("app/api/v1/conversations/_handler.ts", "utf8");
    expect(fonte).toMatch(
      /channel_sessions:channel_session_id \(phone_number, display_name, provider, status[,)]/,
    );
  });

  it("a tela usa STATUS_QUE_AVISAM — a MESMA lista que já abre aviso na Central", () => {
    const fonte = readFileSync("components/inbox/InboxLayout.tsx", "utf8");
    expect(fonte).toMatch(/from "@\/lib\/channels\/health"/);
    expect(fonte).toMatch(/STATUS_QUE_AVISAM/);
    // Não é uma lista nova, escrita à mão — precisa ser a MESMA constante.
    expect(fonte, "a tela inventou uma lista própria de status caídos").not.toMatch(
      /\["SCAN_QR_CODE"|\['SCAN_QR_CODE'/,
    );
  });

  it("o aviso é MONTADO quando o canal está caído — não só mencionado", () => {
    const fonte = readFileSync("components/inbox/InboxLayout.tsx", "utf8");
    expect(fonte, "o componente não é montado").toMatch(/\n\s*<CanalDesconectadoAviso\b/);
  });

  it("o composer é BLOQUEADO — mesma prop dedicada de janelaFechada, não blockedReason", () => {
    // `blockedReason` desabilita o composer INTEIRO, incluindo a nota interna.
    // Canal caído não pode levar a nota junto — é onde o atendente registra
    // "cliente escreveu, canal caiu" enquanto ninguém reconecta.
    const fonte = readFileSync("components/inbox/InboxLayout.tsx", "utf8");
    expect(fonte).toMatch(/channelDownReason=\{canalCaido/);
  });

  it("a nota interna NÃO é barrada pelo canal caído", () => {
    const fonte = readFileSync("components/inbox/Composer.tsx", "utf8");
    expect(fonte).toMatch(/channelDownReason/);
    expect(fonte, "o canal caído está barrando a nota").toMatch(
      /mode === "reply" && !!channelDownReason/,
    );
  });

  it("canal caído SUPRIME o seletor de modelo da janela — não há saída nenhuma com o transporte fora do ar", () => {
    const fonte = readFileSync("components/inbox/InboxLayout.tsx", "utf8");
    expect(fonte).toMatch(/canalCaido \?[\s\S]*CanalDesconectadoAviso[\s\S]*:[\s\S]*JanelaFechadaAviso/);
  });
});
