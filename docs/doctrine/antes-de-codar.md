# Antes de codar — checklist de triagem

> Doutrina irmã de [`sistema-vivo.md`](./sistema-vivo.md). Não é filosofia — é a
> pergunta que se responde **antes** de abrir o editor, quando o dono do sistema
> pede "um agente novo", "uma alteração" ou "uma funcionalidade nova".

---

## O princípio-raiz

**O DeskcommCRM tem uma camada de configuração maior do que a maioria dos
pedidos precisa atravessar.** Múltiplos agentes, roteador de intenção,
capacidades HTTP, follow-up em grafo, guardrails por camada, skills
situacionais e webhooks já existem como mecanismo genérico, configurável por
tela ou por banco, **sem deploy**. Boa parte do que soa como "feature nova" é,
na verdade, "configuração nova" de um mecanismo que já existe.

Codar quando dava para configurar tem custo real neste projeto: toda mudança
de schema é migration versionada + apêndice no baseline + linha no MANIFEST
(`CLAUDE.md`), toda tela nova precisa de porta na navegação e entra no Living
System Checklist, e todo PR carrega os quatro gates obrigatórios de CI. Configurar
é minutos; codar é uma sessão inteira de doutrina para cumprir.

O erro oposto também existe e é pior: forçar um pedido dentro de um mecanismo
que não serve **porque parece o mais próximo** produz gambiarra escondida —
pior do que ter escrito código, porque some do radar. Este documento é sobre
diagnosticar direito, não sobre evitar código a qualquer custo.

---

## Tabela de decisão rápida

| O dono pediu... | Provável mecanismo | Onde configurar | Quando REALMENTE vira código |
|---|---|---|---|
| "Quero um agente que atenda [nicho/produto/fila] diferente" | Agente novo (`ai_agents`) + Roteador (`ai_routers`) | `/app/ai/agents` (criar, publicar) + `/app/ai/routers` (intenção → agente) | Se o comportamento exigir uma tool MCP que não existe no catálogo |
| "O agente devia falar com [sistema externo: ERP, planilha, gateway de pagamento, API do fornecedor]" | Capacidade HTTP (`mcp_http_capability_calls`) | Aba Capacidades em `/app/ai/agents/[id]` | Se a TOOL em si não existe (schema de input/output novo, parsing de resposta que a tela não cobre) |
| "Depois de X dias sem resposta, manda uma mensagem/abre um caso/escala" | Follow-up (grafo de nós/edges) | `/app/ai/followups` | Se o gatilho precisar de um sinal que o motor não capta hoje (novo tipo de evento) |
| "O agente não pode fazer/dizer [X]" | Guardrail (camada configurável) | Aba Segurança em `/app/ai/agents/[id]` (`PainelDeSeguranca.tsx`) | Se a verificação for determinística e não existir nenhuma das ~10 camadas do before-send — aí é gate novo em `before-send.ts` |
| "Quando o cliente fala de [assunto/objeção específica], o agente deve seguir este roteiro" | Skill situacional | `/app/ai/skills` | Se o gatilho não for keyword-matching (ex.: precisa de sinal temporal ou de estágio) — o `matcher` é jsonb extensível, mas o tipo de matcher em si é código |
| "Quando algo acontece no [sistema externo], quero que o CRM reaja" | Webhook (`webhook_sources`) | `/app/webhooks` | Se o payload do webhook exigir mapeamento/transformação que a tela de captação não cobre |
| "Quero outro papel do agente rodando junto (operação, além de conversa)" | Papel de Operador dentro do mesmo agente (`operator_enabled`) | Aba do agente em `/app/ai/agents/[id]` | Raramente — é toggle + prompt/model/tools do operador, tudo já configurável |
| "Quero trocar o modelo/provider de uma etapa específica da IA (embedding, classificação de sentimento, etc.)" | Ponto de IA (`ai_purpose_bindings`) | `/app/ai/providers` | Só se o PONTO em si (a chamada de LLM) ainda não existe no catálogo (`lib/ai/pontos/registro.ts`) |

Se a linha da tabela não cobrir o pedido, ou se a resposta cair sempre na
coluna "quando vira código", é código mesmo — mas prove isso primeiro, não
suponha.

---

## Os mecanismos, um a um

### 1. Múltiplos agentes + roteador

Uma organização pode publicar **vários agentes de IA** (`ai_agents` /
`ai_agent_versions`), cada um com seu próprio prompt, modelo/provider,
credencial, conjunto de tools MCP habilitadas, e configuração de handoff. Sem
roteador, o dispatcher escolhe por `priority DESC` + `created_at ASC` — só
1 agente responde por mensagem.

