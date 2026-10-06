/**
 * Feriados nacionais do Brasil — CALCULADOS, não listados à mão.
 * Usados pelo cálculo do prazo da LGPD para saltar dias não úteis.
 *
 * Os fixos são a mesma data em todo ano. Os móveis saem da Páscoa
 * (Meeus/Jones/Butcher, em `./pascoa`): Carnaval (segunda −48 e terça −47),
 * Sexta-feira Santa (−2) e Corpo de Deus (+60).
 *
 * ─── Por que o cálculo substituiu a tabela (#2413) ───────────────────────────
 *
 * Os fixos E os móveis eram listados à mão só para 2026–2030: a partir de 2031
 * o prazo de um pedido de titular (D+7 / D+15) seria contado sem feriado
 * nenhum, sem erro e sem aviso. Agora tudo é calculado por ano, a cobertura é
 * uma CONSTANTE vigiada por teste (`ULTIMO_ANO_COBERTO` tem de alcançar o ano
 * atual + 2) e as datas de 2026–2030 continuam EXATAMENTE as da lista antiga —
 * o teste reproduz os cinco anos, ano a ano.
 *
 * ⚠️ A lista pode repetir uma data: quando a Páscoa cai em 23/04, a
 * Sexta-feira Santa cai em 21/04 (Tiradentes) — os dois feriados são o MESMO
 * dia. Quem consome usa `Set`, então a repetição não muda a contagem de dias
 * úteis.
 */

import { diaEmTornoDaPascoa } from "./pascoa";

/** Primeiro ano coberto pelo calendário gerado. */
export const PRIMEIRO_ANO_COBERTO = 2000;

/**
 * Último ano coberto. O teste vigia que ele alcance o ano atual + 2; quando a
 * data chegar perto, o vermelho é o pedido de estender.
 */
export const ULTIMO_ANO_COBERTO = 2100;

/** Feriados fixos — mesma data em todo ano (`MM-DD`). */
const FIXED_DATES = [
  "01-01", // Confraternização Universal
  "04-21", // Tiradentes
  "05-01", // Dia do Trabalho
  "09-07", // Independência
  "10-12", // Nossa Senhora Aparecida
  "11-02", // Finados
  "11-15", // Proclamação da República
  "12-25", // Natal
];

/**
 * Os doze feriados de um ano: os oito fixos, a segunda e a terça de Carnaval
 * (Páscoa − 48 e − 47), a Sexta-feira Santa (Páscoa − 2) e o Corpo de Deus
 * (Páscoa + 60).
 */
export function feriadosDoBrasilDoAno(ano: number): string[] {
  return [
    ...FIXED_DATES.map((md) => `${ano}-${md}`),
    diaEmTornoDaPascoa(ano, -48), // Segunda-feira de Carnaval
    diaEmTornoDaPascoa(ano, -47), // Terça-feira de Carnaval
    diaEmTornoDaPascoa(ano, -2), // Sexta-feira Santa
    diaEmTornoDaPascoa(ano, 60), // Corpo de Deus
  ];
}

export const HOLIDAYS_BR_ISO: string[] = (() => {
  const lista: string[] = [];
  for (let ano = PRIMEIRO_ANO_COBERTO; ano <= ULTIMO_ANO_COBERTO; ano++) {
    lista.push(...feriadosDoBrasilDoAno(ano));
  }
  return lista;
})();

const _holidaySet = new Set(HOLIDAYS_BR_ISO);

/**
 * Returns true if the given date falls on a Brazilian national holiday.
 * Comparison is done in America/Sao_Paulo timezone.
 */
export function isHolidayBR(date: Date): boolean {
  // Format: YYYY-MM-DD in São Paulo timezone
  const isoDate = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  return _holidaySet.has(isoDate);
}
