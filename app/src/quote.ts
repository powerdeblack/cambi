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

export const SOURCES = [fromCoinbase, fromAwesome, fromErApi];

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
