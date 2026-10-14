// Arc Preflight engine. Runs in the browser and in Node 18+ (uses fetch only).
// Every check is either a live simulation against an Arc RPC (eth_call with a
// state override, so no real funds move) or a scan of the deployed bytecode.

export const ARC = {
  mainnet: { chainId: 5042, rpc: "https://rpc.mainnet.arc.io", explorer: "https://explorer.arc.io" },
  testnet: { chainId: 5042002, rpc: "https://rpc.testnet.arc.io", explorer: "https://explorer.testnet.arc.io" },
};
export const USDC = "0x3600000000000000000000000000000000000000";
const SCALE = 10n ** 12n; // native (18 dp) -> ERC-20 (6 dp)
const PROBE_FROM = "0x00000000000000000000000000000000a5c0ffee";
const DOCS = "https://docs.arc.io/arc/references/evm-differences";
const PORT = "https://docs.arc.io/arc/tutorials/porting-contracts-to-arc";

export function client(rpcUrl = ARC.mainnet.rpc) {
  let id = 0;
  return async (method, params = []) => {
    const r = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    const j = await r.json();
    if (j.error) { const e = new Error(j.error.message); e.rpc = j.error; throw e; }
    return j.result;
  };
}

const hex = (n) => "0x" + BigInt(n).toString(16);
const pad32 = (h) => h.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const transferData = (to, amount6) => "0xa9059cbb" + pad32(to) + pad32(hex(amount6));
export const fmtUsdc = (amount6) => {
  const s = BigInt(amount6).toString().padStart(7, "0");
  return `${s.slice(0, -6)}.${s.slice(-6)}`.replace(/\.?0+$/, "") || "0";
};

// Simulate a call; returns { ok, reason }.
async function simulate(rpc, call, block = "latest", fund = true, extra = null) {
  let override = fund ? { [call.from]: { balance: hex(10n ** 24n) } } : undefined;
  if (extra) override = { ...(override || {}), ...extra };
  try {
    await rpc("eth_call", override ? [call, block, override] : [call, block]);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: decodeRevert(e.rpc?.data) || e.message };
  }
}

function decodeRevert(data) {
  if (!data || !data.startsWith("0x08c379a0")) return null;
  const len = parseInt(data.slice(10 + 64, 10 + 128), 16);
  const bytes = data.slice(10 + 128, 10 + 128 + len * 2);
  let s = "";
  for (let i = 0; i < bytes.length; i += 2) s += String.fromCharCode(parseInt(bytes.slice(i, i + 2), 16));
  return s;
}

// Walk opcodes, skipping PUSH data and the trailing Solidity CBOR metadata.
export function scanBytecode(code) {
  const b = code.replace(/^0x/, "");
  let end = b.length / 2;
  if (end >= 2) {
    const metaLen = parseInt(b.slice(-4), 16);
    if (metaLen + 2 < end) end -= metaLen + 2;
  }
  const found = { SELFDESTRUCT: false, PREVRANDAO: false, BALANCE: false, SELFBALANCE: false, CALLVALUE: false, pushesUSDC: false };
  // solc emits 0x3600..00 as PUSH20, or optimized as PUSH a, PUSH b, SHL (a << b).
  const USDC_N = BigInt(USDC);
  const last = []; // last two pushed values, reset by any other opcode
  for (let i = 0; i < end; i++) {
    const op = parseInt(b.slice(i * 2, i * 2 + 2), 16);
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x5f;
      const v = BigInt("0x" + (b.slice(i * 2 + 2, i * 2 + 2 + n * 2) || "0"));
      if (v === USDC_N) found.pushesUSDC = true;
      last.push(v); if (last.length > 2) last.shift();
      i += n;
      continue;
    }
    // SHL pops shift (top = last pushed) then value: PUSH value, PUSH shift, SHL.
    if (op === 0x1b && last.length === 2 && last[1] < 256n && ((last[0] << last[1]) & ((1n << 256n) - 1n)) === USDC_N) found.pushesUSDC = true;
    last.length = 0;
    if (op === 0xff) found.SELFDESTRUCT = true;
    else if (op === 0x44) found.PREVRANDAO = true;
    else if (op === 0x31) found.BALANCE = true;
    else if (op === 0x47) found.SELFBALANCE = true;
    else if (op === 0x34) found.CALLVALUE = true;
  }
  return found;
}

