// Projeção anual de rendimento (mesmo modelo de sim/cambi_sim.py).
// Números ilustrativos: dependem de premissas, não são promessa de retorno.

import { BALEIA_SHARE_OF_LP, BASE_FEE, PARTNER_COST, PIX_FRACTION, PLATFORM_SHARE, UserKind } from "./pool";

export interface ProjectionInput {
  poolBRL: number; // tamanho do pool em reais
  giro: number; // volume diário / pool (ex.: 0.05 = 5% ao dia)
  cdi: number; // ex.: 0.1365
  tbill: number; // ex.: 0.0386
  baleiaShare?: number; // fração do pool na camada Baleia
  rendeLiquid?: number; // fração líquida da camada Rende
  performanceFee?: number; // fatia da cambI sobre o que passar do benchmark
  imbalanceCost?: number; // perda média por desequilíbrio, por volume (absorvida pela Baleia)
  mix?: Record<UserKind, number>; // participação de cada tipo de cliente no volume
}

export interface Projection {
  volumeYearBRL: number;
  rendeBRL: number; // rendimento anual de quem deposita reais na Rende
  rendeUSD: number; // rendimento anual de quem deposita dólar na Rende
  baleia: number; // rendimento anual da camada Baleia
  platformBRL: number; // receita anual da cambI
  reserveDays: number; // quantos dias de desequilíbrio a reserva aguenta
}

export const DEFAULT_MIX: Record<UserKind, number> = { b2b: 0.6, depositor: 0.2, retail: 0.2 };

export function project(input: ProjectionInput): Projection {
  const {
    poolBRL,
    giro,
    cdi,
    tbill,
    baleiaShare = 0.1,
    rendeLiquid = 0.05,
    performanceFee = 0.2,
    imbalanceCost = 0.001,
    mix = DEFAULT_MIX,
  } = input;

  const volume = poolBRL * giro * 365;
  let net = 0;
  for (const kind of Object.keys(mix) as UserKind[]) {
    const v = volume * mix[kind];
    net += v * BASE_FEE[kind] - v * PIX_FRACTION[kind] * PARTNER_COST;
  }
  const platformFees = net * PLATFORM_SHARE;
  const lp = net - platformFees;

  const rendeCap = poolBRL * (1 - baleiaShare);
  const baleiaCap = poolBRL * baleiaShare;
  const rendeFeeYield = (lp * (1 - BALEIA_SHARE_OF_LP)) / rendeCap;

  const perf = (gross: number, bench: number) => gross - Math.max(gross - bench, 0) * performanceFee;
  const grossBRL = (1 - rendeLiquid) * cdi + rendeFeeYield;
  const grossUSD = (1 - rendeLiquid) * tbill + rendeFeeYield;
  const rendeBRL = perf(grossBRL, cdi);
  const rendeUSD = perf(grossUSD, tbill);

  // Metade do caixa da Baleia (lado dólar) pode ficar em T-bill tokenizado de liquidez imediata.
  const baleia = (lp * BALEIA_SHARE_OF_LP - volume * imbalanceCost + baleiaCap * 0.5 * tbill) / baleiaCap;

  const perfRevenue = Math.max(grossBRL - cdi, 0) * performanceFee * rendeCap;
  const liquid = baleiaCap + rendeCap * rendeLiquid;
  const reserveDays = giro === 0 ? Infinity : liquid / 2 / (0.3 * poolBRL * giro);

  return {
    volumeYearBRL: volume,
    rendeBRL,
    rendeUSD,
    baleia,
    platformBRL: platformFees + perfRevenue,
    reserveDays,
  };
}
