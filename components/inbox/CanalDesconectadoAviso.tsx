import Link from "next/link";

/**
 * A conexão desta conversa está fora do ar — e o atendente vê ANTES de tentar
 * escrever, não depois de levar erro no envio.
 *
 * ─── Por que não reroteia para outra conexão ────────────────────────────────
 *
 * Cada conversa é permanentemente vinculada a UM número — é o número que o
 * cliente está conversando de verdade. Mandar por outra conexão faria o
 * cliente receber resposta de um WhatsApp diferente do que ele escreveu,
 * como se outro contato estivesse respondendo. Reconectar o número original
 * é o único caminho correto; ver `lib/channels/health.ts` para o mesmo
 * critério (`STATUS_QUE_AVISAM`) que já abre aviso na Central para o admin.
 *
 * ─── Por que não é `JanelaFechadaAviso` ─────────────────────────────────────
 *
 * A janela de 24h fechada tem uma saída (modelo aprovado) porque o
 * TRANSPORTE continua de pé — só a plataforma recusa texto livre. Canal
 * caído não tem saída nenhuma: não há template que saia por um transporte
 * que não responde. Por isso este aviso é só texto, sem seletor.
 */
export function CanalDesconectadoAviso({ apelido }: { apelido: string | null }) {
  return (
    <div className="border-t border-destructive/40 bg-destructive/10 px-4 py-3 text-xs text-destructive">
      <p>
        {apelido ? `A conexão "${apelido}"` : "A conexão desta conversa"} está desconectada — nenhuma
        mensagem sai até ela voltar.
      </p>
      <p className="mt-1 text-destructive/80">
        Peça para um administrador reconectar em{" "}
        <Link href="/app/connections" className="font-medium underline underline-offset-2">
          Conexões
        </Link>
        . Notas internas continuam funcionando normalmente.
      </p>
    </div>
  );
}
