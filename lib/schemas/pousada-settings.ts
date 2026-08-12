import { z } from "zod";

export const pousadaSettingsSchema = z.object({
  pms_base_url: z
    .string()
    .trim()
    .url("Informe uma URL válida, ex: https://pordosol.ddns.net:5004")
    .max(300),
  pix_deposit_percent: z.coerce.number().min(1).max(100),
  pix_expiration_seconds: z.coerce.number().int().min(60).max(86400),
});

export type PousadaSettingsInput = z.infer<typeof pousadaSettingsSchema>;
