"use client";
/**
 * Editor técnico de uma capacidade que chama API externa — estilo do node
 * "HTTP Request" do n8n: método, base URL, endpoint, headers, query/path
 * params, corpo (valores fixos + mapeamento de campos do agente),
 * autenticação, timeout, TLS.
 *
 * A config é POR ORGANIZAÇÃO — vale para todos os agentes que usam esta
 * capacidade, não só o agente de onde o editor foi aberto (mesmo PMS por
 * trás). Persistida em `mcp_http_capability_calls` (migration 0149), lida
 * pelo executor em runtime (`lib/pousada/executor.ts`); sem nenhuma linha
 * salva (ou desligada), a capacidade continua se comportando exatamente como
 * antes desta tela existir.
 */
import * as React from "react";
import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Copy } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";

import { testPousadaTool } from "@/app/actions/settings/testPousadaTool";
import { montarUrlFinal } from "@/lib/pousada/http-capability-calls";
import {
  useCapabilityHttpConfig,
  useSaveCapabilityHttpConfig,
  type CapabilityHttpCall,
  type CapabilityHttpCallWrite,
  type CapabilityHttpMethod,
  type CapabilityHttpAuthType,
} from "@/hooks/ai/useCapabilityHttpConfig";
import { KeyValueListEditor, type KeyValueRow } from "./KeyValueListEditor";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  toolName: string;
  toolLabel: string;
  /** JSON de exemplo pro painel "Testar agora" (mesmos exemplos já usados no teste manual). */
  exemploTestArgs: string;
}

const METODOS: CapabilityHttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const METODO_PADRAO = "__padrao__";

const AUTH_LABELS: Record<CapabilityHttpAuthType, string> = {
  none: "Nenhuma",
  bearer: "Bearer token",
  api_key_header: "API key (header)",
  api_key_query: "API key (query param)",
  basic: "Basic auth",
};

function paraDraft(call: CapabilityHttpCall): CapabilityHttpCallWrite {
  const { auth_secret_last4: _drop, ...rest } = call;
  return { ...rest, auth_secret: "", auth_secret_clear: false };
}

function paramsParaLinhas(params: CapabilityHttpCallWrite["query_params"]): KeyValueRow[] {
  return params.map((p) => ({ key: p.key, value: p.value, source: p.source }));
}
// SEM filtro/trim de propósito — usada a cada onChange (inclusive o clique em
// "Adicionar", que nasce com key:""). Filtrar aqui apagava a linha vazia no
// mesmo clique que a criava, antes de dar tempo de digitar a chave (bug
// reportado: "clico em adicionar header, nada acontece" — mesma causa em
// query/path params e no mapeamento de corpo). Filtro entra só em
// `sanitizarParaSalvar`, na hora de montar o payload do PUT.
function linhasParaParams(rows: KeyValueRow[]): CapabilityHttpCallWrite["query_params"] {
  return rows.map((r) => ({ key: r.key, source: r.source ?? "fixed", value: r.value }));
}

function bodyMapParaLinhas(map: CapabilityHttpCallWrite["body_field_map"]): KeyValueRow[] {
  return map.map((m) => ({ key: m.api_field_path, value: m.value, source: m.source }));
}
// Mesmo motivo de linhasParaParams acima — sem filtro durante a edição.
function linhasParaBodyMap(rows: KeyValueRow[]): CapabilityHttpCallWrite["body_field_map"] {
  return rows.map((r) => ({ api_field_path: r.key, source: r.source ?? "fixed", value: r.value }));
}

function responseMapParaLinhas(map: CapabilityHttpCallWrite["response_field_map"]): KeyValueRow[] {
  return map.map((m) => ({ key: m.agent_field, value: m.response_path }));
}
// Mesmo motivo de linhasParaParams acima — sem filtro durante a edição.
function linhasParaResponseMap(rows: KeyValueRow[]): CapabilityHttpCallWrite["response_field_map"] {
  return rows.map((r) => ({ agent_field: r.key, response_path: r.value }));
}

/**
 * Filtro/trim de linha vazia que ANTES rodava a cada tecla (ver comentário
 * acima) — movido pra cá, chamado só na hora de montar o payload do "Salvar".
 */
