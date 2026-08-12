"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { updatePousadaSettings } from "@/app/actions/settings/updatePousadaSettings";
import { pousadaSettingsSchema, type PousadaSettingsInput } from "@/lib/schemas/pousada-settings";

interface Props {
  initial: PousadaSettingsInput;
}

export function PousadaForm({ initial }: Props) {
  const [form, setForm] = useState<PousadaSettingsInput>(initial);
  const [isPending, startTransition] = useTransition();

  function set<K extends keyof PousadaSettingsInput>(key: K, value: PousadaSettingsInput[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = pousadaSettingsSchema.safeParse(form);
    if (!parsed.success) {
      toast.error("Dados inválidos — confira a URL e os números informados.");
      return;
    }
    startTransition(async () => {
      const r = await updatePousadaSettings(parsed.data);
      if (r.ok) toast.success("Configurações da pousada atualizadas.");
      else toast.error(`Erro: ${r.error}`);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-2xl">
      <Card className="space-y-4 p-6">
        <div className="space-y-2">
          <Label htmlFor="pms_base_url">Endereço do sistema da pousada (PMS)</Label>
          <Input
            id="pms_base_url"
            value={form.pms_base_url}
            onChange={(e) => set("pms_base_url", e.target.value)}
            placeholder="https://pordosol.ddns.net:5004"
            required
          />
          <p className="text-xs text-muted-foreground">
            Onde as ferramentas de disponibilidade, reserva e PIX buscam a informação real. Mude aqui se o
            endereço/IP do sistema da pousada mudar — vale na próxima mensagem, sem precisar de deploy.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="pix_deposit_percent">Entrada do PIX (%)</Label>
            <Input
              id="pix_deposit_percent"
              type="number"
              min={1}
              max={100}
              value={form.pix_deposit_percent}
              onChange={(e) => set("pix_deposit_percent", Number(e.target.value))}
              required
            />
            <p className="text-xs text-muted-foreground">
              Percentual do valor total da reserva cobrado como entrada. Hoje: 30%.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="pix_expiration_seconds">Prazo do PIX (segundos)</Label>
            <Input
              id="pix_expiration_seconds"
              type="number"
              min={60}
              max={86400}
              value={form.pix_expiration_seconds}
              onChange={(e) => set("pix_expiration_seconds", Number(e.target.value))}
              required
            />
            <p className="text-xs text-muted-foreground">
              Quanto tempo o código PIX vale antes de expirar. 3600 = 1 hora.
            </p>
          </div>
        </div>

        <div className="flex justify-end">
          <Button type="submit" disabled={isPending}>
            {isPending ? "Salvando…" : "Salvar"}
          </Button>
        </div>
      </Card>
    </form>
  );
}
