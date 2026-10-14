# Lunua

**The safety layer for USDC payments on Arc.**

Today: pre-deploy detection of Arc's native/ERC-20 USDC defects, failed-payment forensics, and a deploy gate for CI and AI agents, live on mainnet. Next: chain-wide attestation and a wallet guard that checks a payment before it is signed ([roadmap](https://lunua.vercel.app/roadmap)).

**Live scanner: https://lunua.vercel.app** · e.g. [a real mainnet failure](https://lunua.vercel.app/?tx=0xc2c6412823f3fbb5c6295aa5ddbaeaa779dc9fd1a0e20e6ef0a3920d671bb793) · [a blocked contract](https://lunua.vercel.app/?address=0xA8Bd8C8F580d5f00cEF41bfA524555de17E3B38F)

**Catch Arc's "one balance, two doors" USDC bugs before launch, and tell users in plain words why their payment failed.**

On Arc, USDC is a single balance you can reach through two doors:

| Door | Decimals | Used by |
|---|---|---|
| Native (`msg.value`, `address.balance`) | 18 | MetaMask / Rabby "Send USDC", gas |
| ERC-20 at `0x3600000000000000000000000000000000000000` | 6 | `transfer`, `approve`, `balanceOf` |

Contracts copied from Ethereum treat these as two assets. The wallet shows a bare **"Failed"** with no reason given, so users don't report anything; they just leave.

## This is happening on mainnet now

