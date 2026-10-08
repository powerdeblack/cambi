// Leitura do pool real na devnet, sem dependências pesadas: decodifica a conta Pool (Borsh) direto.
// O layout segue `pub struct Pool` em programs/cambi_pool/src/lib.rs.

export interface OnchainPool {
  price: number; // reais por dólar
  priceUpdatedAt: number; // unix
  paused: boolean;
  principal: { rendeBRL: number; rendeUSD: number; baleiaBRL: number; baleiaUSD: number };
  lpFeesUnclaimed: [number, number];
  platformFees: [number, number];
  partnerFees: [number, number];
  swapCount: number;
  volumeBRL: number;
}

const UNIT = 1_000_000;

export function decodePool(data: Uint8Array): OnchainPool {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 8 + 32 * 6; // discriminador + admin, oracle, 2 mints, 2 cofres
  const u64 = () => {
    const x = v.getBigUint64(o, true);
    o += 8;
    return Number(x);
  };
  const i64 = () => {
    const x = v.getBigInt64(o, true);
    o += 8;
    return Number(x);
  };
  const price = u64() / UNIT;
  const priceUpdatedAt = i64();
  i64(); // max_price_age
  o += 2 * 12; // FeeConfig: 12 campos u16
  const paused = data[o] === 1;
  o += 1;
  const principal = [u64(), u64(), u64(), u64()].map((x) => x / UNIT);
  o += 16 * 2; // shares [u128; 2]
  o += 16 * 4; // acc_fee_per_share [u128; 4]
  const pair = (): [number, number] => [u64() / UNIT, u64() / UNIT];
  const lpFeesUnclaimed = pair();
  const platformFees = pair();
  const partnerFees = pair();
  const swapCount = u64();
  const volumeBRL = u64() / UNIT;
  return {
    price,
    priceUpdatedAt,
    paused,
    principal: { rendeBRL: principal[0], rendeUSD: principal[1], baleiaBRL: principal[2], baleiaUSD: principal[3] },
    lpFeesUnclaimed,
    platformFees,
    partnerFees,
    swapCount,
    volumeBRL,
  };
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${res.status}`);
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(json.error.message);
  return json.result as T;
}

export async function fetchPool(rpcUrl: string, pool: string): Promise<OnchainPool> {
  const r = await rpc<{ value: { data: [string, string] } | null }>(rpcUrl, "getAccountInfo", [
    pool,
    { encoding: "base64", commitment: "confirmed" },
  ]);
  if (!r.value) throw new Error("Pool não encontrado na devnet");
  return decodePool(base64ToBytes(r.value.data[0]));
}

export async function fetchTokenBalance(rpcUrl: string, account: string): Promise<number> {
  const r = await rpc<{ value: { uiAmount: number | null } }>(rpcUrl, "getTokenAccountBalance", [account, { commitment: "confirmed" }]);
  return r.value.uiAmount ?? 0;
}
