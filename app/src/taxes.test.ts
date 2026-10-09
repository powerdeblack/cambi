import { describe, expect, it } from "vitest";
import { iofOnTrade, vet, withIof } from "./taxes";

describe("IOF de câmbio", () => {
  it("comprando dólar com R$ 1.035 no total, R$ 1.000 vão para o câmbio e R$ 35 são IOF", () => {
    const r = withIof("BRL", 1035, (brl) => brl / 5);
    expect(r.iof).toBeCloseTo(35);
    expect(r.receive).toBeCloseTo(200);
  });

  it("vendendo dólar, 0,38% sai dos reais recebidos", () => {
    const r = withIof("USD", 100, (usd) => usd * 5);
    expect(r.iof).toBeCloseTo(1.9);
    expect(r.receive).toBeCloseTo(498.1);
  });

  it("VET inclui taxa e IOF", () => {
    // R$ 1.000 viram US$ 198 (taxa 1% a 5,00); com IOF de 3,5% por fora o dólar sai a 5,2273
    expect(iofOnTrade("BRL", 1000, 198)).toBeCloseTo(35);
    expect(vet("BRL", 1000, 198)).toBeCloseTo(1035 / 198);
    // Venda: US$ 100 viram R$ 495; com 0,38% de IOF, R$ 493,12 por US$ 100
    expect(vet("USD", 100, 495)).toBeCloseTo(4.9312);
  });
});
