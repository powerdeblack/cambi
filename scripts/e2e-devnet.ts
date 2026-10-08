// Teste de ponta a ponta na devnet com o MESMO cliente que o app usa (app/src/chain/client.ts):
// conta nova → moedas de teste → troca → depósito na Rende → troca como depositante → colher taxas →
// envio para carteira USDC → envio Pix (para o parceiro) → resgate. Confere cada saldo com a prévia do app.
// Mesma cópia do web3.js que o cliente do app usa (evita misturar classes de duas instalações).
import { Keypair, Transaction } from "../app/node_modules/@solana/web3.js";
import { appendFileSync } from "fs";
import { fromUnits, previewSwap, toUnits } from "../app/src/chain/accounts";
import * as c from "../app/src/chain/client";

const steps: { label: string; sig: string }[] = [];
const ok = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(`Falhou: ${msg}`);
  console.log(`✓ ${msg}`);
};

async function main() {
  const kp = Keypair.generate();
  const signer: c.ChainSigner = {
    kind: "local",
    publicKey: kp.publicKey,
    async signTransaction(tx: Transaction) {
      tx.partialSign(kp);
      return tx;
    },
  };
  const me = kp.publicKey;
  console.log(`Conta de teste: ${me.toBase58()}`);

  steps.push({ label: "Conta criada + R$ 1.000 de teste (pago pelo patrocinador)", sig: await c.onboard(me) });
  let s = await c.fetchState(me);
  ok(s.balances[0] === toUnits(c.FAUCET_BRL), "recebeu 1.000 cBRL");
  ok(s.sol > 0.01, "recebeu SOL para as taxas");

  // Troca varejo: o recebido tem que ser exatamente a prévia do app.
  const pv = previewSwap(s, 0, toUnits(100));
  ok(pv.kind === "retail" && !pv.blocker, "prévia: varejo, sem bloqueio");
  const sw = await c.swap(signer, s, 0, toUnits(100));
  steps.push({ label: `Troca varejo R$ 100 → US$ ${fromUnits(sw.q.amountOut)}`, sig: sw.sig });
  s = await c.fetchState(me);
  ok(s.balances[0] === toUnits(900), "saiu R$ 100");
  ok(s.balances[1] === sw.q.amountOut, `recebeu exatamente a prévia (US$ ${fromUnits(sw.q.amountOut)})`);

  steps.push({ label: "Depósito na Rende: R$ 200", sig: await c.depositRende(signer, 0, toUnits(200)) });
  s = await c.fetchState(me);
  ok(s.positions.some((p) => p.side === 0 && p.raw.amount === toUnits(200)), "posição na Rende com R$ 200");

  const pv2 = previewSwap(s, 0, toUnits(100));
  ok(pv2.kind === "depositor", "agora é depositante");
  const sw2 = await c.swap(signer, s, 0, toUnits(100));
  steps.push({ label: `Troca como depositante R$ 100 (taxa ${Number(sw2.q.feeBps) / 100}%)`, sig: sw2.sig });
  ok(sw2.q.feeBps < pv.q.feeBps, "depositante pagou taxa menor");

  s = await c.fetchState(me);
  const pending = s.positions.find((p) => p.side === 0)!.pending;
  console.log(`Taxas a receber: R$ ${fromUnits(pending[0])} + US$ ${fromUnits(pending[1])}`);
  const brlBefore = s.balances[0];
  steps.push({ label: "Depositante colhe as taxas", sig: await c.withdrawRende(signer, 0, 0n) });
  s = await c.fetchState(me);
  ok(s.balances[0] - brlBefore === pending[0], "recebeu exatamente as taxas pendentes em reais");

  const friend = Keypair.generate().publicKey;
  steps.push({ label: "Envio de US$ 5 para carteira USDC", sig: await c.sendOut(signer, 1, toUnits(5), "usdc", friend.toBase58(), "USDC para teste") });
  const friendState = await c.fetchState(friend);
  ok(friendState.balances[1] === toUnits(5), "carteira de destino recebeu US$ 5");

  steps.push({ label: "Pix de R$ 10 (para o parceiro, com o destino no memo)", sig: await c.sendOut(signer, 0, toUnits(10), "pix", "", "Pix para (11) *****-4321") });

  steps.push({ label: "Resgate total da Rende", sig: await c.withdrawRende(signer, 0, toUnits(200)) });
  s = await c.fetchState(me);
  ok(s.positions.every((p) => p.raw.amount === 0n), "posição zerada");

  const rows = steps.map((st) => `| ${st.label} | [ver](${c.explorerTx(st.sig)}) |`).join("\n");
  const md = `## Teste de ponta a ponta na devnet (cliente do app)\n\nConta: [${me.toBase58()}](${c.explorerAddress(me.toBase58())})\n\n| Passo | Transação |\n|---|---|\n${rows}\n`;
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
}

main().catch((e) => {
  console.error(e);
  if (e?.cause) console.error("Causa:", e.cause);
  process.exit(1);
});
