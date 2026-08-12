import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { POUSADA_SETTINGS_DEFAULTS } from "@/lib/pousada/settings";
import { PousadaForm } from "./_form";

export const dynamic = "force-dynamic";

interface RawPousadaSettings {
  pms_base_url?: unknown;
  pix_deposit_percent?: unknown;
  pix_expiration_seconds?: unknown;
}

export default async function PousadaSettingsPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!user.is_platform_admin && ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    redirect("/403");
  }

  const supabase = await createClient();
  const { data } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", activeOrg.orgId)
    .maybeSingle();

  const raw = ((data?.settings as { pousada?: RawPousadaSettings } | null)?.pousada ?? {}) as RawPousadaSettings;

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Pousada</h1>
        <p className="text-sm text-muted-foreground">
          Parâmetros da integração com o sistema de reservas da pousada (PMS) e da cobrança PIX. Admin only.
        </p>
      </header>
      <PousadaForm
        initial={{
          pms_base_url:
            typeof raw.pms_base_url === "string" && raw.pms_base_url
              ? raw.pms_base_url
              : env.POUSADA_PMS_BASE_URL,
          pix_deposit_percent:
            typeof raw.pix_deposit_percent === "number"
              ? raw.pix_deposit_percent
              : POUSADA_SETTINGS_DEFAULTS.pixDepositPercent,
          pix_expiration_seconds:
            typeof raw.pix_expiration_seconds === "number"
              ? raw.pix_expiration_seconds
              : POUSADA_SETTINGS_DEFAULTS.pixExpirationSeconds,
        }}
      />
    </div>
  );
}
