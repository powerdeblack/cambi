<p align="center">
  <img src="brand/logo.svg" alt="cambI" height="72" />
</p>

<h3 align="center">O câmbio sou eu. <i>(“I am the exchange.”)</i></h3>

<p align="center"><b>English</b> · <a href="README.pt-BR.md">Português</a></p>

<p align="center">
  An on-chain currency exchange (Brazilian real ↔ US dollar) where the customers are the owners.<br/>
  Instant swaps, 24/7, with every cent of the fee shown. And people who leave money in the pool earn from everyone else's swaps.
</p>

---

**Try it in 2 minutes:** open the [live app](https://powerdeblack.github.io/cambi/) on your phone → tap
**“Criar minha conta grátis”** (create free account) → **Trocar** (swap) R$ 100 → tap **“ver transação”** to open the
real transaction on Solana Explorer. Other tabs: **Enviar** (send via Pix, to a US bank account or a USDC wallet),
**Rende** (deposit and earn) and **Pool**. Devnet only: no real money is used.

The app is in Portuguese because the first market is Brazil. Some docs are in Portuguese too (linked below).

## The problem

When a Brazilian exchanges reais for dollars, the spread is invisible and goes entirely to the middleman: over 5% at
banks and close to 4% at exchange offices. Fintechs lowered the cost, but the customer is still just a customer. Most
people never knew how much they paid, or to whom.

## The solution

**cambI** = *câmbio* (exchange) + **I**.

- **Instant swaps** between reais and digital dollars **at the real market rate** (live in the app; written to the
  devnet pool several times a day), with the fee shown before confirming.
- **The other side of the trade:** reais go out by **Pix** to any key, and dollars go to a **US bank account** (ACH)
  or a **USDC wallet** on Solana, with review, receipt and recent contacts (simulated in the demo).
- **“Where did your money go?”**: every swap shows how the fee was split and what it would have cost at a bank or an
  exchange office.
- **A pool with two tranches:**
  - 🟢 **cambI Rende** (anyone, from R$ 10): mostly invested in fixed income, plus a share of the fees. Protected:
    imbalance losses hit Baleia first (senior tranche).
  - 🐋 **cambI Baleia** (qualified investors): the liquidity engine. Takes the risk and gets the larger share of the
    fees (junior tranche).
- **Dynamic fee:** cheaper in the direction that balances the pool, more expensive in the one that unbalances it.
- **Aligned incentives:** cambI only charges performance on Rende returns above 100% of CDI (the Brazilian interbank
  rate).

| Who | Pays to swap | Earns (simulation, 5% daily turnover) |
|---|---|---|
| Retail | 1.0% | — |
| Depositor | 0.5% | Rende in reais: ~108% of CDI · in dollars: ~1.4× the T-bill |
| Baleia | — | ~27% a year, taking the imbalance risk |
| Partner app (B2B) | 0.4% | 24/7 real ↔ dollar liquidity |

**Business model:** the platform keeps 25% of net fees plus 20% of Rende returns above 100% of CDI. Assumptions,
sources and risks in [docs/ECONOMIA.md](docs/ECONOMIA.md) (Portuguese). **Simulations are not a promise of returns.**

## Why now

- Brazilians spent **US$ 21.7 billion** abroad in 2025, the highest since 2014.
- About **80%** of the crypto volume declared to Brazil's tax authority is stablecoins.
- Since **February 2026**, Brazilian Central Bank rules (Res. 519/520/521) treat stablecoin trades as foreign exchange,
  done through authorized providers. The sector now has clear rules.

Sources for every number in [docs/MERCADO.md](docs/MERCADO.md) (Portuguese).

## Live on devnet

The program (version 2, with the fixes from the [security review](docs/AUDITORIA.md)) runs on **Solana devnet**, and
the demo pool was set up with real transactions. Anyone can check them on Solana Explorer:

- **Program:** [`AgZtr464VxDFXuYnr3THUUa8Ww1jxBWJXEKQJEQc35XJ`](https://explorer.solana.com/address/AgZtr464VxDFXuYnr3THUUa8Ww1jxBWJXEKQJEQc35XJ?cluster=devnet)
- **Pool:** [`BM342uKMYgDQ2hWmhuXnC4JdHtmWAN3kprptRgRxC3pg`](https://explorer.solana.com/address/BM342uKMYgDQ2hWmhuXnC4JdHtmWAN3kprptRgRxC3pg?cluster=devnet)
- **Oracle** (its own key, separate from the admin): `HyU5mJweYbRU5wc8CCqXQ2VXBU5WGk1WYsyNFjCtzrwM`. Writes the
  median of agreeing price sources several times a day (scheduled on GitHub Actions, which often runs late; so on
  devnet the price stays valid for 24 h, and each update can move it at most 10%).

| Operation | Proof |
|---|---|
| Pool v2 created (R$ 5.0090 per dollar), only by the program's upgrade authority | [view transaction](https://explorer.solana.com/tx/5YPpYMHbND3mxSmcEreRXTLGB7AcFUUQj2wnXVFZE78rj7Qu4PXrRSKBkXpXEjGko4vviYpFVhfDupiCAkxsWx9o?cluster=devnet) |
| Limits: price valid 1 h (now 24 h), oracle moves up to 10% per update, deposits locked 10 min | [view transaction](https://explorer.solana.com/tx/5umpEub3GQfQ3WrNwdRW42QuLkHGGyWykPRf3AhhdxXuw9QyTs9xA2GHAbcgsLBJWbag3yV7GNfv124HzBcdaNbX?cluster=devnet) |
| Oracle with its own key (separate from the admin) | [view transaction](https://explorer.solana.com/tx/2oWCkWdCnmgxYpyF2gcR1GsPKfrWXRmmJQjLhqqUCScjaFLF9yipUJLN8TgQTcbC9Dx5NHCdWPeLdQHVVFfuursm?cluster=devnet) |
| Rende deposit: R$ 50,000 | [view transaction](https://explorer.solana.com/tx/5NXVEY8MQrssHC3N6sYhpuVF8ZszUBjbf6yCKbq9cQ9XTdMFQXEXPmPyt5vHc33qTss43YaTvN4pUnwNRYoXHuDc?cluster=devnet) |
| Rende deposit: US$ 10,000 | [view transaction](https://explorer.solana.com/tx/JfjXzvygnoWbFZ3ZnPyev6F6zWpwTQ3zfZ53Sf2uZrLa3JWA1Y5pmsBRQtuMaNAqWST7yzoJhvEpFNpuyrWDALX?cluster=devnet) |
| Baleia deposit: R$ 10,000 | [view transaction](https://explorer.solana.com/tx/YHB1JodEYje7AsCbUFqxaY2rdeEXG9Sa8uV9CxQSqkDBdM5mdK25JghhH1TuJUpT67nizPYZwKZRJGTx5ZwHsf5?cluster=devnet) |
| Baleia deposit: US$ 2,000 | [view transaction](https://explorer.solana.com/tx/4SRzNa47ps2oJz1hCUt1Nmn1ho4To9ER2NVp25TEEzoTWnxRHZWU6824Xb2BAGGo1WHEbyTMZnHxT3xEYVDEojKB?cluster=devnet) |
| Retail swap: R$ 1,000 → dollars (1% fee) | [view transaction](https://explorer.solana.com/tx/5Uv1y7AGCuvWgt3ur2MSUht2rWm3xDpdQWzXo7UsCtTuYUYwG13pZcnwGNpwQQdSdtXZy6j7Z98op2f7wtqP5eTt?cluster=devnet) |
| Depositor swap: R$ 1,000 → dollars (0.5% fee) | [view transaction](https://explorer.solana.com/tx/5Ajdt3f1UFP5BHjQJbhJiDQWZBp7VjUoYQ4g5vd3BZ2aU7XpW7xVFgzaY85dT5HmeQemXm92yBvEqtN6R9jcuHUW?cluster=devnet) |
| Partner app registered | [view transaction](https://explorer.solana.com/tx/Qb9whPf3LxnALJMmndT54nymcu8aunhGF6XzxtLtvLAro3dJ2XyjatqeG9BFuZsQSiUqQuxZyuG579LPWuw5swB?cluster=devnet) |
| B2B swap: US$ 200 → reais (0.4% fee) | [view transaction](https://explorer.solana.com/tx/5T7C894q7PnP4A3bXUJhDVz9HeJhsKK5gK8UekmHQHw8GVMJrCJfDh3Nxr2SeVnNr5oHfb5b71nTRLk1p7kBvyQc?cluster=devnet) |
| Depositor harvests fees (in both currencies) | [view transaction](https://explorer.solana.com/tx/BAkh9ewTFJ76xNiVxbzBQ9daGusoupGB3arzHanwZJWKG2xB61s1RCK8gFjVghLoZAL7ENUG6uRutvk9Xqq1wuh?cluster=devnet) |

Test tokens (cBRL and cUSD), with no real value. Full addresses in [`deployments/devnet.json`](deployments/devnet.json).

## The app really uses Solana (without the user noticing)

In the [demo](https://powerdeblack.github.io/cambi/), **“Criar minha conta grátis”** connects the app to the program on
devnet:

- **Invisible account:** the Solana account is created on the device itself. No seed phrase, no extension, no crypto
  needed. Crypto users can choose **“Prefiro usar minha Phantom”** (use my Phantom wallet).
- **Test money from the program itself:** an on-chain faucet gives R$ 1,000 in test tokens (cBRL), with rules on the
  blockchain (once per hour, only for low balances, global hourly cap). SOL for fees comes from Solana's public
  faucet. No privileged key lives in the app.
- **Everything is a real transaction:** swap, Rende deposit, fee harvest, withdrawal, Pix and dollar transfers. Every
  receipt links to the blockchain (**“ver na blockchain”**).
- **The preview is the program's math:** the app computes the swap with the same integer math as the program (a
  faithful port of `quote`), so the amount shown before confirming is the amount received, to the cent.

Checked automatically by the [end-to-end devnet workflow](../../actions/workflows/e2e-devnet.yml):

1. **The app's client against the real program:** new account → swap (receives exactly the preview) → Rende deposit
   → depositor swap (0.5%) → fee harvest (receives exactly the pending amount) → USDC transfer → Pix → withdrawal.
2. **The screens in a real browser:** creates the account, swaps, deposits and sends a Pix through the UI, waiting
   for each Solana receipt.

In production, the invisible account comes from an embedded wallet provider (sign in with email or Google, confirm
with biometrics) and a server pays network fees. No privileged key goes to the app.

## What's in this repository

| Folder | Contents | Status |
|---|---|---|
| [`programs/cambi_pool`](programs/cambi_pool) | Solana program in Rust/Anchor 0.31 | ✅ Builds for Solana (SBF) · 12 unit tests · security review |
| [`tests/`](tests) | Integration tests on a local Solana validator | ✅ 23 tests passing on [GitHub Actions](../../actions/workflows/solana.yml) |
| [`scripts/`](scripts) | Devnet pool setup, oracle and maintenance | ✅ [Deployed on devnet](#live-on-devnet) |
| [`app/`](app) | Web app (React + Vite + TypeScript), installable on phones | ✅ [Live](https://powerdeblack.github.io/cambi/) · 39 tests · real devnet transactions |
| [`sim/`](sim) | Economic simulation (Python) | ✅ |
| [`docs/`](docs) | [Architecture](docs/ARQUITETURA.md) · [Economics](docs/ECONOMIA.md) · [Market](docs/MERCADO.md) · [Brand](docs/MARCA.md) · [Validation](docs/VALIDACAO.md) · [Colosseum](docs/COLOSSEUM.md) (Portuguese) | ✅ |

### What the integration tests prove

Running the real program on a local Solana validator:

- Deposits in both tranches, with fee shares based on **value in reais** (dollar depositors also earn fees paid in
  reais)
- Retail fee (1%), **depositor discount (0.5%)** and **B2B fee (0.4%)**, each proven by on-chain accounts
- Someone else's position does not count for the discount
- Withdrawals return principal **and** accrued fees
- **Rende is senior:** Baleia cannot withdraw if it would leave Rende uncovered
- 20% of liquidity per swap, slippage protection
- **Emergency pause** blocks swaps and deposits, but **withdrawals stay open**
- Only the oracle changes the price; only the admin changes fees, and within limits
- Swaps are rejected with a stale price

## Run locally

```bash
# Web demo
cd app && npm install && npm run dev      # http://localhost:5173
npm test                                  # pool engine tests

# Program unit tests (no Solana CLI needed)
cargo test -p cambi_pool

# Integration tests (requires Solana CLI + Anchor 0.31)
npm install && anchor build && anchor keys sync && anchor test

# Economic simulation
python3 sim/cambi_sim.py
```

## Stack

Solana · Anchor 0.31 · SPL Token · React 18 · Vite · TypeScript · Mocha/Chai · Vitest · Playwright · GitHub Actions ·
Python

## Security

A full security review of the program, the app and the infrastructure, with each attack reproduced in a test:
[docs/AUDITORIA.md](docs/AUDITORIA.md) (Portuguese). It found 1 high and 4 medium issues; all are fixed. No external
audit yet. To report a vulnerability: [SECURITY.md](SECURITY.md).

- Rende is senior in both currencies; deposits have a withdrawal lockup and there is a per-minute outflow limit
- The oracle moves the price at most 10% per update, by consensus of several sources, with a key separate from the
  admin
- Only the program's upgrade authority creates pools; admin changes take two steps
- The test faucet exists only in the devnet build (CI checks that the production binary does not contain it)
- GitHub Actions pinned by commit hash, no fork code runs with access to keys, weekly dependency audit

## Built as if it were real: compliance

The app behaves as a regulated product would (hackathon version: test network, simulated partners). Full map of
Brazilian and international rules in [docs/CONFORMIDADE.md](docs/CONFORMIDADE.md) (Portuguese).

- **KYC (AML law 9.613 and Central Bank Circular 3.978):** identity check with a validated CPF, age, politically
  exposed person (PEP) and source of funds. Unverified accounts are limited per operation.
- **FX rules (Law 14.286 and Res. BCB 277):** every swap records its purpose; the effective total cost (VET) and
  estimated IOF tax are shown before confirming.
- **Investor profile (CVM Res. 30):** suitability questionnaire before the first Rende deposit, with a mismatch
  warning; Baleia is for qualified investors.
- **LGPD (Brazil's data protection law):** consent at sign-up, privacy policy, download and delete my data, nothing
  personal on-chain.
- **International:** FATF Travel Rule for wallet transfers from US$ 1,000, sanctions screening before sending,
  FATCA/CRS tax residency. PCI DSS and card network rules are listed for the future card.

## Regulation and risks

- **Decentralized inside, regulated at the door:** Pix on- and off-ramps must go through a provider authorized by
  Brazil's Central Bank (SPSAV). Since February 2026 (Res. BCB 519/520/521), trades with stablecoins pegged to a
  foreign currency are treated as foreign exchange.
- Returns for depositors are likely to be classed as an investment offering (CVM, Brazil's securities regulator);
  Baleia is designed for qualified investors.
- **Money in the pool is not covered by deposit insurance (FGC).**
- The program **has not been externally audited**. This is a hackathon version: do not use it with real money.
- Known limitations (oracle, Baleia mark-to-market, tokenized fixed income) in
  [docs/ARQUITETURA.md](docs/ARQUITETURA.md) (Portuguese).

## Hackathon

Built for the **Colosseum Crypto World's Fair** (submissions until Oct 13, 2026). All code was written during the
hackathon; there is no pre-existing work.

**Authorship:** solo founder, [@powerdeblack](https://github.com/powerdeblack), from São Paulo, Brazil. A product
designer building with AI: Claude Code for coding and Colosseum Copilot for research, both declared in the submission.
Product decisions are the founder's. Early commits show “Claude” as the author (the coding agent's default git
identity); later commits come from the founder's account.

## License

[MIT](LICENSE)
