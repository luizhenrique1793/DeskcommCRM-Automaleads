/**
 * Entrada do UAZAPI — leitura pura do payload do webhook.
 *
 * ⚠️ MEDIDO em homologação real (2026-08-13), e DIVERGE do que o OpenAPI
 * 2.1.1 documenta. O `WebhookEvent` do spec promete `{event, instance, data}`
 * — este parser foi escrito em cima disso, e o primeiro teste com instância
 * real devolveu "evento_sem_interesse" para TODO evento (mensagem de texto e
 * mudança de conexão), porque o payload de verdade é outro:
 *
 *   evento de mensagem:  { EventType: "messages", message: {...}, chat: {...},
 *                          instanceName: "...", owner, token, BaseUrl }
 *   evento de conexão:   { EventType: "connection", instance: {name, status,
 *                          qrcode?, paircode?}, instanceName: "...", ... }
 *
 * Chave PascalCase (`EventType`, não `event`), sem envelope `data` genérico,
 * e a instância identifica-se por `instanceName`/`instance.name` — nunca por
 * um `instance.id` solto. Este parser aceita OS DOIS formatos (o medido e o
 * documentado): instalações diferentes do UAZAPI podem rodar versões de
 * backend diferentes, e não há necessidade de escolher um para sempre.
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

  // `EventType` é o campo REAL (medido); `event` é o documentado no OpenAPI.
  const event = str(p.EventType) ?? str(p.event);
  if (!event) return null;

  // A instância se identifica por NOME nos dois formatos reais observados —
  // `instanceName` (string, topo) para evento de mensagem, `instance.name`
  // (dentro do objeto) para evento de conexão. `resolveUazapiCreds`/
  // `getStatus` também leem `instance.name` (não `.id`) por este MESMO
  // motivo — ver o porquê em `./client.ts`.
  const instanceObj = obj(p.instance);
  const instanceComoString = typeof p.instance === "string" ? str(p.instance) : null;
  const instance = str(p.instanceName) ?? (instanceObj ? str(instanceObj.name) : instanceComoString);

  // Onde o CORPO do evento mora, dependendo do formato:
  //   real, evento de mensagem: `message` (objeto solto no topo)
  //   real, evento de conexão:  `instance` (o mesmo objeto lido acima)
  //   documentado:               `data`
  const data = obj(p.message) ?? instanceObj ?? obj(p.data);

  return { event, instance, data };
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
 * `EventType`/`event` que carregam um objeto de MENSAGEM — real (`messages`,
 * plural, medido) e documentado (`message`, singular, OpenAPI). O evento de
 * DESFECHO (`parseUazapiStatus`) usa a MESMA lista: não há um `EventType`
 * separado para isso na realidade medida — o que distingue as duas coisas é
 * o campo `status` dentro do objeto (vazio numa mensagem normal, preenchido
 * num desfecho), não o nome do evento.
 */
const EVENTOS_DE_MENSAGEM = new Set(["messages", "message"]);

/**
 * Lê um evento de mensagem. `null` quando não interessa: grupo, sem `sender`
 * usável, ou faltam os dois ids que identificam a linha.
 */
export function parseUazapiMessage(env: UazapiEnvelope): UazapiInboundMessage | null {
  if (!EVENTOS_DE_MENSAGEM.has(env.event) || !env.data) return null;
  const m = env.data;

  if (m.isGroup === true) return null; // grupos: SKIP CRM binding (política do produto)

  const chatId = str(m.chatid);
  const externalId = str(m.messageid);
  if (!chatId || !externalId) return null;

  const fromMe = m.fromMe === true;
  const identity = fromMe ? identityFromChatId(chatId, str(m.senderName)) : resolveUazapiIdentity(m);
  if (!identity.anchor) return null; // sem quem, não há a quem atribuir

  // `type` é o rótulo SIMPLES ("text","image","ptt",...) — o MESMO vocabulário
  // de `/send/media`. `messageType` é o nome do protobuf interno do WhatsApp
  // ("Conversation","ImageMessage",...) — medido em produção: uma mensagem de
  // TEXTO PURO chega com `type:"text"` e `messageType:"Conversation"` ao
  // mesmo tempo. Usar `messageType` como discriminante de mídia classificaria
  // TODO texto como mídia; `type` é quem bate com o vocabulário que
  // `../ingest.ts` já sabe traduzir (`tipoDeMidia`/`mimeHintDeMidia`).
  const tipo = str(m.type);
  const isMedia = !!tipo && tipo !== "text";
  const ts = typeof m.messageTimestamp === "number" && m.messageTimestamp > 0 ? m.messageTimestamp : null;

  return {
    direction: fromMe ? "outbound" : "inbound",
    kind: "message",
    chatId,
    externalId,
    text: str(m.text),
    mediaType: isMedia ? tipo : null,
    fileUrl: isMedia ? str(m.fileURL) : null,
    sentAt: ts ? new Date(ts).toISOString() : null,
    identity,
  };
}

/**
 * Lê um evento de DESFECHO — só atualiza o status de uma mensagem que já
 * existe (mesma lógica do canal intermediado: nunca cria linha).
 *
 * Compartilha o `EventType` com `parseUazapiMessage` (ver o porquê acima) —
 * o campo `status` NÃO-VAZIO dentro do objeto é o que diferencia um desfecho
 * de uma mensagem normal (que chega com `status: ""`). Também aceita
 * `EventType: "status"`, caso algum backend do UAZAPI o envie separado, como
 * o OpenAPI sugere.
 */
