// Garante que o leitor da demo (app/src/onchain.ts) entende a conta Pool exatamente como o Anchor a grava.
import * as anchor from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import { expect } from "chai";
import { decodePool } from "../app/src/onchain";
import idl from "../target/idl/cambi_pool.json";

describe("decodificador do pool da demo", () => {
  it("lê os mesmos valores que o Anchor grava", async () => {
    const coder = new anchor.BorshAccountsCoder(idl as anchor.Idl);
    const k = () => Keypair.generate().publicKey;
    const BN = (n: number | string) => new anchor.BN(n);
    const pool = {
      admin: k(),
      oracle: k(),
      brl_mint: k(),
      usd_mint: k(),
      brl_vault: k(),
      usd_vault: k(),
      price: BN(5_400_000),
      price_updated_at: BN(1_760_000_000),
      max_price_age: BN(3600),
      fees: {
        depositor_bps: 50,
        retail_bps: 100,
        b2b_bps: 40,
        depositor_pix_bps: 5000,
        retail_pix_bps: 10000,
        b2b_pix_bps: 2000,
        partner_cost_bps: 20,
        platform_share_bps: 2500,
        baleia_share_bps: 7000,
        dynamic_min_bps: 7000,
        dynamic_max_bps: 15000,
        max_trade_bps: 2000,
      },
      paused: true,
      principal: [BN(50_000_000_000), BN(10_000_000_000), BN(10_000_000_000), BN(2_000_000_000)],
      shares: [BN("104000000000"), BN("20800000000")],
      acc_fee_per_share: [BN(1), BN(2), BN(3), BN(4)],
      lp_fees_unclaimed: [BN(1_500_000), BN(250_000)],
      platform_fees: [BN(2_000_000), BN(0)],
      partner_fees: [BN(3_000_000), BN(400_000)],
      swap_count: BN(7),
      volume_brl: BN(3_080_000_000),
      bump: 254,
    };
    const data = await coder.encode("Pool", pool);
    const d = decodePool(new Uint8Array(data));
    expect(d.price).to.equal(5.4);
    expect(d.priceUpdatedAt).to.equal(1_760_000_000);
    expect(d.paused).to.equal(true);
    expect(d.principal).to.deep.equal({ rendeBRL: 50_000, rendeUSD: 10_000, baleiaBRL: 10_000, baleiaUSD: 2_000 });
    expect(d.lpFeesUnclaimed).to.deep.equal([1.5, 0.25]);
    expect(d.platformFees).to.deep.equal([2, 0]);
    expect(d.partnerFees).to.deep.equal([3, 0.4]);
    expect(d.swapCount).to.equal(7);
    expect(d.volumeBRL).to.equal(3_080);
  });
});
