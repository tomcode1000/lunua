---
name: lunua
description: "Stops Arc-specific money bugs before a contract ships. Use whenever writing, porting, reviewing or deploying a Solidity contract for Arc (chain 5042 / testnet 5042002), or when a user says a USDC payment on Arc 'failed' with no reason. Complements Circle's use-arc skill: use-arc teaches the chain; this skill enforces the contract-level rules and REQUIRES a passing `lunua check` before any deploy. Triggers: Arc, Arc mainnet, deploy to Arc, escrow/vault/pool on Arc, payment failed on Arc, USDC gas."
---

# Lunua

On Arc, USDC is **one balance with two doors**:
- **native door**: 18 decimals, `msg.value`, `address(x).balance`. Wallets (MetaMask, Rabby) use this door when a user presses "Send USDC".
- **ERC-20 door**: 6 decimals, `0x3600000000000000000000000000000000000000` (`transfer`, `approve`, `balanceOf`).

Code written for Ethereum assumes these are two different assets. That assumption causes real failures on Arc mainnet (Breadchain escrow, Oct 2026; DefiLlama double counting Uniswap v4 and Morpho, Sep 2026).

## Hard rule: the deploy gate

**Before ANY deploy to Arc (mainnet or testnet) you MUST run:**

```bash
npx lunua check --code out/<Contract>.sol/<Contract>.json   # before deploying
npx lunua check <deployed-address>                          # after deploying
```

- Exit code `1` = at least one FAIL. **Do not deploy.** Fix the code, rebuild, run again.
- Only deploy when the command exits `0`. Show the user the report.
- Never skip, silence or work around the gate. If you cannot run it, tell the user and stop.

## Rules for contracts on Arc

1. **Anything that holds USDC must decide what happens when a wallet sends it natively.**
   A contract with no `receive()` rejects a wallet "Send USDC" and the user sees a bare "Failed" while still paying gas. Either:
   - add a `receive()` that credits `msg.value / 1e12` as a 6-decimal USDC deposit (reject amounts that are not whole micro-USDC), or
   - ship a deposit page that calls the ERC-20 door (`transfer` or `approve` + `deposit`) and say clearly in the UI that direct wallet sends are not supported.
2. **Never add the two views.** `address(this).balance / 1e12 + USDC.balanceOf(address(this))` counts the same money twice. Read one view (prefer `USDC.balanceOf`).
3. **Convert at the boundary.** `msg.value` is 18 dp; ERC-20 amounts are 6 dp. Factor `1e12`. Never pass an 18-dp amount to `transfer`/`transferFrom`, or a 6-dp amount as `value`.
4. **`balanceOf == 0` is not "empty".** Amounts below 0.000001 USDC exist only in the native view.
5. **Allowances do not protect native paths.** `approve` limits `transferFrom` only. Every function that sends native value needs its own access control. A native "sweep" also moves users' ERC-20 USDC.
6. **No `block.prevrandao` / `block.difficulty` randomness.** It is always `0` on Arc. Use a VRF/oracle.
7. **`SELFDESTRUCT` moves all of the contract's USDC** to the beneficiary (it is the native balance).
8. **Sends to `address(0)` revert** and **sends to/from blocklisted addresses revert and still cost gas.** Handle `receipt.status === 0`.
9. **No wrapper.** Do not deploy WUSDC/WETH-style wrappers; use `0x3600…` directly. Do not alias the `0xEeee…EEeE` native sentinel to it.

## When a user says "my USDC payment on Arc failed"

Run `npx lunua tx <hash>`. It replays the transaction at its block, explains the cause in plain words and, for the common case (native send to an ERC-20-only contract), prints a corrected ERC-20 transaction that it has already simulated as succeeding. Offer that fix; never resend on the user's behalf without their confirmation.

## Sources
- Arc EVM differences: https://docs.arc.io/arc/references/evm-differences
- Porting checklist: https://docs.arc.io/arc/tutorials/porting-contracts-to-arc
- Circle use-arc skill (chain config, decimals for frontends): https://github.com/circlefin/skills
