import { describe, expect, it } from "vitest";
import { alertHit, alertProblem, clean, fetchHistory, fromAwesomeDaily, fromCoinbaseDaily, fromFrankfurter, summary, withLive } from "./history";

const mockFetch = (body: unknown) => {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
};

describe("histórico do dólar", () => {
  it("lê a AwesomeAPI (mais novo primeiro) e ordena por data", async () => {
    mockFetch([
      { bid: "5.40", timestamp: "1760000000", code: "USD" },
      { bid: "5.30", timestamp: "1759900000" },
      { bid: "5.20", timestamp: "1759800000" },
    ]);
    const pts = clean(await fromAwesomeDaily(7));
    expect(pts.map((p) => p.price)).toEqual([5.2, 5.3, 5.4]);
  });

  it("lê a Frankfurter (um ponto por dia útil)", async () => {
    mockFetch({ base: "USD", rates: { "2026-10-01": { BRL: 5.31 }, "2026-10-02": { BRL: 5.35 } } });
    const pts = clean(await fromFrankfurter(7, 6000, Date.parse("2026-10-08")));
    expect(pts).toHaveLength(2);
    expect(pts[1].price).toBe(5.35);
  });

  it("monta o histórico pela Coinbase, um dia por chamada", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (u: string) => {
      urls.push(u);
      return new Response(JSON.stringify({ data: { amount: "5.33", base: "USD", currency: "BRL" } }), { status: 200 });
    }) as typeof fetch;
    const pts = clean(await fromCoinbaseDaily(30, 6000, Date.parse("2026-10-09T15:00:00Z")));
    expect(urls).toHaveLength(10);
    expect(urls[0]).toContain("date=2026-10-06");
    expect(pts).toHaveLength(10);
  });

  it("descarta valores absurdos e repetidos", () => {
    const pts = clean([
      { t: 3, price: 5.4 },
      { t: 1, price: 5.2 },
      { t: 2, price: 999 },
      { t: 3, price: 5.4 },
    ]);
    expect(pts).toEqual([{ t: 1, price: 5.2 }, { t: 3, price: 5.4 }]);
  });

  it("usa a reserva quando a primeira fonte falha", async () => {
    const fail = async () => {
      throw new Error("429");
    };
    const ok = async () => [{ t: 1, price: 5.1 }, { t: 2, price: 5.2 }];
    expect(await fetchHistory(7, [fail, ok])).toHaveLength(2);
  });

  it("junta a cotação ao vivo só se for mais nova", () => {
    const pts = [{ t: 10, price: 5.2 }];
    expect(withLive(pts, { t: 20, price: 5.3 })).toHaveLength(2);
    expect(withLive(pts, { t: 5, price: 5.3 })).toHaveLength(1);
  });

  it("calcula a variação do período", () => {
    const s = summary([{ t: 1, price: 5 }, { t: 2, price: 5.5 }, { t: 3, price: 5.25 }]);
    expect(s.pct).toBeCloseTo(0.05);
    expect(s.min).toBe(5);
    expect(s.max).toBe(5.5);
  });
});

describe("alerta de cotação", () => {
  it("dispara abaixo ou acima do alvo", () => {
    expect(alertHit({ dir: "below", target: 5.3, createdAt: 0 }, 5.29)).toBe(true);
    expect(alertHit({ dir: "below", target: 5.3, createdAt: 0 }, 5.31)).toBe(false);
    expect(alertHit({ dir: "above", target: 5.5, createdAt: 0 }, 5.5)).toBe(true);
  });

  it("não deixa criar alerta que dispararia na hora", () => {
    expect(alertProblem({ dir: "below", target: 5.5 }, 5.4)).toMatch(/já está abaixo/);
    expect(alertProblem({ dir: "above", target: 5.3 }, 5.4)).toMatch(/já está acima/);
    expect(alertProblem({ dir: "below", target: 5.3 }, 5.4)).toBeNull();
    expect(alertProblem({ dir: "below", target: 0 }, 5.4)).toMatch(/entre/);
  });
});
