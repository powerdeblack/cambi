// Cotação real do dólar em reais, de fontes públicas, com reserva.
// Usado pelo app (no navegador) e pelo atualizador do oráculo na devnet (Node 22, no GitHub Actions).

export interface LiveQuote {
  price: number; // reais por dólar
  source: string; // nome da fonte, para mostrar ao usuário
  publishedAt: number; // unix (segundos) da cotação na fonte
}

const PYTH = "https://hermes.pyth.network";
const PYTH_SYMBOL = "FX.USD/BRL";

/** Faixa de sanidade: fora dela a fonte está errada, não o câmbio. */
export const isSanePrice = (p: number) => Number.isFinite(p) && p > 2 && p < 15;

async function getJson(url: string, timeoutMs: number): Promise<any> {
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

let pythFeedId: string | null = null;

/** Pyth: o mesmo oráculo usado por protocolos na Solana. */
export async function fromPyth(timeoutMs = 6000): Promise<LiveQuote> {
  if (!pythFeedId) {
    const feeds: { id: string; attributes: { symbol?: string } }[] = await getJson(
      `${PYTH}/v2/price_feeds?query=USD%2FBRL&asset_type=fx`,
      timeoutMs,
    );
    const feed = feeds.find((f) => f.attributes.symbol === PYTH_SYMBOL);
    if (!feed) throw new Error(`Pyth sem o par ${PYTH_SYMBOL}`);
    pythFeedId = feed.id;
  }
  const data = await getJson(`${PYTH}/v2/updates/price/latest?ids[]=${pythFeedId}&parsed=true`, timeoutMs);
  const p = data.parsed?.[0]?.price;
  if (!p) throw new Error("Pyth sem preço");
  return { price: Number(p.price) * 10 ** Number(p.expo), source: "Pyth", publishedAt: Number(p.publish_time) };
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

export const SOURCES = [fromPyth, fromAwesome, fromErApi];

/** Tenta as fontes em ordem e devolve a primeira cotação válida. */
export async function fetchLiveQuote(sources = SOURCES): Promise<LiveQuote> {
  const errors: string[] = [];
  for (const source of sources) {
    try {
      const q = await source();
      if (isSanePrice(q.price)) return q;
      errors.push(`${q.source}: preço fora da faixa (${q.price})`);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  throw new Error(`Nenhuma fonte de cotação respondeu: ${errors.join("; ")}`);
}