function sanitizarParaSalvar(draft: CapabilityHttpCallWrite): CapabilityHttpCallWrite {
  return {
    ...draft,
    headers: draft.headers
      .filter((h) => h.key.trim())
      .map((h) => ({ key: h.key.trim(), value: h.value })),
    query_params: draft.query_params
      .filter((p) => p.key.trim())
      .map((p) => ({ ...p, key: p.key.trim() })),
    path_params: draft.path_params
      .filter((p) => p.key.trim())
      .map((p) => ({ ...p, key: p.key.trim() })),
    body_field_map: draft.body_field_map
      .filter((m) => m.api_field_path.trim())
      .map((m) => ({ ...m, api_field_path: m.api_field_path.trim() })),
    response_field_map: draft.response_field_map
      .filter((m) => m.agent_field.trim())
      .map((m) => ({ ...m, agent_field: m.agent_field.trim() })),
  };
}

interface ChamadaEditorProps {
  draft: CapabilityHttpCallWrite;
  onChange: (patch: Partial<CapabilityHttpCallWrite>) => void;
  toolName: string;
  onCopiarDisponibilidade?: () => void;
}

function ChamadaEditor({ draft, onChange, toolName, onCopiarDisponibilidade }: ChamadaEditorProps) {
  const t = useT();
  const [bodyJson, setBodyJson] = React.useState(() =>
    JSON.stringify(draft.legacy_body_overrides, null, 2),
  );
  const [bodyJsonError, setBodyJsonError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setBodyJson(JSON.stringify(draft.legacy_body_overrides, null, 2));
    setBodyJsonError(null);
    // Só quando a linha muda de baixo (troca de aba/carregou do servidor) — não a cada tecla.
  }, [draft.call_key]);

  function aplicarBodyJson(texto: string) {
    setBodyJson(texto);
    if (texto.trim() === "") {
      setBodyJsonError(null);
      onChange({ legacy_body_overrides: {} });
      return;
    }
    try {
      const parsed: unknown = JSON.parse(texto);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        setBodyJsonError(t('Precisa ser um objeto JSON, ex: {"campo": "valor"}.'));
        return;
      }
      setBodyJsonError(null);
      onChange({ legacy_body_overrides: parsed as Record<string, unknown> });
    } catch {
      setBodyJsonError(t("JSON inválido — confira vírgulas e aspas."));
    }
  }

  const urlFinal = montarUrlFinal({
    baseUrl: draft.base_url,
    endpointPath: draft.endpoint_path,
    pathParams: draft.path_params.map((p) => ({
      key: p.key,
      value: p.source === "fixed" ? p.value : `{{${p.value}}}`,
    })),
    queryParams: draft.query_params.map((p) => ({
      key: p.key,
      value: p.source === "fixed" ? p.value : `{{${p.value}}}`,
    })),
  });

  return (
    <div className="space-y-6">
      <div className="border-border/60 flex items-center justify-between rounded-md border p-3">
        <div>
          <Label htmlFor={`enabled-${draft.call_key}`} className="text-sm font-medium">
            {t("Usar esta configuração")}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t(
              "Desligado (ou sem nada preenchido): a capacidade continua funcionando exatamente como hoje.",
            )}
          </p>
        </div>
        <Switch
          id={`enabled-${draft.call_key}`}
          checked={draft.enabled}
          onCheckedChange={(v) => onChange({ enabled: v })}
        />
      </div>

      {onCopiarDisponibilidade ? (
        <Button type="button" variant="outline" size="sm" onClick={onCopiarDisponibilidade}>
          <Copy /> {t('Copiar de "Consultar disponibilidade"')}
        </Button>
      ) : null}

      <section className="space-y-3">
        <h4 className="text-sm font-semibold">{t("Conexão")}</h4>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[140px_1fr]">
          <div className="space-y-1.5">
            <Label>{t("Método")}</Label>
            <Select
              value={draft.method ?? METODO_PADRAO}
              onValueChange={(v) =>
                onChange({ method: v === METODO_PADRAO ? null : (v as CapabilityHttpMethod) })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={METODO_PADRAO}>{t("Padrão do sistema")}</SelectItem>
                {METODOS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t("Base URL ou IP")}</Label>
            <Input
              value={draft.base_url ?? ""}
              onChange={(e) => onChange({ base_url: e.target.value })}
              placeholder={t("https://pordosol.ddns.net:5004 (vazio = padrão atual)")}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>{t("Endpoint")}</Label>
          <Input
            value={draft.endpoint_path ?? ""}
            onChange={(e) => onChange({ endpoint_path: e.target.value })}
            placeholder={t("/api/quartos/BuscarQuartosSemReservasEntreDatas (vazio = padrão atual)")}
            className="font-mono text-xs"
          />
        </div>
        <div className="space-y-1.5">
          <Label>{t("URL final")}</Label>
          <p className="border-border/60 bg-muted/30 break-all rounded-md border p-2 font-mono text-xs text-muted-foreground">
            {urlFinal ?? t("— defina ao menos a Base URL (aqui ou na config atual) para calcular —")}
          </p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>{t("Timeout (ms)")}</Label>
            <Input
              type="number"
              min={1000}
              max={120000}
              value={draft.timeout_ms ?? ""}
              onChange={(e) =>
                onChange({ timeout_ms: e.target.value === "" ? null : Number(e.target.value) })
              }
              placeholder={t("15000 (padrão)")}
            />
          </div>
          <div className="border-border/60 flex items-center justify-between rounded-md border p-2">
            <Label htmlFor={`tls-${draft.call_key}`} className="text-sm">
              {t("Verificar certificado TLS")}
            </Label>
            <Switch
              id={`tls-${draft.call_key}`}
              checked={draft.verify_tls ?? false}
              onCheckedChange={(v) => onChange({ verify_tls: v })}
            />
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <h4 className="text-sm font-semibold">{t("Autenticação")}</h4>
        <Select
          value={draft.auth_type}
          onValueChange={(v) => onChange({ auth_type: v as CapabilityHttpAuthType })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(AUTH_LABELS) as CapabilityHttpAuthType[]).map((chave) => (
              <SelectItem key={chave} value={chave}>
                {t(AUTH_LABELS[chave])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {draft.auth_type !== "none" ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {draft.auth_type !== "bearer" ? (
              <div className="space-y-1.5">
                <Label>
                  {draft.auth_type === "basic"
                    ? t("Usuário")
                    : draft.auth_type === "api_key_query"
                      ? t("Nome do parâmetro")
                      : t("Nome do header")}
                </Label>
                <Input
                  value={draft.auth_key_name ?? ""}
                  onChange={(e) => onChange({ auth_key_name: e.target.value })}
                  placeholder={draft.auth_type === "api_key_header" ? "x-api-key" : undefined}
                />
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label>{draft.auth_type === "basic" ? t("Senha") : t("Token / chave")}</Label>
              <Input
                type="password"
                value={draft.auth_secret ?? ""}
                onChange={(e) =>
                  onChange({ auth_secret: e.target.value, auth_secret_clear: false })
                }
                placeholder={t("Deixe em branco para manter a credencial já salva")}
              />
              <button
                type="button"
                className="text-xs text-muted-foreground underline underline-offset-4"
                onClick={() => onChange({ auth_secret: "", auth_secret_clear: true })}
              >
                {t("Remover credencial salva")}
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="space-y-2">
        <h4 className="text-sm font-semibold">{t("Headers")}</h4>
        <KeyValueListEditor
          rows={draft.headers}
          onChange={(rows) => onChange({ headers: rows })}
          keyPlaceholder={t("nome do header")}
          valuePlaceholder={t("valor")}
          addLabel={t("Adicionar header")}
        />
      </section>

      <section className="space-y-2">
        <h4 className="text-sm font-semibold">{t("Query parameters")}</h4>
        <KeyValueListEditor
          rows={paramsParaLinhas(draft.query_params)}
          onChange={(rows) => onChange({ query_params: linhasParaParams(rows) })}
          keyPlaceholder={t("nome do parâmetro")}
          valuePlaceholder={t("valor fixo")}
          withSource
          addLabel={t("Adicionar query param")}
        />
      </section>

      <section className="space-y-2">
        <h4 className="text-sm font-semibold">{t("Path parameters")}</h4>
        <p className="text-xs text-muted-foreground">
          {t("Preenche trechos")} <code>{"{assim}"}</code> {t("no endpoint acima.")}
        </p>
        <KeyValueListEditor
          rows={paramsParaLinhas(draft.path_params)}
          onChange={(rows) => onChange({ path_params: linhasParaParams(rows) })}
          keyPlaceholder={t("nome (bate com {chave} no endpoint)")}
          valuePlaceholder={t("valor fixo")}
          withSource
          addLabel={t("Adicionar path param")}
        />
      </section>

      <section className="space-y-3">
        <h4 className="text-sm font-semibold">{t("Corpo da requisição")}</h4>
        <div className="space-y-1.5">
          <Label>{t("Tipo de body")}</Label>
          <Select
            value={draft.body_type}
            onValueChange={(v) => onChange({ body_type: v as "json" | "form" | "none" })}
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="json">JSON</SelectItem>
              <SelectItem value="form">Form</SelectItem>
              <SelectItem value="none">{t("Sem corpo")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>{t("Campos fixos (sobrescreve por cima do corpo padrão)")}</Label>
          <Textarea
            className="font-mono text-xs"
            rows={4}
            value={bodyJson}
            onChange={(e) => aplicarBodyJson(e.target.value)}
            placeholder='{"campo": "valor fixo"}'
          />
          {bodyJsonError ? <p className="text-xs text-destructive">{bodyJsonError}</p> : null}
        </div>
        <div className="space-y-1.5">
          <Label>{t("Mapeamento de campos (dado do agente → campo da API)")}</Label>
          <KeyValueListEditor
            rows={bodyMapParaLinhas(draft.body_field_map)}
            onChange={(rows) => onChange({ body_field_map: linhasParaBodyMap(rows) })}
            keyPlaceholder={t("campo na API, ex: reserva.observacao")}
            valuePlaceholder={t("valor fixo")}
            withSource
            addLabel={t("Adicionar mapeamento")}
          />
        </div>
      </section>

      <section className="space-y-2">
        <h4 className="text-sm font-semibold">{t("Campos esperados no retorno")}</h4>
        <p className="text-xs text-muted-foreground">
          {t(
            "Documentação — não muda o processamento da resposta, só ajuda a lembrar o que essa chamada devolve.",
          )}
        </p>
        <KeyValueListEditor
          rows={responseMapParaLinhas(draft.response_field_map)}
          onChange={(rows) => onChange({ response_field_map: linhasParaResponseMap(rows) })}
          keyPlaceholder={t("nome amigável")}
          valuePlaceholder={t("caminho na resposta, ex: data.qrCode")}
          addLabel={t("Adicionar campo esperado")}
        />
      </section>

      {toolName === "pousada_gerar_cobranca_pix" ? (
        <section className="space-y-3">
          <h4 className="text-sm font-semibold">{t("Configurações específicas desta capacidade")}</h4>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t("% de entrada do PIX")}</Label>
              <Input
                type="number"
                min={1}
                max={100}
                value={(draft.specific_config.pix_deposit_percent as number | undefined) ?? ""}
                onChange={(e) =>
                  onChange({
                    specific_config: {
                      ...draft.specific_config,
                      pix_deposit_percent:
                        e.target.value === "" ? undefined : Number(e.target.value),
                    },
                  })
                }
                placeholder={t("30 (padrão)")}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("Prazo de expiração do PIX (segundos)")}</Label>
              <Input
                type="number"
                min={60}
                value={(draft.specific_config.pix_expiration_seconds as number | undefined) ?? ""}
                onChange={(e) =>
                  onChange({
                    specific_config: {
                      ...draft.specific_config,
                      pix_expiration_seconds:
                        e.target.value === "" ? undefined : Number(e.target.value),
                    },
                  })
                }
                placeholder={t("3600 (padrão)")}
              />
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}

export function EditorDeCapacidadeHttp({
  open,
  onOpenChange,
  toolName,
  toolLabel,
  exemploTestArgs,
}: Props) {
  const t = useT();
  const query = useCapabilityHttpConfig(toolName, open);
  const disponibilidadeQuery = useCapabilityHttpConfig(
    "pousada_consultar_disponibilidade",
    open && toolName === "pousada_criar_reserva",
  );
  const save = useSaveCapabilityHttpConfig();

  const [drafts, setDrafts] = React.useState<Record<string, CapabilityHttpCallWrite> | null>(null);
  const [activeCallKey, setActiveCallKey] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) {
      setDrafts(null);
      setActiveCallKey(null);
      return;
    }
    if (drafts === null && query.data) {
      const next: Record<string, CapabilityHttpCallWrite> = {};
      for (const call of query.data.calls) next[call.call_key] = paraDraft(call);
      setDrafts(next);
      setActiveCallKey(query.data.calls[0]?.call_key ?? null);
    }
  }, [open, query.data, drafts]);

  const [testArgs, setTestArgs] = React.useState(exemploTestArgs);
  const [testResult, setTestResult] = React.useState<string | null>(null);
  const [testOk, setTestOk] = React.useState<boolean | null>(null);
  const [isTesting, startTest] = useTransition();

  function handleTest() {
    setTestResult(null);
    startTest(async () => {
      const r = await testPousadaTool(toolName, testArgs);
      if (r.ok) {
        setTestOk(true);
        setTestResult(JSON.stringify(r.result, null, 2));
      } else {
        setTestOk(false);
        setTestResult(r.details ? `${r.error}\n${JSON.stringify(r.details, null, 2)}` : r.error);
      }
    });
  }

  function atualizarDraft(callKey: string, patch: Partial<CapabilityHttpCallWrite>) {
    setDrafts((prev) => (prev ? { ...prev, [callKey]: { ...prev[callKey]!, ...patch } } : prev));
  }

  async function handleSave() {
    if (!drafts) return;
    try {
      await save.mutateAsync({
        tool_name: toolName,
        calls: Object.values(drafts).map(sanitizarParaSalvar),
      });
      toast.success(t("Configuração salva — vale para todos os agentes desta organização."));
    } catch {
      toast.error(t("Não foi possível salvar. Confira os campos e tente de novo."));
    }
  }

  const calls = drafts ? Object.values(drafts).sort((a, b) => a.call_order - b.call_order) : [];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{t("Configurar chamada HTTP")} — {toolLabel}</SheetTitle>
          <SheetDescription>
            {t("Esta configuração vale para")} <strong>{t("todos os agentes desta organização")}</strong>
            {t(", não só o agente de onde você abriu esta tela — é a mesma integração por trás.")}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-6">
          {query.isLoading || !drafts ? (
            <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>
          ) : calls.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("Esta capacidade não faz chamada HTTP nenhuma.")}
            </p>
          ) : calls.length === 1 ? (
            <ChamadaEditor
              draft={calls[0]!}
              onChange={(patch) => atualizarDraft(calls[0]!.call_key, patch)}
              toolName={toolName}
            />
          ) : (
            <Tabs value={activeCallKey ?? calls[0]!.call_key} onValueChange={setActiveCallKey}>
              <TabsList>
                {calls.map((c) => (
                  <TabsTrigger key={c.call_key} value={c.call_key}>
                    {c.call_label}
                    {c.enabled ? (
                      <Badge variant="outline" className="ml-2 text-[10px]">
                        {t("ativa")}
                      </Badge>
                    ) : null}
                  </TabsTrigger>
                ))}
              </TabsList>
              {calls.map((c) => (
                <TabsContent key={c.call_key} value={c.call_key} className="mt-4">
                  <ChamadaEditor
                    draft={c}
                    onChange={(patch) => atualizarDraft(c.call_key, patch)}
                    toolName={toolName}
                    onCopiarDisponibilidade={
                      c.call_key === "revalidar_disponibilidade" && disponibilidadeQuery.data
                        ? () => {
                            const origem = disponibilidadeQuery.data!.calls.find(
                              (d) => d.call_key === "default",
                            );
                            if (!origem) return;
                            const { auth_secret_last4: _drop, ...resto } = origem;
                            atualizarDraft(c.call_key, {
                              ...resto,
                              call_key: c.call_key,
                              call_label: c.call_label,
                              call_order: c.call_order,
                              auth_secret: "",
                              auth_secret_clear: false,
                            });
                            toast.info(
                              t(
                                'Copiado de "Consultar disponibilidade" — a credencial não foi copiada, defina de novo se necessário.',
                              ),
                            );
                          }
                        : undefined
                    }
                  />
                </TabsContent>
              ))}
            </Tabs>
          )}

          <section className="border-border/60 space-y-2 border-t pt-4">
            <Label>{t("Testar agora (chama de verdade o sistema da pousada)")}</Label>
            <Textarea
              className="font-mono text-xs"
              rows={4}
              value={testArgs}
              onChange={(e) => setTestArgs(e.target.value)}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleTest}
              disabled={isTesting}
            >
              {isTesting ? t("Testando…") : t("Testar agora")}
            </Button>
            {testResult !== null ? (
              <pre
                className={`max-h-64 overflow-auto rounded-md border p-3 text-xs ${
                  testOk
                    ? "border-border bg-muted"
                    : "border-destructive/30 bg-destructive/10 text-destructive"
                }`}
              >
                {testResult}
              </pre>
            ) : null}
          </section>

          <div className="border-border/60 flex justify-end gap-2 border-t pt-4">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("Fechar")}
            </Button>
            <Button type="button" onClick={handleSave} disabled={save.isPending || !drafts}>
              {save.isPending ? t("Salvando…") : t("Salvar configuração")}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
