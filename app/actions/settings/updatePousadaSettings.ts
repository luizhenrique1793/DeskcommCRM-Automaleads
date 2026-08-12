"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import { pousadaSettingsSchema, type PousadaSettingsInput } from "@/lib/schemas/pousada-settings";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";

export type UpdatePousadaSettingsResult = { ok: true } | { ok: false; error: string; details?: unknown };

/**
 * Grava organizations.settings.pousada — mesmo padrão de updateTenant.ts
 * (write pelo admin client: a única policy de escrita de `organizations` exige
 * platform_admin, então o gate de papel é o `ROLE_RANK` abaixo, resolvido de
 * fonte confiável, não a RLS).
 */
export async function updatePousadaSettings(input: PousadaSettingsInput): Promise<UpdatePousadaSettingsResult> {
  const parsed = pousadaSettingsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "validation_failed", details: parsed.error.flatten() };
  }

  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, error: "unauthenticated" };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false, error: "forbidden_tenant" };
  if (!authUser.is_platform_admin && ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    return { ok: false, error: "forbidden_role" };
  }

  const supabase = createAdminClient();
  const hdrs = await headers();
  const requestId = hdrs.get("x-request-id");

  const { data: orgRow, error: readErr } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", activeOrg.orgId)
    .maybeSingle();
  if (readErr) return { ok: false, error: readErr.message };

  const currentSettings = (orgRow?.settings as Record<string, unknown> | null) ?? {};
  const nextSettings = {
    ...currentSettings,
    pousada: {
      pms_base_url: parsed.data.pms_base_url,
      pix_deposit_percent: parsed.data.pix_deposit_percent,
      pix_expiration_seconds: parsed.data.pix_expiration_seconds,
    },
  };

  const { error } = await supabase
    .from("organizations")
    .update({ settings: nextSettings })
    .eq("id", activeOrg.orgId);
  if (error) return { ok: false, error: error.message };

  await audit({
    action: "org.updated",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "organization",
    resourceId: activeOrg.orgId,
    requestId,
    metadata: { fields_changed: Object.keys(parsed.data), settings_block: "pousada" },
  });

  revalidatePath("/app/settings/tenant/pousada");
  return { ok: true };
}
