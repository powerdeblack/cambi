// Teste de ponta a ponta na devnet com o MESMO cliente que o app usa (app/src/chain/client.ts):
// conta nova → SOL de teste → faucet do programa → troca → Rende → troca como depositante → colher taxas →
// resgate recusado pela trava → envio USDC → Pix (referência sem dados pessoais) → regras do faucet.
// Confere cada saldo com a prévia do app.
import { readFileSync, appendFileSync } from "fs";
import { fromUnits, previewSwap, toUnits } from "../app/src/chain/accounts";
import * as c from "../app/src/chain/client";
// Mesma cópia do web3.js que o cliente do app usa (evita misturar classes de duas instalações).
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } from "../app/node_modules/@solana/web3.js";

const steps: { label: string; sig: string }[] = [];
const ok = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(`Falhou: ${msg}`);
  console.log(`✓ ${msg}`);
};
async function expectFail(p: Promise<unknown>, text: RegExp, msg: string) {
  try {
    await p;
  } catch (e) {
    ok(text.test((e as Error).message), `${msg} (“${(e as Error).message}”)`);
    return;
  }
  throw new Error(`Falhou: ${msg} (a operação passou)`);
}

async function main() {
  const conn = new Connection(process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com", "confirmed");
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.ANCHOR_WALLET!, "utf8"))));
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

  // O faucet público de SOL limita IPs de servidores; aqui o admin (no CI) cobre as taxas da conta de teste.
  await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: me, lamports: 0.03 * LAMPORTS_PER_SOL })), [admin]);
  ok((await c.ensureSol(me)) >= c.MIN_SOL, "conta com SOL de teste para as taxas (e rede conferida: devnet)");

  steps.push({ label: "Moedas de teste pelo faucet do programa (R$ 1.000)", sig: await c.faucetClaim(signer) });
  let s = await c.fetchState(me);
  ok(s.balances[0] === toUnits(c.FAUCET_BRL), "recebeu 1.000 cBRL do faucet on-chain");
  await expectFail(c.faucetClaim(signer), /1 hora|R\$ 100/, "faucet recusa pedido repetido (regra on-chain)");

  const pv = previewSwap(s, 0, toUnits(100));
  ok(pv.kind === "retail" && !pv.blocker, "prévia: varejo, sem bloqueio");
  const sw = await c.swap(signer, s, 0, toUnits(100), pv.q.amountOut);
  steps.push({ label: `Troca varejo R$ 100 → US$ ${fromUnits(sw.q.amountOut)}`, sig: sw.sig });
  s = await c.fetchState(me);
  ok(s.balances[0] === toUnits(900), "saiu R$ 100");
  ok(s.balances[1] === sw.q.amountOut, `recebeu exatamente a prévia (US$ ${fromUnits(sw.q.amountOut)})`);
  await expectFail(c.swap(signer, s, 0, toUnits(100), pv.q.amountOut * 2n), /cotação mudou/, "recusa trocar abaixo do valor que a pessoa viu");

  steps.push({ label: "Depósito na Rende: R$ 200", sig: await c.depositRende(signer, 0, toUnits(200)) });
  s = await c.fetchState(me);
  ok(s.positions.some((p) => p.side === 0 && p.raw.amount === toUnits(200)), "posição na Rende com R$ 200");
  await expectFail(c.depositRende(signer, 0, toUnits(5)), /mínimo/, "recusa depósito abaixo de R$ 10");

  const pv2 = previewSwap(s, 0, toUnits(100));
  ok(pv2.kind === "depositor", "agora é depositante");
  const sw2 = await c.swap(signer, s, 0, toUnits(100), pv2.q.amountOut);
  steps.push({ label: `Troca como depositante R$ 100 (taxa ${Number(sw2.q.feeBps) / 100}%)`, sig: sw2.sig });
  ok(sw2.q.feeBps < pv.q.feeBps, "depositante pagou taxa menor");

  s = await c.fetchState(me);
  const pending = s.positions.find((p) => p.side === 0)!.pending;
  const brlBefore = s.balances[0];
  steps.push({ label: "Depositante colhe as taxas (liberado mesmo com a trava)", sig: await c.withdrawRende(signer, 0, 0n) });
  s = await c.fetchState(me);
  ok(s.balances[0] - brlBefore === pending[0], "recebeu exatamente as taxas pendentes em reais");
  await expectFail(c.withdrawRende(signer, 0, toUnits(200)), /período mínimo/, "resgate do principal travado logo após o depósito");

  const friend = Keypair.generate().publicKey;
  steps.push({ label: "Envio de US$ 5 para carteira USDC (TransferChecked)", sig: await c.sendOut(signer, 1, toUnits(5), "usdc", friend.toBase58(), "usdc-e2e") });
  ok((await c.fetchState(friend)).balances[1] === toUnits(5), "carteira de destino recebeu US$ 5");
  await expectFail(c.sendOut(signer, 1, toUnits(1), "usdc", c.positionPda(me, 0, 0).toBase58(), "x"), /não é uma carteira/, "recusa enviar para endereço de programa");

  steps.push({ label: "Pix de R$ 10 (para o parceiro, memo só com referência)", sig: await c.sendOut(signer, 0, toUnits(10), "pix", "", "pix-e2e-ref") });

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
