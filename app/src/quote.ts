// Cotação real do dólar em reais, de fontes públicas sem chave de API, com reserva.
// Em produção, o programa leria o Pyth direto na Solana (a API pública do Pyth hoje pede chave).
// Usado pelo app (no navegador) e pelo atualizador do oráculo na devnet (Node 22, no GitHub Actions).

export interface LiveQuote {
  price: number; // reais por dólar
  source: string; // nome da fonte, para mostrar ao usuário
  publishedAt: number; // unix (segundos) da cotação na fonte
}

/** Faixa de sanidade: fora dela a fonte está errada, não o câmbio. */
export const isSanePrice = (p: number) => Number.isFinite(p) && p > 2 && p < 15;

export async function getJson(url: string, timeoutMs: number): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`${res.status} em ${new URL(url).host}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** Coinbase: cotação de mercado atualizada continuamente. */
export async function fromCoinbase(timeoutMs = 6000): Promise<LiveQuote> {
  const data = await getJson("https://api.coinbase.com/v2/exchange-rates?currency=USD", timeoutMs);
  return { price: Number(data.data?.rates?.BRL), source: "Coinbase", publishedAt: Math.floor(Date.now() / 1000) };
}

/** AwesomeAPI: cotação comercial brasileira. */
export async function fromAwesome(timeoutMs = 6000): Promise<LiveQuote> {
  const data = await getJson("https://economia.awesomeapi.com.br/json/last/USD-BRL", timeoutMs);
  const q = data.USDBRL;
  if (!q) throw new Error("AwesomeAPI sem USDBRL");
  return { price: Number(q.bid), source: "AwesomeAPI", publishedAt: Number(q.timestamp) };
}

/** ExchangeRate-API: atualiza uma vez por dia; última reserva. */
export async function fromErApi(timeoutMs = 6000): Promise<LiveQuote> {
  const data = await getJson("https://open.er-api.com/v6/latest/USD", timeoutMs);
  return { price: Number(data.rates?.BRL), source: "ExchangeRate-API", publishedAt: Number(data.time_last_update_unix) };
}

/** Mercado Bitcoin: dólar digital (USDT) em reais negociado no Brasil, ao vivo. Usado pelo oráculo. */
export async function fromMercadoBitcoin(timeoutMs = 6000): Promise<LiveQuote> {
  const data = await getJson("https://api.mercadobitcoin.net/api/v4/tickers?symbols=USDT-BRL", timeoutMs);
  const t = Array.isArray(data) ? data[0] : null;
  if (!t) throw new Error("Mercado Bitcoin sem USDT-BRL");
  return { price: Number(t.last), source: "Mercado Bitcoin", publishedAt: Number(t.date) || Math.floor(Date.now() / 1000) };
}

/** Frankfurter (Banco Central Europeu): referência oficial, uma vez por dia útil. Só o oráculo usa. */
export async function fromFrankfurterLatest(timeoutMs = 6000): Promise<LiveQuote> {
  const data = await getJson("https://api.frankfurter.dev/v1/latest?base=USD&symbols=BRL", timeoutMs);
  const day = String(data?.date ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("Frankfurter sem data");
  // O BCE publica perto das 16h de Frankfurt (14h UTC).
  return { price: Number(data.rates?.BRL), source: "BCE (Frankfurter)", publishedAt: Date.parse(`${day}T14:00:00Z`) / 1000 };
}

/** Fontes do app (só exibição). */
export const SOURCES = [fromCoinbase, fromAwesome, fromErApi];
/** Fontes do oráculo que grava na blockchain: precisam concordar entre si. */
export const ORACLE_SOURCES = [fromCoinbase, fromMercadoBitcoin, fromAwesome, fromErApi, fromFrankfurterLatest];

export interface Consensus {
  price: number;
  used: LiveQuote[];
  rejected: string[];
}

/**
 * Cotação por consenso, para o oráculo: busca todas as fontes, descarta as velhas e as fora da faixa, e usa a
 * mediana das que ficam a até `maxSpread` da mediana geral. Exige pelo menos `minSources` concordando; senão,
 * não grava nada (o pool para de trocar sozinho quando a cotação vence, em vez de usar um preço duvidoso).
 */
export async function fetchConsensusQuote(
  sources = ORACLE_SOURCES,
  opts: { minSources?: number; maxSpread?: number; maxAgeSec?: number; now?: number } = {},
): Promise<Consensus> {
  const { minSources = 2, maxSpread = 0.02, maxAgeSec = 36 * 3600, now = Math.floor(Date.now() / 1000) } = opts;
  const rejected: string[] = [];
  const results = await Promise.allSettled(sources.map((s) => s()));
  const ok: LiveQuote[] = [];
  results.forEach((r, i) => {
    if (r.status === "rejected") return rejected.push(`${sources[i].name}: ${(r.reason as Error).message}`);
    const q = r.value;
    if (!isSanePrice(q.price)) return rejected.push(`${q.source}: fora da faixa (${q.price})`);
    if (now - q.publishedAt > maxAgeSec) return rejected.push(`${q.source}: cotação velha`);
    ok.push(q);
  });
  const median = (xs: number[]) => {
    const v = [...xs].sort((a, b) => a - b);
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  };
  if (ok.length < minSources) throw new Error(`Fontes insuficientes (${ok.length}/${minSources}). ${rejected.join("; ")}`);
  const m0 = median(ok.map((q) => q.price));
  const used = ok.filter((q) => {
    const fine = Math.abs(q.price / m0 - 1) <= maxSpread;
    if (!fine) rejected.push(`${q.source}: discorda da mediana (${q.price} vs ${m0.toFixed(4)})`);
    return fine;
  });
  if (used.length < minSources) throw new Error(`Fontes não concordam (${used.length}/${minSources}). ${rejected.join("; ")}`);
  return { price: median(used.map((q) => q.price)), used, rejected };
}

/**
 * Maior grupo de cotações que concordam entre si (diferença máxima de `band`, ex.: 0,003 = 0,3%), e o preço do
 * grupo (mediana). Diferente de medir a distância até a mediana de todas: com uma fonte em estresse (ex.: dólar
 * cripto com prêmio depois de um hack) a mediana geral cai entre os grupos e nenhum par "concorda", mesmo com duas
 * fontes comerciais iguais. Empate: o grupo mais perto da mediana geral.
 */
export function agreeingCluster(quotes: LiveQuote[], band = 0.003): { price: number; members: LiveQuote[] } | null {
  const v = [...quotes].sort((a, b) => a.price - b.price);
  const med = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const all = med(v.map((q) => q.price));
  let best: LiveQuote[] = [];
  for (let i = 0; i < v.length; i++) {
    const group = v.filter((q, j) => j >= i && q.price / v[i].price - 1 <= band);
    const closer = (g: LiveQuote[]) => Math.abs(med(g.map((q) => q.price)) - all);
    if (group.length > best.length || (group.length === best.length && group.length > 0 && closer(group) < closer(best))) best = group;
  }
  return best.length >= 2 ? { price: med(best.map((q) => q.price)), members: best } : null;
}

/** Tenta as fontes em ordem e devolve a primeira cotação válida. */
export async function fetchLiveQuote(sources = SOURCES, onSkip?: (reason: string) => void): Promise<LiveQuote> {
  const errors: string[] = [];
  const skip = (reason: string) => {
    errors.push(reason);
    onSkip?.(reason);
  };
  for (const source of sources) {
    try {
      const q = await source();
      if (isSanePrice(q.price)) return q;
      skip(`${q.source}: preço fora da faixa (${q.price})`);
    } catch (e) {
      skip(`${source.name}: ${(e as Error).message}`);
    }
  }
  throw new Error(`Nenhuma fonte de cotação respondeu: ${errors.join("; ")}`);
}