| Who | What | Link |
|---|---|---|
| Breadchain / KambioX | 4 USDC wallet send to their escrow reverted on Arc mainnet, 2 Oct 2026. Still open. | [issue #48](https://github.com/BreadchainCoop/curacao-crypto-onramp-bot/issues/48), tx [`0xc2c6…b793`](https://explorer.arc.io/tx/0xc2c6412823f3fbb5c6295aa5ddbaeaa779dc9fd1a0e20e6ef0a3920d671bb793) |
| DefiLlama | Counted Arc USDC twice (native + ERC-20): Arc TVL shown as ~$10.5M vs ~$6.3M | [PR #21274](https://github.com/DefiLlama/DefiLlama-Adapters/pull/21274), [PR #21279](https://github.com/DefiLlama/DefiLlama-Adapters/pull/21279) |
| Circle arc-node docs | Example sent 1e-12 USDC instead of 1 USDC | [arc-node #453](https://github.com/circlefin/arc-node/issues/453), [#91](https://github.com/circlefin/arc-node/issues/91) |
| Layerswap, Pinax | Code changes to support native decimals | [layerswap #2175](https://github.com/layerswap/layerswapapp/pull/2175), [pinax #130](https://github.com/pinax-network/substreams-evm-extended/issues/130) |

Circle documents these rules (EVM differences, porting guide) as a **manual checklist**, and Circle's `use-arc` AI skill covers decimals and double counting for frontends. Nothing **runs** the checks or **blocks a deploy**, and nothing helps the user whose payment failed. That's the gap.

## Every finding is a reproducible case

| Field | What Lunua returns |
|---|---|
| Trigger | The exact call simulated, pinned to a block |
| Expected / Actual | What should happen vs what Arc mainnet actually did |
| Impact | Stated from what was demonstrated (e.g. "availability: deposits revert, sender pays gas, no funds lost") |
| Proof | Raw JSON-RPC request + response for every simulation, with a `curl` to re-run it yourself |
| Next step | A Foundry test pinned to the same fork block (`lunua … --repro test/`) |

**Severity policy:** severity is assigned only from demonstrated impact. Findings inferred from bytecode alone are reported as **Unconfirmed** signals and never block a deploy. Live proofs include a 7-byte PREVRANDAO probe (returns 0 on Arc mainnet) and a `balanceOf` truncation probe with a control.

**Verified:** the generated reproductions for PortedVault and the Breadchain tx pass on an Arc mainnet fork: `arc-forge test --network arc`, 6 passed / 0 failed (`scripts/verify-repro.sh`). The LUN-02 test is a template: fill in the target's accounting getter to confirm or refute the signal.

## What it does

### 1. "Why did my payment fail?" (for users)
Paste a failed tx hash. Lunua replays it **at its original block** on Arc mainnet and explains it:

```
$ lunua tx 0xc2c6412823f3fbb5c6295aa5ddbaeaa779dc9fd1a0e20e6ef0a3920d671bb793
status: failed   amount 4 USDC
Your wallet sent 4 USDC the native way (like sending gas money). The contract you sent it to
only accepts USDC through the token interface (0x3600…), so it rejected the payment.
Your 4 USDC never left your wallet; you only paid gas.
```

It then builds the corrected transaction using the token interface: a `transfer`, or `approve` + `deposit` when the contract tracks deposits, so the user is actually credited. The web page sends it from the user's own wallet after they confirm. It also explains zero-address and blocklist reverts.

### 2. "Check my contract" (for builders), before OR after deploy
```
$ npx -y github:tomcode1000/lunua check --code out/PortedVault.sol/PortedVault.json
BLOCK   LUN-01  [Medium] Wallet-initiated USDC deposits revert
         actual: revert, empty returndata. The same amount through transfer() on 0x3600… succeeds.
SIGNAL  LUN-02  [Unconfirmed] Native balance and ERC-20 USDC read in the same contract
         actual: BALANCE/SELFBALANCE at pc 0x018b; 0x3600… at pc 0x00d6, 0x0138, …
SIGNAL  LUN-05  [Unconfirmed] Reads block.prevrandao, which is constant on Arc
         actual: probe returns 0x00…00: PREVRANDAO is constant 0 on Arc mainnet
PASS    LUN-04  No SELFDESTRUCT
1 demonstrated blocking finding(s). Do not deploy.                  (exit code 1)
```

| Check | How |
|---|---|
| Wallet "Send USDC" accepted? | Live `eth_call` on Arc mainnet with a state override (fake balance; with `--code`, fake code too). No funds move. |
| Dust the ERC-20 view can't see | Live simulation of a 0.0000005 USDC native send |
| Reads both balance views (double count) | Bytecode scan: `BALANCE`/`SELFBALANCE` plus the USDC address (also detects solc's optimized `PUSH a, PUSH b, SHL` encoding of `0x3600…`) |
| `SELFDESTRUCT` (moves all USDC on Arc) | Bytecode scan, skipping PUSH data and CBOR metadata |
| `block.prevrandao` (always 0 on Arc) | Bytecode scan |

Contracts that never touch USDC are not failed for rejecting native sends (shown as INFO).

### 3. The deploy gate for AI coding agents
`skill/lunua/SKILL.md` is a skill for Claude Code, Cursor and other agents. It teaches the contract-level rules Circle's `use-arc` skill doesn't cover (`receive()`, allowances vs native paths, sweeps, `prevrandao`, `SELFDESTRUCT`, zero-address and blocklist reverts) and **requires** `lunua check` to exit 0 before any deploy. A vibe-coded escrow gets caught before it ships, not after users lose gas.

The same exit code works as a CI step: run `lunua check --code <artifact>` in GitHub Actions to block a merge.

### 4. On-chain registry
`PreflightRegistry` stores results pinned to the target's **code hash**, so a result goes stale automatically if the code changes. Wallets and apps can call `status(attester, target)` before letting a user send.

## Live on Arc mainnet (chain 5042)

| Contract | Address |
|---|---|
| PreflightRegistry (Lunua registry) | [`0x966Bf58DB6F257C63Edb11bF006B5eB3160721DE`](https://explorer.arc.io/address/0x966Bf58DB6F257C63Edb11bF006B5eB3160721DE) |
| PortedVault (demo: written the Ethereum way) | [`0xA8Bd8C8F580d5f00cEF41bfA524555de17E3B38F`](https://explorer.arc.io/address/0xA8Bd8C8F580d5f00cEF41bfA524555de17E3B38F) |
| ArcVault (demo: fixed after the report) | [`0x8f7349Dc451DFbC6B3773b49e33fa836b89C71f3`](https://explorer.arc.io/address/0x8f7349Dc451DFbC6B3773b49e33fa836b89C71f3) |

Demo transactions (the same 0.01 USDC wallet-style native send):
- to PortedVault: **reverted** [`0x44e0…6fb6`](https://explorer.arc.io/tx/0x44e05db307b73dded0a2bc78feb80cdc40393d50fc96a8747cd27eac73596fb6)
- to ArcVault: **succeeded** [`0x5e89…80da`](https://explorer.arc.io/tx/0x5e89958bcee21ac7d68b3086412ec69b34d2f8eafbc5898c389850c8b0c680da)

Registry attestations (written at deploy time, before the demonstrated-impact policy): PortedVault failMask 33 / warnMask 4, ArcVault pass. Under the current policy PortedVault has 1 demonstrated blocking finding (LUN-01) and 2 unconfirmed signals.

## Run it

```bash
npx -y github:tomcode1000/lunua tx <hash>          # failed-payment forensics (no install)
node bin/lunua.mjs tx <hash>              # explain a failed payment
node bin/lunua.mjs check <address>        # check a deployed contract
node bin/lunua.mjs check --code <file.json|0xruntimehex>   # before deploying
```
Node 18+, no dependencies (the engine only uses `fetch`). The web page (`docs/`, deployed on Vercel at lunua.vercel.app) is static and calls the Arc RPC straight from the browser, so it needs no server.

Contracts: `contracts/src/`. Build with `node scripts/compile.cjs` (solc 0.8.30).

## Limits (stated honestly)
- Without source code, the double-count check is a **warning** that the bytecode reads both views, not proof of a bug.
- The checker covers the documented Arc traps listed above. It does not prove a contract is safe in general.
- The two-step approve + deposit fix can't be pre-simulated in one `eth_call`, because step 2 depends on step 1. The single-transfer fix is simulated at the original block.



## Where Lunua goes next

Lunua is one engine applied at every point a USDC payment can go wrong on Arc: when code is written, when it ships, across the chain, and at the moment a user signs. Each phase reuses the same engine.

| Phase | What ships | How we know it worked |
|---|---|---|
| **Now: live** | Scanner, transaction forensics, CLI deploy gate, AI-agent skill, PreflightRegistry on mainnet | Live on Arc mainnet; Foundry reproductions pass on a fork |
| **Next: in the pipeline** | GitHub Action (one line in CI); Arc Studio and agent integration; outreach to teams already affected (e.g. Breadchain #48) | External teams running Lunua in CI |
| **Then: across the chain** | Watcher that analyses every new Arc contract and writes results to the registry; public dashboard | Share of new contracts analysed; explorers and wallets reading `status()` |
| **Then: at the wallet** | Wallet guard (MetaMask Snap transaction insight): simulates a send before signing and offers the ERC-20 rail | Failed native sends prevented for end users |
| **Ongoing: with Arc** | New detectors as Arc adds features: opt-in privacy, Memo / Multicall3From sender attribution, EURC and StableFX flows, blocklist handling | Coverage of Arc's documented EVM differences |

**Sustainability:** the public scanner, registry and wallet guard stay free. Teams pay for private-repo CI, private reports and pre-audit screening. Lunua is a natural candidate for the Circle Grant Program after the microgrant.

**What a microgrant funds:** RPC capacity for the chain-wide watcher, gas for registry attestations, and hosting.

## Sources
[Arc EVM differences](https://docs.arc.io/arc/references/evm-differences) · [Porting contracts to Arc](https://docs.arc.io/arc/tutorials/porting-contracts-to-arc) · [Stablecoin native model](https://docs.arc.io/arc/concepts/stablecoin-native-model) · [Circle skills](https://github.com/circlefin/skills)

MIT licence.