// Full contract check. Returns { address, isContract, checks: [{id, status, title, detail, fix, docs}] }
// status: "pass" | "fail" | "warn" | "info"
// Pass { code } (deployed/runtime bytecode) to check a contract BEFORE it is deployed:
// it is simulated at `address` via a state override.
export async function checkContract(address, { rpc = client(), code: codeOverride = null } = {}) {
  address = (address || "0x00000000000000000000000000000000c0dec0de").toLowerCase();
  const extra = codeOverride ? { [address]: { code: codeOverride } } : null;
  const code = codeOverride || await rpc("eth_getCode", [address, "latest"]);
  if (!code || code === "0x") {
    return { address, isContract: false, checks: [{ id: "eoa", status: "info", title: "This is a wallet, not a contract",
      detail: "Wallets (EOAs) accept both native and ERC-20 USDC. Nothing to check.", fix: null, docs: null }] };
  }
  const checks = [];
  const scan = scanBytecode(code);

  // 1. Plain wallet "Send USDC" (native, empty calldata) - the Breadchain case.
  const native = await simulate(rpc, { from: PROBE_FROM, to: address, value: hex(10n ** 18n), data: "0x" }, "latest", true, extra);
  const erc20 = await simulate(rpc, { from: PROBE_FROM, to: USDC, data: transferData(address, 1_000_000n) }, "latest", true, extra);
  checks.push(native.ok
    ? { id: "native-receive", status: "pass", title: "Accepts a plain wallet \"Send USDC\"",
        detail: "MetaMask/Rabby send USDC on Arc as native value. A 1 USDC native send to this contract succeeds.", fix: null, docs: DOCS }
    : !scan.pushesUSDC
    ? { id: "native-receive", status: "info", title: "Rejects native USDC sends (does not handle USDC)",
        detail: "This contract never references USDC, so refusing a wallet send is expected. If it should hold money, add receive().", fix: null, docs: DOCS }
    : { id: "native-receive", status: "fail", title: "Wallet \"Send USDC\" will FAIL",
        detail: `A 1 USDC native send (what MetaMask/Rabby do by default on Arc) reverts${native.reason && native.reason !== "execution reverted" ? `: "${native.reason}"` : " with no reason"}. `
          + (erc20.ok ? "The ERC-20 route (transfer on 0x3600…) works, so users who send from a normal wallet lose gas and see a bare \"Failed\"." : ""),
        fix: "Either tell users to send through the ERC-20 interface (a deposit page that calls transfer/approve+deposit), or add a receive() that credits native value as USDC (Arc-only).",
        docs: PORT });

  // 2. Sub-micro dust: native accepts it, ERC-20 view can't see it.
  if (native.ok) {
    const dust = await simulate(rpc, { from: PROBE_FROM, to: address, value: hex(5n * 10n ** 11n), data: "0x" }, "latest", true, extra);
    if (dust.ok) checks.push({ id: "dust", status: "warn", title: "Accepts dust the ERC-20 view can't see",
      detail: "A 0.0000005 USDC native send succeeds, but balanceOf() truncates it to 0. Any 'balanceOf == 0' emptiness check is wrong.",
      fix: "Never treat USDC.balanceOf(x) == 0 as 'x holds nothing'; compare address(x).balance if exactness matters.", docs: DOCS });
  }

  // 3. Reads both balance views -> double counting risk.
  if ((scan.BALANCE || scan.SELFBALANCE) && scan.pushesUSDC) checks.push({ id: "two-views", status: "warn",
    title: "Reads BOTH the native balance and USDC 0x3600… (double-count risk)",
    detail: "The bytecode reads a native balance (BALANCE/SELFBALANCE) and also references the USDC contract. On Arc these are the same money; adding them double-counts (DefiLlama hit this on Uniswap v4 and Morpho).",
    fix: "Use one view only. Divide native by 1e12 before comparing to ERC-20 amounts.", docs: DOCS });
  else checks.push({ id: "two-views", status: "pass", title: "Does not mix the two balance views", detail: "No sign of reading native and ERC-20 USDC balances together.", fix: null, docs: DOCS });

  // 5. SELFDESTRUCT
  checks.push(scan.SELFDESTRUCT
    ? { id: "selfdestruct", status: "warn", title: "Contains SELFDESTRUCT",
        detail: "On Arc a contract's USDC IS its native balance, so SELFDESTRUCT sends all of it to the beneficiary (on Ethereum the ERC-20 USDC would stay put).",
        fix: "Remove SELFDESTRUCT or make sure the beneficiary is meant to receive all held USDC.", docs: DOCS }
    : { id: "selfdestruct", status: "pass", title: "No SELFDESTRUCT", detail: "", fix: null, docs: DOCS });

  // 6. PREVRANDAO
  checks.push(scan.PREVRANDAO
    ? { id: "prevrandao", status: "fail", title: "Uses block.prevrandao: it is ALWAYS 0 on Arc",
        detail: "Any lottery, shuffle or random pick built on prevrandao/difficulty returns the same result every time.",
        fix: "Use a VRF / randomness oracle instead.", docs: PORT }
    : { id: "prevrandao", status: "pass", title: "No block.prevrandao randomness", detail: "", fix: null, docs: PORT });

  return { address, isContract: true, codeSize: (code.length - 2) / 2, checks };
}

