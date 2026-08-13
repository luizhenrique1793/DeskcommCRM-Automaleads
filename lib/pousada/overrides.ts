/**
 * Overrides de campo por tool — o ajuste fino que substitui "editar o node do
 * n8n" sem abrir mão de segurança: em vez de reescrever a ferramenta inteira,
 * o operador só entra por cima do corpo (JSON) que ela já monta, campo a
 * campo. Existe porque, durante a integração, o dev do PMS da pousada ainda
 * está ajustando nomes/valores de campo — sem isto, cada ajuste desses vira
 * uma sessão comigo e um rebuild.
 *
 * `overrides` tem o MESMO formato do corpo (subconjunto de chaves, aninhado);
 * `deepMergeOverride` funde por cima — arrays são SUBSTITUÍDOS inteiros (não
 * mesclados item a item: mesclar array por índice é ambíguo e engana), objetos
 * são mesclados recursivamente, e o resto (string/number/boolean/null)
 * substitui o valor base.
 */

export type JsonRecord = Record<string, unknown>;

function isPlainObject(v: unknown): v is JsonRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function deepMergeOverride<T extends JsonRecord>(base: T, overrides: unknown): T {
  if (!isPlainObject(overrides)) return base;
  const out: JsonRecord = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    const baseValue = out[key];
    if (isPlainObject(value) && isPlainObject(baseValue)) {
      out[key] = deepMergeOverride(baseValue, value);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}
