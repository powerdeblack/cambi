import { describe, expect, it } from "vitest";
import { Activity, dayLabel, groupByDay, matches, monthSummary } from "./activity";

const NOW = new Date(2026, 9, 9, 15, 0).getTime();
const H = 3_600_000;
const items: Activity[] = [
  { id: 1, kind: "send", side: "BRL", amountIn: 200, fee: 0, route: "Pix", at: NOW - H },
  { id: 2, kind: "swap", side: "BRL", amountIn: 100, amountOut: 19.7, savedVsBank: 4.5, at: NOW - 2 * H },
  { id: 3, kind: "deposit", side: "BRL", amountIn: 100, at: NOW - 26 * H },
  { id: 4, kind: "faucet", side: "BRL", amountIn: 1000, at: new Date(2026, 8, 20).getTime() },
];

describe("extrato", () => {
  it("filtra por tipo e por moeda (troca vale para as duas moedas)", () => {
    expect(items.filter((a) => matches(a, "send", "all")).map((a) => a.id)).toEqual([1]);
    expect(items.filter((a) => matches(a, "rende", "all")).map((a) => a.id)).toEqual([3]);
    expect(items.filter((a) => matches(a, "all", "USD")).map((a) => a.id)).toEqual([2]);
  });

  it("agrupa por dia com Hoje e Ontem", () => {
    expect(dayLabel(NOW - H, NOW)).toBe("Hoje");
    expect(dayLabel(NOW - 26 * H, NOW)).toBe("Ontem");
    expect(groupByDay(items, NOW).map((g) => g.label)).toEqual(["Hoje", "Ontem", "20 de setembro"]);
  });

  it("resume só o mês corrente", () => {
    const s = monthSummary(items, NOW);
    expect(s.count).toBe(3);
    expect(s.sent.BRL).toBe(200);
    expect(s.saved).toBeCloseTo(4.5);
  });
});