export function parseUazapiStatus(env: UazapiEnvelope): UazapiInboundMessage | null {
  const eventoValido = EVENTOS_DE_MENSAGEM.has(env.event) || env.event === "status";
  if (!eventoValido || !env.data) return null;
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
 * vocabulário de saúde do CRM. `channel_sessions.status` tem CHECK no banco
 * (`channel_sessions_status_check`) que só aceita EXATAMENTE estes cinco:
 * `STARTING | SCAN_QR_CODE | WORKING | STOPPED | FAILED`.
 *
 * ÚNICO lugar que faz esta tradução — nenhum ponto de escrita em
 * `channel_sessions.status` grava vocabulário cru do UAZAPI (nem literal tipo
 * `"connecting"`/`"disconnected"`, que já derrubou um INSERT contra o CHECK em
 * homologação: `new row for relation "channel_sessions" violates check
 * constraint "channel_sessions_status_check"`). O adapter (`checkHealth`,
 * varredura periódica) e `../inbound.ts` (evento `connection`, empurrão do
 * provedor) chamam esta MESMA função — duas cópias divergiriam com o tempo, e
 * o webhook diria uma coisa enquanto a varredura diz outra para o mesmo
 * estado real.
 *
 * O tipo de retorno é a UNIÃO LITERAL dos cinco valores — não `string` — para
 * que `tsc` reprove em compilação qualquer chamador que tente gravar algo
 * fora dela, sem depender de um `Set` checado em runtime (que só protege se
 * alguém lembrar de chamá-lo).
 *
 * ─── Estado desconhecido: degrada para STOPPED, NUNCA para WORKING ─────────
 *
 * O enum oficial de `Instance.status` (OpenAPI 2.1.1) só tem os quatro
 * valores abaixo — não existe "erro" nele. `FAILED` é decidido em CAMADA
 * DIFERENTE (o adapter trata 401/403 do token como FAILED, ANTES de chamar
 * esta função — ver `../adapters/uazapi.ts`). Se mesmo assim chegar aqui um
 * valor fora do enum (API mudou, resposta corrompida), o `default` devolve
 * `STOPPED`: nenhuma mensagem entra/sai, e o operador é avisado — dizer
 * `WORKING` para um estado que não se reconhece seria a inversão exata do que
 * o vigia de saúde existe para evitar.
 */
export type CanonicalChannelStatus = "STARTING" | "SCAN_QR_CODE" | "WORKING" | "STOPPED" | "FAILED";

export function mapUazapiHealthStatus(status: string): CanonicalChannelStatus {
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

/**
 * Redação do segredo que o PRÓPRIO UAZAPI embute no corpo do webhook.
 *
 * ⚠️ MEDIDO em homologação real (2026-08-13): o payload real inclui um campo
 * `token` — o token da instância, em TEXTO PURO — direto na raiz do evento,
 * tanto para mensagem quanto para conexão. Não é desenho nosso: é o UAZAPI
 * ecoando o próprio segredo de volta em cada chamada. O problema é que
 * `webhook_events_log.raw_body`/`payload_parsed` arquivam o corpo cru SEM
 * cifra — desenho válido para todo provider que NÃO vaza segredo no corpo
 * (WAHA, Meta, Zernio não fazem isso) — então, sem isto, o token do operador
 * ficaria gravado em claro a cada evento recebido.
 *
 * ─── Onde isto entra, e onde NÃO entra ──────────────────────────────────────
 *
 * Só na CÓPIA que vai para o arquivo (`../arquivo-de-webhook.ts`). O parser
 * (`parseUazapiEnvelope` e o resto deste módulo) continua lendo o corpo
 * ORIGINAL, intacto — redigir o que o parser vê arriscaria produzir um
 * desfecho diferente do que o UAZAPI de fato mandou, e o objetivo aqui é só
 * não PERSISTIR o segredo, não impedir de processá-lo.
 *
 * ─── Por que uma LISTA de chaves, não um regex "parece token" ──────────────
 *
 * Uma heurística genérica (campo com >20 caracteres, por exemplo) apagaria
 * dado útil de verdade: `messageid`, `chatid`, `sender_pn`/`sender_lid` são
 * todos strings longas e são exatamente o que a investigação de um bug real
 * precisa enxergar. A lista cobre variações de grafia plausíveis do MESMO
 * conceito (token da instância/API) — não qualquer string comprida.
 */
const CAMPOS_DE_TOKEN = new Set([
  "token",
  "Token",
  "apiToken",
  "apitoken",
  "ApiToken",
  "instanceToken",
  "instance_token",
  "adminToken",
  "admintoken",
]);

type ValorJson = string | number | boolean | null | ValorJson[] | { [k: string]: ValorJson };

function redigirCamposDeToken(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(redigirCamposDeToken);
  const o = obj(valor);
  if (!o) return valor;
  const saida: Bruto = {};
  for (const [k, v] of Object.entries(o)) {
    saida[k] = CAMPOS_DE_TOKEN.has(k) ? "[REDACTED]" : redigirCamposDeToken(v);
  }
  return saida;
}

/**
 * A cópia SEGURA de um payload UAZAPI já parseado, para arquivar — nunca
 * usada para decidir o que o evento significa (isso é papel do parser, que
 * lê o corpo original). Percorre em qualquer profundidade: o UAZAPI pode
 * aninhar o campo diferente numa versão futura de backend, e a defesa não
 * deve depender de saber o caminho exato.
 */
export function redactUazapiSecrets(payload: unknown): ValorJson {
  return redigirCamposDeToken(payload) as ValorJson;
}
