// IOF de câmbio: alíquotas de referência (a de compra subiu para 3,5% em 2025; confirme a vigente antes de operar).
// É igual em qualquer instituição. Na cambI é cobrado pelo parceiro regulado na entrada/saída via Pix,
// fora do programa na Solana: o valor da troca na blockchain não muda.
import type { Side } from "./engine/pool";

export const IOF = { buyUSD: 0.035, sellUSD: 0.0038 } as const;

/** Alíquota conforme a moeda que a pessoa entrega: real (comprando dólar) ou dólar (vendendo). */
export const iofRate = (side: Side) => (side === "BRL" ? IOF.buyUSD : IOF.sellUSD);

/**
 * Comprando dólar, o IOF vem por cima do valor trocado: quem tem R$ 1.000 no total troca R$ 1.000 / 1,035.
 * Vendendo dólar, o IOF sai dos reais recebidos.
 */
export function withIof(side: Side, amountIn: number, receiveWithoutIof: (amountForFx: number) => number) {
  const rate = iofRate(side);
  if (side === "BRL") {
    const forFx = amountIn / (1 + rate);
    return { iof: amountIn - forFx, iofSide: "BRL" as Side, receive: receiveWithoutIof(forFx) };
  }
  const gross = receiveWithoutIof(amountIn);
  return { iof: gross * rate, iofSide: "BRL" as Side, receive: gross * (1 - rate) };
}

/** IOF que o parceiro cobraria por fora numa troca já calculada (tela de troca), em reais. */
export function iofOnTrade(side: Side, amountIn: number, amountOut: number) {
  return side === "BRL" ? amountIn * IOF.buyUSD : amountOut * IOF.sellUSD;
}

/** VET (valor efetivo total): reais por dólar, com taxa e IOF. */
export function vet(side: Side, amountIn: number, amountOut: number) {
  const iof = iofOnTrade(side, amountIn, amountOut);
  return side === "BRL" ? (amountIn + iof) / amountOut : (amountOut - iof) / amountIn;
}
