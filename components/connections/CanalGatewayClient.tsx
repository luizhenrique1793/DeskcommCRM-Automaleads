"use client";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";

/**
 * Conectar um número por um GATEWAY PRÓPRIO (servidor endereço + token de
 * instância). O rótulo vem do servidor (`label`), pelo mesmo motivo de
 * `CanalParceiroClient`: `lint:channels` proíbe nomear provider fora de
 * `lib/channels/`.
 *
 * Diferente do parceiro (credencial só, conta já pronta na plataforma), este
 * canal tem um passo A MAIS: depois de gravar o token, a instância ainda
 * precisa ser LOGADA num WhatsApp — QR ou código de pareamento. Por isso a
 * tela poll a cada poucos segundos enquanto o estado é "conectando": o
 * QR/código EXPIRA, e um só carregado na hora de gravar já estaria velho
 * quando o operador for escanear.
 */

interface Estado {
  label: string;
  connected: boolean;
  phone_number?: string | null;
  display_name?: string | null;
  status: string | null;
  qrcode: string | null;
  paircode: string | null;
  webhook_url?: string | null;
}

const POLL_MS = 4000;

export function CanalGatewayClient() {
  const [estado, setEstado] = useState<Estado | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [instanceId, setInstanceId] = useState("");
  const [token, setToken] = useState("");
  const [phone, setPhone] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [desconectando, setDesconectando] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const carregar = async () => {
    try {
      const r = await apiClient.get<{ data: Estado }>("/api/v1/channels/gateway");
      setEstado(r.data);
    } catch {
      setEstado(null);
    }
  };

  useEffect(() => {
    void carregar();
  }, []);

  // Enquanto está "connecting" (QR/pairing pendente), o servidor pode ter um
  // código NOVO a cada poucos segundos — parar de perguntar deixaria a tela
  // com um QR morto na cara do operador sem nenhum aviso de que expirou.
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (estado?.connected && estado.status === "connecting") {
      pollRef.current = setInterval(() => void carregar(), POLL_MS);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [estado?.connected, estado?.status]);

  const conectar = async () => {
    setSalvando(true);
    try {
      await apiClient.post("/api/v1/channels/gateway", {
        base_url: baseUrl,
        instance_id: instanceId,
        token,
        ...(phone ? { phone } : {}),
      });
      // O token sai da memória da tela assim que é gravado — mesma regra do
      // provedor parceiro: segredo não fica parado num input depois de usado.
      setToken("");
      toast.success("Instância registrada. Escaneie o QR (ou use o código) para logar.");
      await carregar();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível conectar.");
    } finally {
      setSalvando(false);
    }
  };

  const desconectar = async () => {
    setDesconectando(true);
    try {
      await apiClient.post("/api/v1/channels/gateway/disconnect", {});
      toast.success("Sessão desconectada.");
      await carregar();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível desconectar.");
    } finally {
      setDesconectando(false);
    }
  };

  const rotulo = estado?.label ?? "gateway próprio";
  const conectado = estado?.connected ?? false;
  const logado = estado?.status === "connected";

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">Conectar por {rotulo}</h3>
            <p className="text-xs text-muted-foreground">
              Um número conectado por QR através de um servidor que você mesmo hospeda ou
              contratou. Cole o endereço do servidor e o token da instância — os dois ficam
              guardados cifrados.
            </p>
          </div>
          {logado ? (
            <Badge variant="secondary">Conectado</Badge>
          ) : conectado ? (
            <Badge variant="warning">Aguardando login</Badge>
          ) : (
            <Badge variant="outline">Não conectado</Badge>
          )}
        </div>

        {conectado && (
          <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
            <p className="font-medium">{estado?.display_name ?? "Instância registrada"}</p>
            <p className="text-xs text-muted-foreground">
              {estado?.phone_number ?? "sem número informado"} · {estado?.status ?? "—"}
            </p>
          </div>
        )}

        {conectado && estado?.status === "connecting" && estado.qrcode && (
          <div className="flex flex-col items-center gap-2 rounded-md border border-border p-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- base64 dinâmico, não vale otimizar */}
            <img
              src={estado.qrcode}
              alt="QR Code para conectar o WhatsApp"
              className="h-48 w-48"
            />
            <p className="text-xs text-muted-foreground">
              Escaneie no WhatsApp do celular. O código expira e é renovado automaticamente
              enquanto esta tela estiver aberta.
            </p>
          </div>
        )}
        {conectado && estado?.status === "connecting" && estado.paircode && (
          <div className="flex flex-col items-center gap-1 rounded-md border border-border p-3">
            <code className="text-lg font-semibold tracking-widest">{estado.paircode}</code>
            <p className="text-xs text-muted-foreground">
              Digite este código no WhatsApp do celular, em Aparelhos conectados.
            </p>
          </div>
        )}

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="gateway-url">Endereço do servidor</Label>
            <Input
              id="gateway-url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://seu-servidor.exemplo.com"
              autoComplete="off"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="gateway-instancia">Id da instância</Label>
            <Input
              id="gateway-instancia"
              value={instanceId}
              onChange={(e) => setInstanceId(e.target.value)}
              placeholder="id devolvido ao criar a instância"
              autoComplete="off"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="gateway-token">Token da instância</Label>
            <Input
              id="gateway-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="cole o token"
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              Guardado cifrado. Depois de gravar ele não é mostrado de novo — para trocar, cole o
              novo.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="gateway-telefone">Número para código de pareamento (opcional)</Label>
            <Input
              id="gateway-telefone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="deixe vazio para usar QR"
              autoComplete="off"
            />
          </div>

          <div className="flex items-center gap-2">
            <Button onClick={conectar} disabled={salvando || !baseUrl || !instanceId || !token}>
              {salvando ? "Verificando…" : conectado ? "Reconectar" : "Conectar"}
            </Button>
            {logado && (
              <Button variant="outline" onClick={desconectar} disabled={desconectando}>
                {desconectando ? "Desconectando…" : "Desconectar"}
              </Button>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