Com um **Roteador de Intenção** (`ai_routers` / `ai_router_members`,
código em `lib/agent-engine/agent/router-config.ts`), a escolha de qual
agente atende deixa de ser por prioridade estática e passa a ser um
classificador (modelo próprio, configurável) que lê a intenção da mensagem e
decide entre os "membros" do roteador — cada membro é um agente com um nome e
descrição de intenção. Tem `sticky` (mantém o mesmo agente na mesma conversa),
confiança mínima e agente de fallback.

- **Onde se configura:** `/app/ai/agents` (criar/publicar agente),
  `/app/ai/routers` (criar roteador, associar membros, testar).
- **Dá pra fazer sem código:** múltiplos agentes especializados por
  assunto/fila/nicho dentro do mesmo tenant, com roteamento automático por
  intenção.
- **Limite real:** roteador só escolhe **1** agente por mensagem — não é
  orquestração multi-agente dentro do mesmo turno. Se o pedido for "dois
  agentes colaborando na mesma resposta", isso não existe hoje.

### 2. Capacidades HTTP

Toda tool MCP que faz uma chamada HTTP a um sistema externo pode ter essa
chamada **redirecionada por configuração**, por organização: base URL, método,
headers, autenticação (bearer/api_key/basic), query/path params, mapeamento de
campos do corpo e da resposta, timeout, TLS. A configuração da tela **vence**
o comportamento hardcoded no código quando preenchida; vazia, cai no
hardcoded (`montarUrlFinal` em `lib/pousada/executor.ts` é o padrão de
"config vence fallback").

- **Onde se configura:** aba Capacidades em `/app/ai/agents/[id]`
  (`EditorDeCapacidadeHttp.tsx`), API `app/api/v1/ai/capability-http-configs/`.
- **Dá pra fazer sem código:** apontar uma tool existente para outra URL,
  outro sistema com API compatível em forma, outra credencial — sem tocar
  em TypeScript.
- **Limite real:** a capacidade redireciona uma tool que **já existe**. Se a
  operação em si é nova — schema de input diferente, lógica de parsing da
  resposta que a tela de mapeamento de campos não cobre — precisa de uma tool
  nova em `lib/mcp/tools/`, e aí é código.

### 3. Follow-up (grafo)

O motor de follow-up (`lib/followup/`) não é um agendador simples — é um
construtor de fluxo em **grafo** (nós + edges), com gatilhos configuráveis
(silêncio, mudança de etapa, caso aberto), condições de ramo, janelas de
tempo, e vocabulário de eventos legível. É o mecanismo anti-morte do
invariante 4 do Sistema Vivo: nenhuma demanda aberta sem próximo passo.

- **Onde se configura:** `/app/ai/followups` (criar fluxo, editar grafo,
  ver inscrições ativas).
- **Dá pra fazer sem código:** sequências de reengajamento, escalonamento por
  silêncio, disparo por mudança de estágio do funil, bifurcação por resposta
  do lead.
- **Limite real:** o grafo reage a **tipos de gatilho que o motor já conhece**
  (`gatilho-caso.ts`, `gatilho-etapa.ts`, silêncio). Um gatilho de natureza
  nova — por exemplo, reagir a um evento de um sistema externo que ainda não
  vira `event_log` — é código.

### 4. Guardrails

`org_guardrail_layers` liga/desliga, por organização, um subconjunto das
camadas de segurança do agente (ex.: `jailbreak_detect`, `promise_semantic`)
sem tocar em código. A leitura é feita por `camadaLigada()`
(`lib/agent-engine/guardrails/camadas-da-org.ts`), consultada pelo motor de
before-send.

- **Onde se configura:** aba Segurança em `/app/ai/agents/[id]`
  (`PainelDeSeguranca.tsx`), API `app/api/v1/ai/guardrail-layers/`.
- **Dá pra fazer sem código:** ligar/desligar camadas específicas por
  organização — algumas orgs querem o detector de jailbreak mais rígido,
  outras não precisam de checagem de promessa semântica.
- **Limite real:** só as camadas que já existem no catálogo são
  configuráveis. A maior parte das ~10 verificações do before-send
  (`lib/agent-engine/guardrails/before-send.ts`) é determinística e sempre ativa —
  não tem toggle porque não é opcional (ex.: vazamento de vocabulário
  interno). Uma checagem **nova** — um padrão de risco que ninguém cobre
  ainda — é gate novo no código, não configuração.

