// Curvas de crescimento para o simulador de rendimento da aba Pool.
// Taxas anuais brutas (antes de IR); projeção ilustrativa, não promessa de retorno.
import { project } from "./projection";

export const CDI = 0.1365;
export const TBILL = 0.0386;
/** Poupança com Selic acima de 8,5%: 0,5% ao mês + TR (TR tratada como zero). */
export const POUPANCA = Math.pow(1.005, 12) - 1;

export interface GrowthSeries {
  id: "cambi" | "bench" | "base";
  label: string;
  rate: number; // ao ano
  values: number[]; // valor no fim de cada mês, começando no mês 0
}

/** Valor mês a mês com juros compostos. */
export const compound = (amount: number, rate: number, months: number) =>
  Array.from({ length: months + 1 }, (_, m) => amount * Math.pow(1 + rate, m / 12));

/** As três curvas do simulador: cambI Rende, o referencial (CDI ou T-bill) e o dinheiro "parado". */
export function growthSeries(amount: number, months: number, giro: number, currency: "BRL" | "USD"): GrowthSeries[] {
  const p = project({ poolBRL: 100e6, giro, cdi: CDI, tbill: TBILL });
  if (currency === "BRL") {
    return [
      { id: "cambi", label: "cambI Rende", rate: p.rendeBRL, values: compound(amount, p.rendeBRL, months) },
      { id: "bench", label: "100% do CDI", rate: CDI, values: compound(amount, CDI, months) },
      { id: "base", label: "Poupança", rate: POUPANCA, values: compound(amount, POUPANCA, months) },
    ];
  }
  return [
    { id: "cambi", label: "cambI Rende em dólar", rate: p.rendeUSD, values: compound(amount, p.rendeUSD, months) },
    { id: "bench", label: "Tesouro americano", rate: TBILL, values: compound(amount, TBILL, months) },
    { id: "base", label: "Dólar parado", rate: 0, values: compound(amount, 0, months) },
  ];
}

/** Divisão de uma taxa de troca de varejo (por R$ 100 de taxa), como no programa. */
export function feeSplitPer100(rendeShareOfLp: number, platformShare: number, partnerShareOfFee: number) {
  const partner = 100 * partnerShareOfFee;
  const afterPartner = 100 - partner;
  const platform = afterPartner * platformShare;
  const lp = afterPartner - platform;
  const rende = lp * rendeShareOfLp;
  return { rende, baleia: lp - rende, partner, platform };
}