// Explain a failed transaction in plain words and, where possible, build a fixed one.
export async function diagnoseTx(hash, { rpc = client() } = {}) {
  const tx = await rpc("eth_getTransactionByHash", [hash]);
  if (!tx) return { found: false };
  const rc = await rpc("eth_getTransactionReceipt", [hash]);
  const value = BigInt(tx.value || 0);
  const out = { found: true, hash, from: tx.from, to: tx.to, value18: value.toString(), amount: fmtUsdc(value / SCALE),
    status: rc ? (rc.status === "0x1" ? "success" : "failed") : "pending", block: tx.blockNumber };
  if (out.status !== "failed") { out.cause = out.status === "success" ? "This transaction succeeded." : "Still pending."; return out; }

  const prev = hex(BigInt(tx.blockNumber) - 1n);
  if (!tx.to) { out.cause = "A contract deployment failed."; return out; }
  if (/^0x0{40}$/i.test(tx.to)) {
    out.kind = "zero-address";
    out.cause = "You sent USDC to the zero address. On Arc this always reverts (on Ethereum it would burn the money). Your USDC is safe; only gas was used.";
    return out;
  }
  const code = await rpc("eth_getCode", [tx.to, tx.blockNumber]);
  const isContract = code && code !== "0x";
  const replay = await simulate(rpc, { from: tx.from, to: tx.to, value: tx.value, data: tx.input }, prev, false);
  out.revertReason = replay.reason || null;

  if (isContract && value > 0n && (tx.input === "0x" || !tx.input)) {
    const alt = await simulate(rpc, { from: tx.from, to: USDC, data: transferData(tx.to, value / SCALE) }, prev, false);
    out.kind = "native-to-erc20-only-contract";
    out.cause = `Your wallet sent ${out.amount} USDC the native way (like sending gas money). The contract you sent it to only accepts USDC through the token interface (0x3600…), so it rejected the payment. Your ${out.amount} USDC never left your wallet; you only paid gas.`;
    // Does the target track deposits through a function (e.g. deposit(uint256) = 0xb6b55f25)?
    // Then a plain transfer would deliver the USDC without crediting the sender.
    const hasDeposit = code.toLowerCase().includes("63b6b55f25");
    const amt6 = value / SCALE;
    out.caution = hasDeposit
      ? "This contract records deposits through its own deposit() function, so a plain token transfer would deliver the USDC but NOT credit it to you. The fix below uses the token interface in two steps: approve, then deposit."
      : "A token transfer delivers the USDC to this contract. If the app keeps its own record of who paid (an order or deposit ID), use the app's payment button instead so you get credited.";
    if (hasDeposit) {
      out.fix = { steps: [
          { to: USDC, data: "0x095ea7b3" + pad32(tx.to) + pad32(hex(amt6)), value: "0x0", label: `Approve ${fmtUsdc(amt6)} USDC for the contract` },
          { to: tx.to, data: "0xb6b55f25" + pad32(hex(amt6)), value: "0x0", label: `Deposit ${fmtUsdc(amt6)} USDC` } ],
        label: `Approve, then deposit ${fmtUsdc(amt6)} USDC through the token interface` };
      out.fixVerified = false; // step 2 depends on step 1, so it cannot be pre-simulated in one eth_call
    } else if (alt.ok) {
      out.fix = { steps: [{ to: USDC, data: transferData(tx.to, amt6), value: "0x0", label: "Transfer" }],
        label: `Send ${out.amount} USDC to the same address through the token interface` };
      out.fixVerified = true; // simulated at the original block: succeeds
    }
    return out;
  }
  if (value > 0n) {
    // A native transfer that failed despite balance: blocklist is the documented cause.
    out.kind = "value-transfer-reverted";
    out.cause = `A native USDC transfer was rejected${out.revertReason ? `: "${out.revertReason}"` : ""}. On Arc this usually means the sender or receiver is on the USDC blocklist, which reverts and still charges gas.`;
    return out;
  }
  out.kind = "contract-revert";
  out.cause = `The contract rejected the call${out.revertReason ? `: "${out.revertReason}"` : " without giving a reason"}. This is the app's own rule, not an Arc quirk.`;
  return out;
}
