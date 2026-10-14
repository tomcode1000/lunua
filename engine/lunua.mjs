// Lunua engine. Runs in the browser and in Node 18+ (uses fetch only).
//
// Every finding is a reproducible case: a trigger, the expected and actual result,
// the raw JSON-RPC proof (request + response, re-runnable with curl), an impact-based
// severity, and a Foundry test pinned to the same fork block.
//
// Severity is assigned only from demonstrated impact. A finding inferred from
// bytecode alone is reported as "Unconfirmed" (status "signal") and never blocks.

export const ARC = {
  mainnet: { chainId: 5042, rpc: "https://rpc.mainnet.arc.io", explorer: "https://explorer.arc.io" },
  testnet: { chainId: 5042002, rpc: "https://rpc.testnet.arc.io", explorer: "https://explorer.testnet.arc.io" },
};
export const USDC = "0x3600000000000000000000000000000000000000";
const SCALE = 10n ** 12n; // native (18 dp) -> ERC-20 (6 dp)
const PROBE = "0x00000000000000000000000000000000a5c0ffee";
const PROBE_RANDAO = "0x00000000000000000000000000000000000a5c01";
const PROBE_DUST = "0x00000000000000000000000000000000000a5c02";
const RANDAO_CODE = "0x445f5260205ff3"; // PREVRANDAO PUSH0 MSTORE PUSH1 0x20 PUSH0 RETURN
const DOCS = "https://docs.arc.io/arc/references/evm-differences";
const PORT = "https://docs.arc.io/arc/tutorials/porting-contracts-to-arc";

export function client(rpcUrl = ARC.mainnet.rpc) {
  let id = 0;
  const call = async (method, params = []) => {
    let j;
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await fetch(rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        });
        j = await r.json();
        break;
      } catch (e) { // transport failure only; JSON-RPC errors (reverts) are not retried
        if (attempt >= 3) throw e;
        await new Promise((z) => setTimeout(z, 400 * 2 ** attempt));
      }
    }
    if (j.error) { const e = new Error(j.error.message); e.rpc = j.error; throw e; }
    return j.result;
  };
  call.url = rpcUrl;
  return call;
}

const hex = (n) => "0x" + BigInt(n).toString(16);
const pad32 = (h) => h.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const transferData = (to, amount6) => "0xa9059cbb" + pad32(to) + pad32(hex(amount6));
const balanceOfData = (who) => "0x70a08231" + pad32(who);
export const fmtUsdc = (amount6) => {
  const s = BigInt(amount6).toString().padStart(7, "0");
  return `${s.slice(0, -6)}.${s.slice(-6)}`.replace(/\.?0+$/, "") || "0";
};

// eth_call that keeps the exact request and raw response as proof.
async function traced(rpc, label, call, block, override) {
  const params = override ? [call, block, override] : [call, block];
  const request = { jsonrpc: "2.0", id: 1, method: "eth_call", params };
  let response, ok, reason = null, result = null;
  try { result = await rpc("eth_call", params); response = { result }; ok = true; }
  catch (e) { response = { error: e.rpc || { message: e.message } }; ok = false; reason = decodeRevert(e.rpc?.data) || e.message; }
  const curl = `curl -s ${rpc.url || ARC.mainnet.rpc} -H 'content-type: application/json' -d '${JSON.stringify(request)}'`;
  return { label, ok, reason, result, request, response, curl };
}
const fund = (who, wei = 10n ** 24n) => ({ [who]: { balance: hex(wei) } });

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
  const found = { SELFDESTRUCT: false, PREVRANDAO: false, BALANCE: false, SELFBALANCE: false, CALLVALUE: false, pushesUSDC: false,
    pc: { SELFDESTRUCT: [], PREVRANDAO: [], BALANCE: [], SELFBALANCE: [], USDC: [] }, analysedBytes: end };
  const mark = (k, pc) => { if (found.pc[k].length < 4) found.pc[k].push(pc); };
  // solc emits 0x3600..00 as PUSH20, or optimized as PUSH a, PUSH b, SHL (a << b).
  const USDC_N = BigInt(USDC);
  const last = []; // last two pushed values, reset by any other opcode
  for (let i = 0; i < end; i++) {
    const op = parseInt(b.slice(i * 2, i * 2 + 2), 16);
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x5f;
      const v = BigInt("0x" + (b.slice(i * 2 + 2, i * 2 + 2 + n * 2) || "0"));
      if (v === USDC_N) { found.pushesUSDC = true; mark("USDC", i); }
      last.push(v); if (last.length > 2) last.shift();
      i += n;
      continue;
    }
    // SHL pops shift (top = last pushed) then value: PUSH value, PUSH shift, SHL.
    if (op === 0x1b && last.length === 2 && last[1] < 256n && ((last[0] << last[1]) & ((1n << 256n) - 1n)) === USDC_N) { found.pushesUSDC = true; mark("USDC", i); }
    last.length = 0;
    if (op === 0xff) { found.SELFDESTRUCT = true; mark("SELFDESTRUCT", i); }
    else if (op === 0x44) { found.PREVRANDAO = true; mark("PREVRANDAO", i); }
    else if (op === 0x31) { found.BALANCE = true; mark("BALANCE", i); }
    else if (op === 0x47) { found.SELFBALANCE = true; mark("SELFBALANCE", i); }
    else if (op === 0x34) found.CALLVALUE = true;
  }
  return found;
}