### 5. Skills situacionais

Playbooks de situação (objeção de preço, reativação, agendamento, resposta a
um assunto específico) publicados como **skill**: um índice curto
(nome + descrição) sempre no prompt, e um corpo mais longo que só entra no
contexto quando o matcher determinístico (keywords) dispara na última
mensagem do lead. Versionado com ponteiro — trocar/reverter é mover o
ponteiro, sem restart. Ver `lib/agent-engine/agent/skills.ts`.

- **Onde se configura:** `/app/ai/skills` (criar/publicar skill, keywords de
  ativação, corpo do playbook). Existe também import de skill via API
  (`app/api/v1/ai/skills/import/`).
- **Dá pra fazer sem código:** qualquer roteiro de atendimento condicionado a
  o cliente ter mencionado algo específico — sem mexer no prompt base do
  agente, sem inflar o contexto em turnos onde a situação não se aplica.
- **Limite real:** o matcher hoje é por **keyword** (substring normalizado).
  Se o gatilho precisar de outro tipo de sinal — tempo desde o último
  contato, estágio do funil, dado estruturado — o campo `matcher` é jsonb
  extensível, mas o **tipo** de matcher em si (o código que interpreta esse
  jsonb) precisa ser escrito.

### 6. Webhooks

`webhook_sources` + `webhook_events_log` permitem captar eventos de sistemas
externos (e-commerce, ERPs) e reagir dentro do CRM — captação e regras
QUANDO/SE/ENTÃO, mais os webhooks que o próprio DeskcommCRM emite. WAHA
também entrega mensagem inbound via webhook.

- **Onde se configura:** `/app/webhooks`.
- **Dá pra fazer sem código:** conectar um novo evento externo — desde que o
  formato do payload seja mapeável pela tela — a uma ação dentro do CRM.
- **Limite real:** se o payload do sistema externo tem forma que a tela de
  mapeamento não cobre, ou se a reação exige lógica além de QUANDO/SE/ENTÃO,
  é código.

### 7. MCP tools em geral (a linha divisória)

Cada tool que um agente pode chamar (`crm_search_contacts`,
`crm_move_lead_stage`, etc.) é um arquivo TypeScript em `lib/mcp/tools/` com
schema Zod de input + handler. **Criar uma tool do zero é sempre código** —
isso não é configurável pela tela. O que É configurável é: (a) quais tools um
agente específico tem habilitadas (`tool_ids` na versão do agente), e (b) para
onde a chamada HTTP de dentro de uma tool aponta (ver Capacidades HTTP,
acima). A pergunta que separa configuração de código, nesse eixo, é sempre:
**a operação já existe como tool? Ou é uma operação nova no CRM?**

---

## Processo recomendado antes de implementar

1. **Entenda o pedido em uma frase, sem vocabulário de sistema.** O que o
   dono quer que aconteça, do ponto de vista de quem opera o negócio — não
   "quero uma tabela nova", mas "quero que o agente pare de falar sobre preço
   sem antes checar estoque".
2. **Passe pela tabela de decisão** (acima). Pelo menos um mecanismo
   normalmente casa com o pedido — se nenhum casar de forma clara, ainda
   assim leia as seções 1–7 antes de descartar: um pedido pode parecer novo e
   ser dois mecanismos existentes combinados (ex.: skill + capacidade HTTP).
3. **Verifique se o mecanismo cobre o caso concreto, não só a categoria.**
   "Follow-up resolve lembrete" é verdade em geral, mas o gatilho específico
   pedido pode não existir ainda no motor — teste a hipótese lendo o código
   do mecanismo antes de prometer que dá pra configurar.
4. **Se configurável: configure pela tela, não pelo banco direto.** Escrever
   direto no banco quebra o invariante 6 do Sistema Vivo (toda configuração
   tem superfície) — se a tela não expõe o campo que você precisa mudar, isso
   por si só é um bug de superfície a corrigir, não uma licença para pular a
   tela.
5. **Se não é configurável: escreva o motivo antes de codar.** Uma frase
   nomeando qual mecanismo quase serviu e por que não serve — isso vira o
   registro de que a triagem aconteceu, e ajuda quem ler depois a não repetir
   a pergunta. Só então siga a doutrina normal de código deste repo
   (`CLAUDE.md`: migration versionada, RLS, DoD, Living System Checklist).

Uma triagem que pula direto para "vou implementar" sem passar pela tabela é o
modo de falha que este documento existe para evitar.
