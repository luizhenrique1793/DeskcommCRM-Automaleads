/**
 * Parâmetros ajustáveis da integração da pousada, por organização —
 * `organizations.settings.pousada` (mesmo padrão de `settings.llm`).
 *
 * Existe para não obrigar uma alteração de código toda vez que o endereço do
 * PMS mudar ou o percentual de entrada do PIX for revisto — o dono da conta
 * ajusta pela tela (`/app/settings/tenant/pousada`), o handler decide.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { env } from "@/lib/env";

export interface PousadaSettings {
  pmsBaseUrl: string;
  pixDepositPercent: number;
  pixExpirationSeconds: number;
}

export const POUSADA_SETTINGS_DEFAULTS = {
  pixDepositPercent: 30,
  pixExpirationSeconds: 3600,
} as const;

interface RawPousadaSettings {
  pms_base_url?: unknown;
  pix_deposit_percent?: unknown;
  pix_expiration_seconds?: unknown;
}

export async function loadPousadaSettings(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<PousadaSettings> {
  const { data, error } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", organizationId)
    .maybeSingle();
  if (error) throw new Error(`carregar_config_pousada_falhou: ${error.message}`);

  const raw = ((data?.settings as { pousada?: RawPousadaSettings } | null)?.pousada ?? {}) as RawPousadaSettings;

  const pmsBaseUrl =
    typeof raw.pms_base_url === "string" && raw.pms_base_url.trim() !== ""
      ? raw.pms_base_url.trim()
      : env.POUSADA_PMS_BASE_URL;

  const pixDepositPercent =
    typeof raw.pix_deposit_percent === "number" && raw.pix_deposit_percent > 0 && raw.pix_deposit_percent <= 100
      ? raw.pix_deposit_percent
      : POUSADA_SETTINGS_DEFAULTS.pixDepositPercent;

  const pixExpirationSeconds =
    typeof raw.pix_expiration_seconds === "number" && raw.pix_expiration_seconds >= 60
      ? raw.pix_expiration_seconds
      : POUSADA_SETTINGS_DEFAULTS.pixExpirationSeconds;

  return { pmsBaseUrl, pixDepositPercent, pixExpirationSeconds };
}
