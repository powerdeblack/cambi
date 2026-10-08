// Teste das TELAS do app contra a devnet real, num navegador de verdade (Chromium headless).
// Cria a conta, troca, deposita na Rende e envia um Pix pela interface, esperando cada comprovante da blockchain.
// Uso: node scripts/ui-e2e.cjs http://localhost:4173/ [pasta-de-prints]
const { chromium } = require("playwright");
const fs = require("fs");
const web3 = require("../app/node_modules/@solana/web3.js");

/** O faucet público de SOL limita IPs de servidores: no CI o admin cobre as taxas da conta criada na tela. */
async function fundFromAdmin(address) {
  const conn = new web3.Connection("https://api.devnet.solana.com", "confirmed");
  const admin = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.ANCHOR_WALLET, "utf8"))));
  const tx = new web3.Transaction().add(
    web3.SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: new web3.PublicKey(address), lamports: 0.03 * web3.LAMPORTS_PER_SOL }),
  );
  await web3.sendAndConfirmTransaction(conn, tx, [admin]);
}

const url = process.argv[2] || "http://localhost:4173/";
const out = process.argv[3] || "ui-e2e";
fs.mkdirSync(out, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
  let n = 0;
  const shot = (name) => page.screenshot({ path: `${out}/${String(++n).padStart(2, "0")}-${name}.png` });
  const step = (msg) => console.log(`✓ ${msg}`);
  const CHAIN = 90_000;

  await page.goto(url);
  await page.getByRole("button", { name: "Criar minha conta grátis" }).click();
  const ready = page.getByText("Conta na Solana · devnet");
  const needSol = page.getByText("Falta só o SOL de teste");
  await ready.or(needSol).waitFor({ timeout: CHAIN });
  if (await needSol.isVisible()) {
    const address = (await page.locator(".address").innerText()).trim();
    await shot("precisa-de-sol");
    step(`tela de SOL de teste apareceu (faucet público limitado); conta ${address}`);
    await fundFromAdmin(address);
    await page.getByRole("button", { name: "Já recebi, continuar" }).click();
  }
  await ready.waitFor({ timeout: CHAIN });
  await page.locator(".balance-card").getByText("R$ 1.000,00").first().waitFor({ timeout: CHAIN });
  await shot("conta-criada");
  step("conta criada pela interface, com R$ 1.000 do faucet do programa");

  await page.getByRole("navigation").getByRole("button", { name: "Trocar" }).click();
  const input = page.getByLabel("Você envia");
  await input.click();
  await input.pressSequentially("10000"); // R$ 100,00
  await page.getByText("Cotação do pool").waitFor();
  await shot("troca-previa");
  await page.getByRole("button", { name: /^Trocar R\$/ }).click();
  await page.getByText("Registrada na Solana").waitFor({ timeout: CHAIN });
  await shot("troca-comprovante");
  step("troca real com comprovante na Solana");
  await page.getByRole("button", { name: "Deixar na carteira" }).click();

  await page.getByRole("navigation").getByRole("button", { name: "Rende" }).click();
  await page.getByRole("button", { name: /^Depositar R\$/ }).click();
  await page.getByText("Depósito feito").waitFor({ timeout: CHAIN });
  await page.getByText("Resgate liberado às").waitFor({ timeout: CHAIN });
  await shot("rende-deposito");
  step("depósito real na Rende, com aviso da trava de resgate");

  await page.getByRole("navigation").getByRole("button", { name: "Início" }).click();
  await page.locator(".quick-actions").getByRole("button", { name: "Enviar" }).click();
  await page.getByRole("button", { name: /Pix em reais/ }).click();
  await page.getByLabel("Celular").fill("(11) 98765-4321");
  await page.getByLabel("Nome do contato (opcional)").fill("Maria Lima");
  await page.getByRole("button", { name: /Continuar com esta chave/ }).click();
  await page.getByRole("button", { name: "25%" }).click();
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByRole("button", { name: /Confirmar e enviar/ }).click();
  await page.getByText("Registrado na Solana").waitFor({ timeout: CHAIN });
  await shot("pix-comprovante");
  step("Pix com comprovante na Solana");
  await page.getByRole("button", { name: "Concluir" }).click();

  await page.getByText("ver na blockchain ↗").first().waitFor();
  const links = await page.getByText("ver na blockchain ↗").count();
  await page.locator(".activity").scrollIntoViewIfNeeded();
  await shot("atividade");
  step(`atividade com ${links} links para a blockchain`);

  // Recarregar mantém a mesma conta e os saldos vindos da blockchain.
  await page.reload();
  await page.getByText("Conta na Solana · devnet").waitFor({ timeout: CHAIN });
  step("conta continua ativa depois de recarregar");

  await browser.close();
  const relevant = errors.filter((e) => !/favicon|429|Failed to load resource/i.test(e));
  if (relevant.length) {
    console.error("Erros no navegador:\n" + relevant.join("\n"));
    process.exit(1);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
