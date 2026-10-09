import { describe, expect, it } from "vitest";
import { BALEIA_SHARE_OF_LP, BASE_FEE, PARTNER_COST, PLATFORM_SHARE } from "./pool";
import { POUPANCA, compound, feeSplitPer100, growthSeries } from "./growth";

describe("simulador de rendimento", () => {
  it("juros compostos mês a mês", () => {
    const v = compound(1000, 0.12, 12);
    expect(v).toHaveLength(13);
    expect(v[0]).toBe(1000);
    expect(v[12]).toBeCloseTo(1120);
  });

  it("poupança rende 0,5% ao mês", () => {
    expect(POUPANCA).toBeCloseTo(0.0617, 3);
  });

  it("a Rende em reais rende mais que o CDI com o pool girando, e mais giro rende mais", () => {
    const [cambi, cdi, poup] = growthSeries(10_000, 12, 0.05, "BRL");
    expect(cambi.values[12]).toBeGreaterThan(cdi.values[12]);
    expect(cdi.values[12]).toBeGreaterThan(poup.values[12]);
    const fast = growthSeries(10_000, 12, 0.1, "BRL")[0];
    expect(fast.values[12]).toBeGreaterThan(cambi.values[12]);
  });

  it("em dólar, compara com o Tesouro americano e com o dólar parado", () => {
    const [cambi, tbill, parado] = growthSeries(1_000, 24, 0.05, "USD");
    expect(parado.values[24]).toBe(1_000);
    expect(cambi.values[24]).toBeGreaterThan(tbill.values[24]);
  });

  it("cada R$ 100 de taxa se divide sem sobrar nem faltar", () => {
    const partnerShare = PARTNER_COST / BASE_FEE.retail; // varejo: tudo via Pix
    const s = feeSplitPer100(1 - BALEIA_SHARE_OF_LP, PLATFORM_SHARE, partnerShare);
    expect(s.rende + s.baleia + s.partner + s.platform).toBeCloseTo(100);
    expect(s.partner).toBeCloseTo(20);
  });
});
