/**
 * Cliente HTTP para o PMS proprietário da Pousada Por do Sol
 * (`POUSADA_PMS_BASE_URL`) — fonte da verdade de quartos, disponibilidade,
 * reservas e cobrança PIX.
 *
 * Compartilhado entre `lib/mcp/tools/pousada.ts` (tools do agente de IA) e
 * `app/api/v1/cron/pix-watcher/route.ts` (monitoramento assíncrono do PIX) —
 * migrado do fluxo n8n "Agente Mestre PRINCIPAL DE RESERVAS" (ago/2026), que
 * chamava este mesmo PMS via httpRequest.
 *
 * O PMS não tem autenticação própria (rede fechada + headers fixos simulando
 * o front-end oficial, herdado do n8n original) e usa certificado
 * autoassinado — por isso `rejectUnauthorized: false`.
 */
import https from "node:https";

const PMS_HEADERS_BASE = {
  accept: "application/json, text/plain, */*",
  referer: "https://pordosol.ddns.net:5005/",
  origin: "https://45.234.143.22:5005/",
};

/**
 * `baseUrl` vem sempre de `loadPousadaSettings()` (organizations.settings.pousada,
 * com fallback pro env POUSADA_PMS_BASE_URL) — nunca hardcoded aqui, para a
 * tela de configurações da pousada valer sem precisar de deploy novo.
 */
export function pmsRequest(method: "GET" | "POST", path: string, baseUrl: string, body?: unknown): Promise<unknown> {
  if (!baseUrl) {
    return Promise.reject(
      new Error("pms_nao_configurado: defina o endereço do sistema da pousada em Configurações → Pousada"),
    );
  }
  const url = new URL(path, baseUrl);
  const payload = body !== undefined ? JSON.stringify(body) : undefined;

  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method,
        rejectUnauthorized: false,
        timeout: 15_000,
        headers: {
          ...PMS_HEADERS_BASE,
          ...(payload
            ? {
                "content-type": "application/json;charset=UTF-8",
                "content-length": Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          if (status >= 400) {
            reject(new Error(`pms_http_${status}: ${raw.slice(0, 300)}`));
            return;
          }
          if (!raw) {
            resolve(null);
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch {
            // BuscarStatusLocacao (quiosque) e alguns retornos do PMS não são JSON.
            resolve(raw);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("pms_timeout: o sistema da pousada não respondeu a tempo")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** O PMS às vezes envolve o corpo em `{response:[...]}` ou devolve array cru. */
export function unwrapPmsObject(raw: unknown): Record<string, unknown> {
  if (Array.isArray(raw)) return (raw[0] as Record<string, unknown>) ?? {};
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    if (Array.isArray(r.response)) return (r.response[0] as Record<string, unknown>) ?? {};
    if (Array.isArray(r.data)) return (r.data[0] as Record<string, unknown>) ?? {};
    return r;
  }
  return {};
}

/** Extrai um id numérico de retornos heterogêneos do PMS (número, string, array, objeto). */
export function extrairId(raw: unknown, ...campos: string[]): string {
  let v: unknown = raw;
  if (Array.isArray(v)) v = v[0];
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const r = v as Record<string, unknown>;
    for (const campo of campos) {
      if (r[campo] !== undefined && r[campo] !== null) {
        v = r[campo];
        break;
      }
    }
    if (v && typeof v === "object") v = null;
  }
  return String(v ?? "").replace(/\D/g, "");
}

export function formatarTelefoneBR(numero: string): string | null {
  let n = String(numero || "").replace(/\D/g, "");
  if (n.startsWith("55") && n.length >= 12) n = n.slice(2);
  if (n.length === 11) return `(${n.slice(0, 2)}) ${n.slice(2, 7)}-${n.slice(7)}`;
  if (n.length === 10) return `(${n.slice(0, 2)}) ${n.slice(2, 6)}-${n.slice(6)}`;
  return n || null;
}

export function formatarCpf(cpf: string): string {
  const d = cpf.replace(/\D/g, "");
  return d.length === 11 ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : cpf;
}
