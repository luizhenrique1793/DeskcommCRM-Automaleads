/**
 * Entrada do UAZAPI — leitura pura do payload do webhook.
 *
 * Envelope confirmado no OpenAPI 2.1.1 (`WebhookEvent`): `{event, instance,
 * data}`, com `event` em `message | status | presence | group | connection`.
 * `data` é `additionalProperties: true` — o formato de cada evento é o mesmo
 * schema `Message` usado nas respostas de envio, então o parser lê os MESMOS
 * campos dos dois lados.
 *
 * PURO de propósito, como `../zernio/webhook.ts`: nada aqui toca banco, rede
 * ou relógio — só decide o que o payload diz. `null` sempre que o evento não
 * interessa, nunca lança: a rota responde 200 e o provider para de reentregar
 * um payload que nunca vai servir.
 *
 * ─── Por que não há verificação de assinatura aqui ───────────────────────────
 *
 * O UAZAPI não assina o corpo do webhook (nenhum campo de HMAC/secret no
 * `components.schemas.Webhook` nem em `WebhookEvent` do OpenAPI 2.1.1) —
 * diferente de WAHA (HMAC SHA512) e do canal intermediado (HMAC SHA256). A
 * segurança deste canal é o `webhook_path_token` da rota genérica
 * (`app/api/v1/webhooks/channel/[token]/route.ts`): sem o token de 24+ bytes
 * na URL a rota nem chega a resolver a sessão. Isto é uma restrição REGISTRADA
 * (invariante 4 de `docs/doctrine/restricao-de-canal.md`), não uma omissão —
 * `handleInboundWebhook` não exige `secret` para este provider.
 *
 * ─── Grupos ────────────────────────────────────────────────────────────────
 *
 * Mensagem de grupo é ignorada de propósito, mesma política do canal por QR
 * (CLAUDE.md: "Grupos: SKIP CRM binding"). `isGroup` já vem pronto no payload
 * — não precisa inferir pelo sufixo do JID.
 */

type Bruto = Record<string, unknown>;
const obj = (v: unknown): Bruto | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Bruto) : null;
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export interface UazapiEnvelope {
  event: "message" | "status" | "presence" | "group" | "connection" | string;
  instance: string | null;
  data: Bruto | null;
}

export function parseUazapiEnvelope(payload: unknown): UazapiEnvelope | null {
  const p = obj(payload);
  if (!p) return null;
  const event = str(p.event);
  if (!event) return null;
  return { event, instance: str(p.instance), data: obj(p.data) };
}

/** `+E164` ou `lid:<digitos>` — mesmo vocabulário de `contacts.wa_identity`. */
export interface UazapiIdentity {
  phone: string | null;
  lid: string | null;
  displayName: string | null;
  /** `null` = payload sem identidade utilizável (recusar, não inventar contato). */
  anchor: { kind: "phone" | "lid"; value: string } | null;
}

/**
 * Só dígitos, com o `+` de fora — é o formato que `contacts.phone_number` e
 * `wa_identity` (`phone:+E164`) já usam no resto do sistema.
 */
function digitsFromJid(jid: string): string {
  return jid.split("@")[0]!.replace(/\D/g, "");
}

function anchorFrom(phone: string | null, lid: string | null): UazapiIdentity["anchor"] {
  return phone ? { kind: "phone", value: `+${phone}` } : lid ? { kind: "lid", value: lid } : null;
}

/**
 * A identidade de quem MANDOU, priorizando os campos JÁ RESOLVIDOS
 * (`sender_pn`/`sender_lid`) sobre reconstruir do `sender` cru.
 *
 * Só serve para mensagem RECEBIDA (`fromMe: false`): `sender` é o outro lado
 * da conversa quando a mensagem é dele. Numa mensagem NOSSA (`fromMe: true`)
 * `sender` é a PRÓPRIA instância — usar esta função aí identificaria o
 * contato como nós mesmos. Ver `identityFromChatId` para o caso outbound.
 *
 * ─── Por que os dois campos resolvidos vêm ANTES do fallback ────────────────
 *
 * Quando o WhatsApp identifica o contato só por LID, `sender` normalmente traz
 * o `@lid` — mas o UAZAPI já resolve o par (telefone quando souber + LID
 * original) nos campos dedicados. Usar os dois preenche `phone` e `lid` juntos
 * na MESMA mensagem, sem precisar de uma segunda chamada
 * (`resolvePhoneForIdentity`) — o requisito de "não perder o telefone
 * conhecido ao receber uma identidade LID" fica resolvido na origem.
 */
export function resolveUazapiIdentity(m: Bruto): UazapiIdentity {
  const senderPn = str(m.sender_pn);
  const senderLid = str(m.sender_lid);
  const sender = str(m.sender);
  const senderName = str(m.senderName);

  let phone: string | null = senderPn ? digitsFromJid(senderPn) : null;
  let lid: string | null = senderLid ? digitsFromJid(senderLid) : null;
  // Sem os campos resolvidos: decide pelo sufixo do `sender` cru.
  if (!phone && !lid && sender) {
    if (sender.endsWith("@lid")) lid = digitsFromJid(sender);
    else phone = digitsFromJid(sender);
  }

  return { phone: phone ? `+${phone}` : null, lid, displayName: senderName, anchor: anchorFrom(phone, lid) };
}

