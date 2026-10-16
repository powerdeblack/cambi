// QR Codes de pagamento: BR Code do Pix (padrão EMV do Banco Central) e Solana Pay (transferência em USDC).
// Só texto: ler, conferir e montar os códigos. A câmera e o desenho do QR ficam na tela.

/** CRC16/CCITT-FALSE (polinômio 0x1021, início 0xFFFF), exigido no campo 63 do BR Code. */
export function crc16(text: string): string {
  let crc = 0xffff;
  for (const byte of new TextEncoder().encode(text)) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/** Lê os campos ID(2) + tamanho(2) + valor do padrão EMV. */
function tlv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i + 4 <= text.length) {
    const id = text.slice(i, i + 2);
    const len = Number(text.slice(i + 2, i + 4));
    if (!Number.isInteger(len) || i + 4 + len > text.length) throw new Error("Código Pix malformado");
    out.set(id, text.slice(i + 4, i + 4 + len));
    i += 4 + len;
  }
  if (i !== text.length) throw new Error("Código Pix malformado");
  return out;
}

const field = (id: string, value: string) => {
  if (value.length > 99) throw new Error(`Campo ${id} longo demais`);
  return id + String(value.length).padStart(2, "0") + value;
};

export interface PixCharge {
  key: string; // chave Pix de quem recebe
  name: string; // nome de quem recebe (até 25 caracteres)
  city: string; // cidade (até 15 caracteres)
  amount?: number; // em reais; sem valor, quem paga digita
  txid?: string; // identificador da cobrança
}

/** Lê um "Pix copia e cola" (BR Code estático ou com valor) e confere o CRC. */
export function parsePix(code: string): PixCharge {
  const text = code.trim();
  if (!text.startsWith("000201")) throw new Error("Não é um código Pix");
  const crcAt = text.lastIndexOf("6304");
  if (crcAt < 0 || crcAt + 8 !== text.length) throw new Error("Código Pix sem verificação (CRC)");
  if (crc16(text.slice(0, crcAt + 4)) !== text.slice(crcAt + 4).toUpperCase()) throw new Error("Código Pix inválido: a verificação (CRC) não confere");
  const f = tlv(text);
  const account = f.get("26");
  if (!account) throw new Error("Código Pix sem conta de recebimento");
  const acc = tlv(account);
  if ((acc.get("00") ?? "").toLowerCase() !== "br.gov.bcb.pix") throw new Error("Não é um código Pix do Banco Central");
  const key = acc.get("01");
  if (!key) throw new Error("Código Pix sem chave (talvez seja um Pix dinâmico, que precisa do banco para ser lido)");
  if (f.get("53") && f.get("53") !== "986") throw new Error("Cobrança Pix em moeda diferente do real");
  const amount = f.get("54") ? Number(f.get("54")) : undefined;
  if (amount !== undefined && !(amount > 0)) throw new Error("Valor do Pix inválido");
  const extra = f.get("62") ? tlv(f.get("62")!) : undefined;
  const txid = extra?.get("05");
  return { key, name: f.get("59") ?? "", city: f.get("60") ?? "", amount, txid: txid && txid !== "***" ? txid : undefined };
}

/** Monta um BR Code estático (com ou sem valor), como o "Pix copia e cola" dos bancos. */
export function buildPix(c: PixCharge): string {
  const clean = (s: string, max: number) =>
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^A-Za-z0-9 .\-@+]/g, "")
      .slice(0, max)
      .trim();
  const account = field("00", "br.gov.bcb.pix") + field("01", c.key);
  const body =
    field("00", "01") +
    field("26", account) +
    field("52", "0000") +
    field("53", "986") +
    (c.amount ? field("54", c.amount.toFixed(2)) : "") +
    field("58", "BR") +
    field("59", clean(c.name, 25) || "RECEBEDOR") +
    field("60", clean(c.city, 15) || "BRASIL") +
    field("62", field("05", (c.txid ?? "***").replace(/[^A-Za-z0-9]/g, "").slice(0, 25) || "***")) +
    "6304";
  return body + crc16(body);
}

export interface SolanaPayRequest {
  recipient: string; // carteira que recebe (base58)
  amount?: number; // na unidade do token
  splToken?: string; // mint do token (ausente = SOL)
  reference?: string;
  label?: string;
  message?: string;
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Lê um link de transferência Solana Pay ("solana:<carteira>?amount=...&spl-token=..."). */
export function parseSolanaPay(url: string): SolanaPayRequest {
  const text = url.trim();
  if (!/^solana:/i.test(text)) throw new Error("Não é um link Solana Pay");
  const rest = text.slice("solana:".length);
  if (/^https?:/i.test(decodeURIComponent(rest))) throw new Error("Este Solana Pay é do tipo pedido de transação, ainda não suportado aqui");
  const [path, query = ""] = rest.split("?");
  const recipient = decodeURIComponent(path);
  if (!BASE58.test(recipient)) throw new Error("Carteira de destino inválida no Solana Pay");
  const q = new URLSearchParams(query);
  const amountText = q.get("amount");
  if (amountText !== null && !/^\d+(\.\d+)?$/.test(amountText)) throw new Error("Valor inválido no Solana Pay");
  const amount = amountText === null ? undefined : Number(amountText);
  const splToken = q.get("spl-token") ?? undefined;
  if (splToken && !BASE58.test(splToken)) throw new Error("Token inválido no Solana Pay");
  const reference = q.getAll("reference")[0] ?? undefined;
  if (reference && !BASE58.test(reference)) throw new Error("Referência inválida no Solana Pay");
  return {
    recipient,
    amount,
    splToken,
    reference,
    label: q.get("label") ?? undefined,
    message: q.get("message") ?? undefined,
  };
}

/** Monta um link Solana Pay de transferência (o que vira QR Code para quem paga de fora do Brasil). */
export function buildSolanaPay(r: SolanaPayRequest): string {
  const q = new URLSearchParams();
  if (r.amount !== undefined) q.set("amount", String(Number(r.amount.toFixed(6))));
  if (r.splToken) q.set("spl-token", r.splToken);
  if (r.reference) q.set("reference", r.reference);
  if (r.label) q.set("label", r.label);
  if (r.message) q.set("message", r.message);
  const qs = q.toString();
  return `solana:${r.recipient}${qs ? `?${qs}` : ""}`;
}

export type ScannedQr = { kind: "pix"; pix: PixCharge; raw: string } | { kind: "solana"; pay: SolanaPayRequest; raw: string };

/** Reconhece o que foi escaneado ou colado: Pix ou Solana Pay. */
export function readQr(text: string): ScannedQr {
  const raw = text.trim();
  if (/^solana:/i.test(raw)) return { kind: "solana", pay: parseSolanaPay(raw), raw };
  if (raw.startsWith("000201")) return { kind: "pix", pix: parsePix(raw), raw };
  throw new Error("Esse código não é um Pix nem um Solana Pay");
}

/**
 * Quanto colocar numa troca para receber `target` do outro lado, dado o que uma troca de `probe` rende.
 * Taxa proporcional: basta escalar; uma folga mínima cobre arredondamentos.
 */
export function amountForTarget(target: number, probe: number, probeOut: number): number {
  if (!(probeOut > 0)) throw new Error("Cotação indisponível");
  return Math.ceil(((target * probe) / probeOut) * 1.0005 * 100) / 100;
}