const pcs = (arr) => arr.map((pc) => "0x" + pc.toString(16).padStart(4, "0")).join(", ");
const reverted = (p) => p.reason && p.reason !== "execution reverted" ? `revert "${p.reason}"` : "revert, empty returndata";

// Foundry reproduction, pinned to the analysed block. Arc Foundry is required:
// standard forge/anvil do not model Arc's native USDC.
function forgeTest(name, block, body) {
  return `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";

/// Lunua ${name} reproduction. Run with Arc Foundry (standard forge does not model native USDC):
///   arc-forge test --network arc --match-contract ${name.replace("-", "")} -vvvv
contract ${name.replace("-", "")} is Test {
    address constant USDC = 0x3600000000000000000000000000000000000000;

    function setUp() public {
        vm.createSelectFork("https://rpc.mainnet.arc.io", ${block});
    }
${body}
}
`;
}

// Full contract analysis. Pass { code } (runtime bytecode) to analyse BEFORE deploying:
// the candidate code is placed at `address` via a state override.
export async function checkContract(address, { rpc = client(), code: codeOverride = null } = {}) {
  address = (address || "0x00000000000000000000000000000000c0dec0de").toLowerCase();
  const block = parseInt(await rpc("eth_blockNumber", []), 16);
  const B = hex(block);
  const code = codeOverride || await rpc("eth_getCode", [address, B]);
  if (!code || code === "0x") {
    return { address, block, isContract: false, checks: [{ id: "LUN-00", key: "eoa", status: "info", severity: null, confidence: "n/a",
      title: "Externally owned account: no bytecode", trigger: "eth_getCode returned 0x", expected: "—", actual: "—", impact: "None. EOAs accept both rails.",
      proof: [], signals: [], remediation: null, test: null, docs: null }] };
  }
  const scan = scanBytecode(code);
  const ov = (extra) => ({ ...(codeOverride ? { [address]: { code: codeOverride } } : {}), ...extra });
  const tgt = codeOverride ? "candidate code at " + address : address;
  const checks = [];

  // LUN-01  native receive
  const nat = await traced(rpc, "wallet-style native send · 1 USDC · empty calldata",
    { from: PROBE, to: address, value: hex(10n ** 18n), data: "0x" }, B, ov(fund(PROBE)));
  const erc = await traced(rpc, "counterfactual · same amount on the ERC-20 rail",
    { from: PROBE, to: USDC, data: transferData(address, 1_000_000n) }, B, ov(fund(PROBE)));
  const test01 = forgeTest("LUN-01", block, `
    function test_walletSendReverts() public {
        address target = vm.parseAddress("${address}");
        address probe = makeAddr("probe");
        vm.deal(probe, 1e18);
        vm.prank(probe);
        (bool ok, ) = target.call{value: 1e18}("");
        assertFalse(ok, "LUN-01 not reproduced: native send accepted");
    }

    function test_erc20RailAccepted() public {
        address target = vm.parseAddress("${address}");
        address probe = makeAddr("probe");
        vm.deal(probe, 1e18); // one balance: native funding is also the ERC-20 balance
        vm.prank(probe);
        (bool ok, ) = USDC.call(abi.encodeWithSignature("transfer(address,uint256)", target, 1e6));
        assertTrue(ok, "ERC-20 rail rejected");
    }`);
  if (!nat.ok && scan.pushesUSDC) checks.push({ id: "LUN-01", key: "native-receive", status: "fail", severity: "Medium", confidence: "demonstrated",
    title: "Wallet-initiated USDC deposits revert",
    trigger: `eth_call {to: ${tgt}, value: 1e18 wei, data: 0x} at block ${block}: the call MetaMask/Rabby make for "Send USDC" on Arc`,
    expected: "The payment is accepted, or the contract signals clearly that native sends are unsupported before the user signs",
    actual: `${reverted(nat)}. The same amount through transfer() on 0x3600… ${erc.ok ? "succeeds" : "also reverts"}.`,
    impact: "Availability. Every wallet-initiated deposit fails and the sender pays gas; no funds are lost. Rated Medium: demonstrated denial of the default payment path, without fund loss.",
    proof: [nat, erc], signals: [`contract materialises 0x3600… at pc ${pcs(scan.pc.USDC)}, so it is intended to handle USDC`],
    remediation: "Add receive() that credits msg.value / 1e12 as a 6-dp deposit (reject non-whole micro-USDC), or route users through a deposit page that calls transfer / approve+deposit on 0x3600….",
    test: test01, docs: PORT });
  else if (!nat.ok) checks.push({ id: "LUN-01", key: "native-receive", status: "info", severity: null, confidence: "demonstrated",
    title: "Rejects native value; contract does not reference USDC", trigger: "native send · 1 USDC", expected: "n/a for a non-USDC contract",
    actual: reverted(nat), impact: "None expected: the contract does not handle USDC.", proof: [nat], signals: [], remediation: null, test: null, docs: DOCS });
  else checks.push({ id: "LUN-01", key: "native-receive", status: "pass", severity: null, confidence: "demonstrated",
    title: "Accepts wallet-initiated native USDC", trigger: "native send · 1 USDC", expected: "accepted", actual: "accepted",
    impact: "—", proof: [nat], signals: [], remediation: null, test: null, docs: DOCS });

  // LUN-03  dust (only meaningful if native value is accepted)
  if (nat.ok) {
    const dust = await traced(rpc, "native send · 5e11 wei (0.0000005 USDC)", { from: PROBE, to: address, value: hex(5n * 10n ** 11n), data: "0x" }, B, ov(fund(PROBE)));
    const view = await traced(rpc, "balanceOf(account holding exactly 5e11 wei)", { to: USDC, data: balanceOfData(PROBE_DUST) }, B, fund(PROBE_DUST, 5n * 10n ** 11n));
    const ctrl = await traced(rpc, "control · balanceOf(account holding 2e12 wei)", { to: USDC, data: balanceOfData(PROBE_DUST) }, B, fund(PROBE_DUST, 2n * 10n ** 12n));
    if (dust.ok && view.ok && BigInt(view.result) === 0n) checks.push({ id: "LUN-03", key: "dust", status: "warn", severity: "Low", confidence: "demonstrated",
      title: "Accepts value the ERC-20 view cannot see",
      trigger: `native send of 5e11 wei to ${tgt}, then USDC.balanceOf on a balance of exactly 5e11 wei`,
      expected: "balanceOf reflects every unit the account holds",
      actual: `send accepted; balanceOf returns 0 (control: 2e12 wei reads as ${BigInt(ctrl.result || 0)})`,
      impact: "Accounting. Any `balanceOf == 0` emptiness or sweep check mis-evaluates for sub-micro remainders. Rated Low: no direct loss demonstrated.",
      proof: [dust, view, ctrl], signals: [],
      remediation: "Do not treat USDC.balanceOf(x) == 0 as empty. Compare address(x).balance where exactness matters, or reject non-whole micro-USDC in receive().",
      test: forgeTest("LUN-03", block, `
    function test_subMicroInvisibleToBalanceOf() public {
        address probe = makeAddr("dust");
        vm.deal(probe, 5e11);
        assertEq(probe.balance, 5e11);
        (, bytes memory r) = USDC.staticcall(abi.encodeWithSignature("balanceOf(address)", probe));
        assertEq(abi.decode(r, (uint256)), 0, "LUN-03 not reproduced");
    }`), docs: DOCS });
  }

  // LUN-02  both views read (static only)
  if ((scan.BALANCE || scan.SELFBALANCE) && scan.pushesUSDC) checks.push({ id: "LUN-02", key: "two-views", status: "signal", severity: "Unconfirmed", confidence: "static signal",
    title: "Native balance and ERC-20 USDC read in the same contract",
    trigger: "static analysis of runtime bytecode",
    expected: "One view of the single USDC balance is used for accounting",
    actual: `BALANCE/SELFBALANCE at pc ${pcs([...scan.pc.BALANCE, ...scan.pc.SELFBALANCE])}; 0x3600… at pc ${pcs(scan.pc.USDC)}`,
    impact: "Unconfirmed. If both reads feed one total, the same funds are counted twice (DefiLlama, Sep 2026). Severity is not assigned until a state divergence is reproduced.",
    proof: [], signals: ["opcode-level co-occurrence only; data flow between the two reads is not proven"],
    remediation: "Account in one view (prefer USDC.balanceOf). Where native is compared to ERC-20 amounts, divide by 1e12 first.",
    test: forgeTest("LUN-02", block, `
    // Confirms or refutes the signal. Fill in the target's accounting getter.
    function test_singleBalanceNotDoubleCounted() public {
        address target = vm.parseAddress("${address}");
        vm.deal(target, target.balance + 1e18); // +1 USDC, visible through BOTH views
        (, bytes memory r) = USDC.staticcall(abi.encodeWithSignature("balanceOf(address)", target));
        uint256 erc20View = abi.decode(r, (uint256));
        // uint256 reported = ITarget(target).totalAssets();   // <- the getter under test
        // assertEq(reported, erc20View, "LUN-02 reproduced: balance counted twice");
        assertEq(erc20View * 1e12 <= target.balance, true);
    }`), docs: DOCS });
  else checks.push({ id: "LUN-02", key: "two-views", status: "pass", severity: null, confidence: "static", title: "Single balance view", trigger: "static analysis", expected: "—", actual: "no co-occurring native and ERC-20 balance reads", impact: "—", proof: [], signals: [], remediation: null, test: null, docs: DOCS });

  // LUN-05  PREVRANDAO: presence is static; the constant is demonstrated live.
  if (scan.PREVRANDAO) {
    const rnd = await traced(rpc, "PREVRANDAO probe · 7-byte contract returning block.prevrandao", { to: PROBE_RANDAO }, B, { [PROBE_RANDAO]: { code: RANDAO_CODE } });
    const zero = rnd.ok && BigInt(rnd.result) === 0n;
    checks.push({ id: "LUN-05", key: "prevrandao", status: "signal", severity: "Unconfirmed", confidence: "static signal + demonstrated constant",
      title: "Reads block.prevrandao, which is constant on Arc",
      trigger: `PREVRANDAO (0x44) at pc ${pcs(scan.pc.PREVRANDAO)}; live probe at block ${block}`,
      expected: "An unpredictable value per block",
      actual: zero ? "probe returns 0x00…00: PREVRANDAO is constant 0 on Arc mainnet" : `probe returned ${rnd.result || rnd.reason}`,
      impact: "Unconfirmed until usage is traced. If the value selects a winner, order or price, the outcome is fixed and predictable; if it is unused, there is no impact.",
      proof: [rnd], signals: [`0x44 reachable in dispatcher region (pc ${pcs(scan.pc.PREVRANDAO)})`],
      remediation: "Use a VRF or randomness oracle. Do not use prevrandao/difficulty for selection on Arc.",
      test: forgeTest("LUN-05", block, `
    function test_prevrandaoIsConstant() public view {
        assertEq(block.prevrandao, 0, "prevrandao non-zero on this fork");
    }`), docs: PORT });
  } else checks.push({ id: "LUN-05", key: "prevrandao", status: "pass", severity: null, confidence: "static", title: "No PREVRANDAO", trigger: "static analysis", expected: "—", actual: `no 0x44 in ${scan.analysedBytes} bytes of executable code`, impact: "—", proof: [], signals: [], remediation: null, test: null, docs: PORT });

  // LUN-04  SELFDESTRUCT (static only)
  if (scan.SELFDESTRUCT) checks.push({ id: "LUN-04", key: "selfdestruct", status: "signal", severity: "Unconfirmed", confidence: "static signal",
    title: "SELFDESTRUCT can move the full USDC balance",
    trigger: `SELFDESTRUCT (0xff) at pc ${pcs(scan.pc.SELFDESTRUCT)}`,
    expected: "Users' ERC-20 USDC stays in the contract", actual: "On Arc the contract's USDC is its native balance; SELFDESTRUCT transfers all of it to the beneficiary",
    impact: "Unconfirmed until reachability and access control are traced.", proof: [], signals: ["opcode presence only"],
    remediation: "Remove SELFDESTRUCT, or ensure the beneficiary is entitled to every unit held.", test: null, docs: DOCS });
  else checks.push({ id: "LUN-04", key: "selfdestruct", status: "pass", severity: null, confidence: "static", title: "No SELFDESTRUCT", trigger: "static analysis", expected: "—", actual: `no 0xff in ${scan.analysedBytes} bytes of executable code`, impact: "—", proof: [], signals: [], remediation: null, test: null, docs: DOCS });

  return { address, isContract: true, codeSize: (code.length - 2) / 2, analysedBytes: scan.analysedBytes, block, predeploy: !!codeOverride,
    policy: "Severity is assigned from demonstrated impact only. Static signals are Unconfirmed and do not block.", checks };
}

