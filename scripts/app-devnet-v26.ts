// Gera app/src/devnet.json (o que o app do v2 lê) a partir de deployments/devnet-v26.json, o registro do pool v2.6.
// Uso: npx tsx scripts/app-devnet-v26.ts
import { readFileSync, writeFileSync } from "node:fs";

const d = JSON.parse(readFileSync("deployments/devnet-v26.json", "utf8"));
const c = d.council;
const out = {
  cluster: "devnet",
  version: "2.6",
  kind: "consortium-v2",
  rpc: d.rpc,
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
  programId: d.programId,
  guardianProgramId: d.guardianProgramId,
  pool: d.pool,
  brlMint: d.brlMint,
  usdMint: d.usdMint,
  brlVault: d.brlVault,
  usdVault: d.usdVault,
  mintAuthority: d.mintAuthority,
  guardian: d.guardian,
  watch: d.watch,
  admin: d.admin,
  oracle: d.oracle,
  // Na devnet, o deployer faz o papel do parceiro que recebe os envios Pix/conta nos EUA.
  payout: d.upgradeAuthority,
  upgradeAuthority: d.upgradeAuthority,
  consortium: {
    note: c.note,
    multisig: c.multisig,
    vault: c.vault,
    threshold: c.threshold,
    members: c.members.map((key: string, i: number) => ({ name: `Conselheiro ${i + 1}`, key })),
    // Só as validações mais recentes, para o card não crescer sem fim com as rodadas diárias.
    validations: [...c.validations].sort((a: { index: number }, b: { index: number }) => b.index - a.index).slice(0, 6),
  },
  liquidity: d.liquidity,
  security: d.security,
  transactions: d.transactions,
  links: d.links,
};
writeFileSync("app/src/devnet.json", JSON.stringify(out, null, 2) + "\n");
console.log(`app/src/devnet.json: pool ${out.pool}, ${out.consortium.validations.length} validações`);
