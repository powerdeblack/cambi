import { describe, expect, it } from "vitest";
import { dollarPosition, dollarResult } from "./position";
import { INITIAL_WALLET, Wallet } from "./wallet";

const swap = (id: number, side: "BRL" | "USD", amountIn: number, amountOut: number) => ({ id, at: id, kind: "swap" as const, side, amountIn, amountOut });

describe("preço médio do dólar", () => {
  it("média ponderada das compras, com a taxa incluída", () => {
    // R$ 505 por US$ 100 (5,05) e R$ 1.030 por US$ 200 (5,15): média 5,1167
    const p = dollarPosition([swap(2, "BRL", 1030, 200), swap(1, "BRL", 505, 100)]);
    expect(p.usdBought).toBe(300);
    expect(p.avgPrice).toBeCloseTo(1535 / 300);
  });

  it("vender ou enviar dólar não muda o preço médio do que ficou", () => {
    const p = dollarPosition([
      swap(1, "BRL", 510, 100),
      swap(2, "USD", 40, 200),
      { id: 3, at: 3, kind: "send", side: "USD", amountIn: 10, fee: 0 },
    ]);
    expect(p.usdBought).toBeCloseTo(50);
    expect(p.avgPrice).toBeCloseTo(5.1);
  });

  it("sem compras, sem preço médio", () => {
    expect(dollarPosition([{ id: 1, kind: "faucet", side: "BRL", amountIn: 1000 }]).avgPrice).toBeNull();
  });
});

describe("resultado da posição", () => {
  const w: Wallet = {
    ...INITIAL_WALLET,
    balance: { BRL: 0, USD: 60 },
    rende: { BRL: 0, USD: 40 },
    earned: { BRL: 0.5, USD: 0.1 },
    activity: [swap(1, "BRL", 520, 100), { id: 2, at: 2, kind: "harvest", side: "BRL", amountIn: 1 }],
  };

  it("câmbio: dólares (carteira + Rende) × (cotação − preço médio)", () => {
    const r = dollarResult(w, 5.0)!;
    expect(r.avgPrice).toBeCloseTo(5.2);
    expect(r.fx).toBeCloseTo(-20);
    expect(r.fxPct).toBeCloseTo(5 / 5.2 - 1);
  });

  it("com o pool: soma o rendimento pendente e o já recebido", () => {
    const r = dollarResult(w, 5.0)!;
    expect(r.pool).toBeCloseTo(0.5 + 0.1 * 5 + 1);
    expect(r.total).toBeCloseTo(-20 + 2);
  });

  it("sem dólares, sem resultado", () => {
    expect(dollarResult(INITIAL_WALLET, 5)).toBeNull();
  });
});