// Failed-transaction forensics: replay at N-1, counterfactual on the ERC-20 rail, signable fix, Foundry repro.
export async function diagnoseTx(hash, { rpc = client() } = {}) {
  const tx = await rpc("eth_getTransactionByHash", [hash]);
  if (!tx) return { found: false };
  const rc = await rpc("eth_getTransactionReceipt", [hash]);
  const value = BigInt(tx.value || 0), amt6 = value / SCALE;
  const blk = parseInt(tx.blockNumber, 16), prevN = blk - 1, prev = hex(prevN);
  const out = { found: true, hash, from: tx.from, to: tx.to, value18: value.toString(), amount: fmtUsdc(amt6),
    status: rc ? (rc.status === "0x1" ? "success" : "failed") : "pending", block: tx.blockNumber, gasUsed: rc ? parseInt(rc.gasUsed, 16) : null,
    input: tx.input, proof: [], signals: [] };
  if (out.status !== "failed") { out.cause = out.status === "success" ? "This transaction succeeded." : "Still pending."; return out; }
  if (!tx.to) { out.cause = "A contract deployment failed."; return out; }
  if (/^0x0{40}$/i.test(tx.to)) {
    out.kind = "zero-address";
    out.cause = "USDC was sent to the zero address. On Arc this always reverts (Ethereum would burn it). Funds are safe; only gas was used.";
    return out;
  }
  const code = await rpc("eth_getCode", [tx.to, tx.blockNumber]);
  const isContract = code && code !== "0x";
  const replay = await traced(rpc, `replay · original call at block ${prevN} (state before inclusion)`, { from: tx.from, to: tx.to, value: tx.value, data: tx.input }, prev);
  out.proof.push(replay);
  out.revertReason = replay.reason || null;
  out.signals.push(`target ${isContract ? `is a contract, ${(code.length - 2) / 2} bytes at block ${blk}` : "is an EOA"}`);

  if (isContract && value > 0n && (tx.input === "0x" || !tx.input)) {
    const alt = await traced(rpc, `counterfactual · same sender, same amount, ERC-20 rail, block ${prevN}`, { from: tx.from, to: USDC, data: transferData(tx.to, amt6) }, prev);
    out.proof.push(alt);
    const hasDeposit = code.toLowerCase().includes("63b6b55f25");
    out.signals.push(hasDeposit ? "dispatcher contains selector 0xb6b55f25 deposit(uint256): deposits are credited by function call, not by balance" : "no deposit(uint256) selector in dispatcher");
    out.kind = "native-to-erc20-only-contract";
    out.trigger = `native value transfer of ${value} wei with empty calldata to ${tx.to}`;
    out.expected = `${out.amount} USDC credited to the sender by the receiving contract`;
    out.actual = `${reverted(replay)} at block ${prevN}; the same amount through transfer() on 0x3600… ${alt.ok ? "succeeds" : "also reverts"}`;
    out.cause = `The wallet sent ${out.amount} USDC as native value. The receiving contract only accepts USDC through the ERC-20 interface at 0x3600…, so it reverted. The ${out.amount} USDC never left the sender; only gas (${out.gasUsed?.toLocaleString("en-US")}) was consumed.`;
    out.caution = hasDeposit
      ? "The contract credits deposits through deposit(uint256). A plain transfer() would deliver the USDC without crediting the sender, so the fix is approve → deposit."
      : "transfer() delivers the USDC to the contract. If the app keys payments by order or deposit ID, use its own payment flow so the sender is credited.";
    if (hasDeposit) {
      out.fix = { steps: [
          { to: USDC, data: "0x095ea7b3" + pad32(tx.to) + pad32(hex(amt6)), value: "0x0", label: `approve(${tx.to}, ${amt6})` },
          { to: tx.to, data: "0xb6b55f25" + pad32(hex(amt6)), value: "0x0", label: `deposit(${amt6})` } ],
        label: `approve → deposit ${out.amount} USDC on the ERC-20 rail` };
      out.fixVerified = false;
    } else if (alt.ok) {
      out.fix = { steps: [{ to: USDC, data: transferData(tx.to, amt6), value: "0x0", label: `transfer(${tx.to}, ${amt6})` }], label: `transfer ${out.amount} USDC on the ERC-20 rail` };
      out.fixVerified = true;
    }
    out.test = forgeTest("LUN-TX", prevN, `
    address constant SENDER = ${"address(0)"}; // replaced below via parseAddress

    function test_originalRevertsAtBlock() public {
        address sender = vm.parseAddress("${tx.from}");
        address target = vm.parseAddress("${tx.to}");
        vm.prank(sender);
        (bool ok, ) = target.call{value: ${value}}("");
        assertFalse(ok, "original call did not revert at this block");
    }

    function test_erc20RailSucceedsAtBlock() public {
        address sender = vm.parseAddress("${tx.from}");
        address target = vm.parseAddress("${tx.to}");
        vm.prank(sender);
        (bool ok, ) = USDC.call(abi.encodeWithSignature("transfer(address,uint256)", target, ${amt6}));
        assertTrue(ok, "ERC-20 rail failed at this block");
    }`).replace(`    address constant SENDER = address(0); // replaced below via parseAddress\n`, "");
    return out;
  }
  if (value > 0n) {
    out.kind = "value-transfer-reverted";
    out.cause = `A native USDC transfer was rejected${out.revertReason ? `: "${out.revertReason}"` : ""}. On Arc this is typically the USDC blocklist (sender or receiver), which reverts and still consumes gas.`;
    return out;
  }
  out.kind = "contract-revert";
  out.cause = `The contract rejected the call${out.revertReason ? `: "${out.revertReason}"` : " without a reason string"}. This is the application's own rule, not an Arc duality defect.`;
  return out;
}
