import { describe, expect, it } from "vitest";
import { BASE_FEE, createPool, deposit, dynamicFeeRate, imbalance, swap } from "./pool";
import { project } from "./projection";

const PRICE = 5.4;

function balancedPool() {
  let p = createPool(PRICE);
  p = deposit(p, "rende", "BRL", 540_000);
  p = deposit(p, "rende", "USD", 100_000);
  p = deposit(p, "baleia", "BRL", 54_000);
  p = deposit(p, "baleia", "USD", 10_000);
  return p;
}

describe("pool", () => {
  it("começa equilibrado quando o valor em real e em dólar é igual", () => {
    expect(imbalance(balancedPool())).toBeCloseTo(0, 10);
  });

  it("usa a taxa base quando o pool está equilibrado", () => {
    const p = balancedPool();
    expect(dynamicFeeRate(p, "BRL", "retail")).toBeCloseTo(BASE_FEE.retail);
    expect(dynamicFeeRate(p, "BRL", "depositor")).toBeCloseTo(BASE_FEE.depositor);
  });

  it("converte pelo preço do oráculo descontando a taxa", () => {
    const r = swap(balancedPool(), "BRL", 5_400, "retail");
    expect(r.feeTotal).toBeCloseTo(54);
    expect(r.amountOut).toBeCloseTo((5_400 - 54) / PRICE);
  });

  it("divide a taxa inteira entre Rende, Baleia, plataforma e parceiro", () => {
    const r = swap(balancedPool(), "BRL", 10_000, "retail");
    const sum = r.toRende + r.toBaleia + r.toPlatform + r.toPartner;
    expect(sum).toBeCloseTo(r.feeTotal, 10);
    expect(r.toBaleia).toBeGreaterThan(r.toRende);
  });

  it("encarece o sentido que desequilibra e barateia o que equilibra", () => {
    let p = balancedPool();
    p = swap(p, "BRL", 200_000, "retail").state; // entra muito real: sobra real
    expect(imbalance(p)).toBeGreaterThan(0);
    expect(dynamicFeeRate(p, "BRL", "retail")).toBeGreaterThan(BASE_FEE.retail);
    expect(dynamicFeeRate(p, "USD", "retail")).toBeLessThan(BASE_FEE.retail);
  });

  it("recusa troca maior que a liquidez disponível", () => {
    expect(() => swap(balancedPool(), "BRL", 10_000_000, "retail")).toThrow(/Liquidez/);
  });

  it("não altera o estado original (imutável)", () => {
    const p = balancedPool();
    swap(p, "BRL", 1_000, "retail");
    expect(p.swaps).toBe(0);
  });
});

describe("projeção", () => {
  const base = { poolBRL: 100e6, cdi: 0.1365, tbill: 0.0386 };

  it("reproduz a simulação de referência (giro 5%: ~108% do CDI, Baleia ~27%)", () => {
    const r = project({ ...base, giro: 0.05 });
    expect(r.rendeBRL / base.cdi).toBeCloseTo(1.08, 1);
    expect(r.baleia).toBeCloseTo(0.274, 2);
    expect(r.platformBRL / 1e6).toBeCloseTo(2.33, 1);
  });

  it("Rende em reais não fica muito abaixo do CDI mesmo com giro baixo", () => {
    const r = project({ ...base, giro: 0.02 });
    expect(r.rendeBRL / base.cdi).toBeGreaterThan(0.99);
  });

  it("mais giro significa mais rendimento para todos", () => {
    const low = project({ ...base, giro: 0.02 });
    const high = project({ ...base, giro: 0.08 });
    expect(high.rendeBRL).toBeGreaterThan(low.rendeBRL);
    expect(high.baleia).toBeGreaterThan(low.baleia);
    expect(high.platformBRL).toBeGreaterThan(low.platformBRL);
  });
});