/**
 * A identidade do OUTRO LADO da conversa, para mensagem `fromMe: true`.
 *
 * `chatid` identifica com quem é a conversa (já filtramos grupo antes de
 * chegar aqui, então para 1:1 `chatid` é sempre o par). Sem `sender_pn`/
 * `sender_lid` equivalentes para esta direção — o payload não os traz —, então
 * só uma âncora sai daqui, pelo sufixo do próprio `chatid`.
 */
function identityFromChatId(chatId: string, displayName: string | null): UazapiIdentity {
  const phone = chatId.endsWith("@lid") ? null : digitsFromJid(chatId);
  const lid = chatId.endsWith("@lid") ? digitsFromJid(chatId) : null;
  return { phone: phone ? `+${phone}` : null, lid, displayName, anchor: anchorFrom(phone, lid) };
}

export type UazapiInboundKind = "message" | "status";

export interface UazapiInboundMessage {
  direction: "inbound" | "outbound";
  kind: UazapiInboundKind;
  status?: "sent" | "delivered" | "read" | "failed";
  errorReason?: string | null;
  chatId: string;
  externalId: string;
  text: string | null;
  mediaType: string | null;
  fileUrl: string | null;
  sentAt: string | null;
  identity: UazapiIdentity;
}

/** `Message.status` (livre, vocabulário do provider) → o que o CRM grava. */
const STATUS_MAP: Record<string, "sent" | "delivered" | "read" | "failed"> = {
  Sent: "sent",
  Delivered: "delivered",
  Read: "read",
  Failed: "failed",
  Canceled: "failed",
};

/**
 * Lê um evento `message`. `null` quando não interessa: grupo, sem `sender`
 * usável, ou faltam os dois ids que identificam a linha.
 */
export function parseUazapiMessage(env: UazapiEnvelope): UazapiInboundMessage | null {
  if (env.event !== "message" || !env.data) return null;
  const m = env.data;

  if (m.isGroup === true) return null; // grupos: SKIP CRM binding (política do produto)

  const chatId = str(m.chatid);
  const externalId = str(m.messageid);
  if (!chatId || !externalId) return null;

  const fromMe = m.fromMe === true;
  const identity = fromMe ? identityFromChatId(chatId, str(m.senderName)) : resolveUazapiIdentity(m);
  if (!identity.anchor) return null; // sem quem, não há a quem atribuir

  const messageType = str(m.messageType) ?? "text";
  const isMedia = messageType !== "text" && messageType !== "chat";
  const ts = typeof m.messageTimestamp === "number" && m.messageTimestamp > 0 ? m.messageTimestamp : null;

  return {
    direction: fromMe ? "outbound" : "inbound",
    kind: "message",
    chatId,
    externalId,
    text: str(m.text),
    mediaType: isMedia ? messageType : null,
    fileUrl: isMedia ? str(m.fileURL) : null,
    sentAt: ts ? new Date(ts).toISOString() : null,
    identity,
  };
}

/**
 * Lê um evento `status` — só atualiza o desfecho de uma mensagem que já
 * existe (mesma lógica do canal intermediado: nunca cria linha).
 */
export function parseUazapiStatus(env: UazapiEnvelope): UazapiInboundMessage | null {
  if (env.event !== "status" || !env.data) return null;
  const m = env.data;

  const externalId = str(m.messageid);
  const statusBruto = str(m.status);
  if (!externalId || !statusBruto) return null;
  const status = STATUS_MAP[statusBruto];
  if (!status) return null;

  return {
    direction: "outbound",
    kind: "status",
    status,
    errorReason: status === "failed" ? str(m.error) : null,
    chatId: str(m.chatid) ?? "",
    externalId,
    text: null,
    mediaType: null,
    fileUrl: null,
    sentAt: null,
    identity: { phone: null, lid: null, displayName: null, anchor: null },
  };
}

/** Estado da CONEXÃO — mesmo vocabulário de `/instance/status`. */
export interface UazapiConnectionEvent {
  status: string;
}

export function parseUazapiConnection(env: UazapiEnvelope): UazapiConnectionEvent | null {
  if (env.event !== "connection" || !env.data) return null;
  const status = str(env.data.status) ?? str(obj(env.data.instance)?.status);
  if (!status) return null;
  return { status };
}

/**
 * `/instance/status` (`disconnected|connecting|connected|hibernated`) → o
 * vocabulário de saúde do CRM (`WORKING`/`SCAN_QR_CODE`/`STOPPED`).
 *
 * Único lugar que faz esta tradução: o adapter (`checkHealth`, varredura
 * periódica) e este módulo (evento `connection`, empurrão do provedor) usam a
 * MESMA função — duas cópias divergiriam com o tempo, e o webhook diria uma
 * coisa enquanto a varredura diz outra para o mesmo estado real.
 */
export function mapUazapiHealthStatus(status: string): string {
  switch (status) {
    case "connected":
      return "WORKING";
    case "connecting":
      // A doc do endpoint chama isto de "aguardando QR code ou código de
      // pareamento" — o mesmo estado que `SCAN_QR_CODE` representa nos outros
      // canais (dispara o aviso "precisa escanear o QR de novo").
      return "SCAN_QR_CODE";
    case "hibernated":
      // Sessão pausada com credenciais preservadas: nenhuma mensagem entra ou
      // sai enquanto durar. Sem confirmação de que reconecta sozinha ao
      // primeiro envio, trata como parada — conservador, avisa o operador em
      // vez de deixar mensagem represada em silêncio.
      return "STOPPED";
    case "disconnected":
    default:
      return "STOPPED";
  }
}
