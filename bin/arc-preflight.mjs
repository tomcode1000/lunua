#!/usr/bin/env node
// arc-preflight check <address> [--testnet] [--json]   exit 1 if any FAIL (use as a deploy gate)
// arc-preflight check --code <file.json|0xhex>                  check BEFORE deploying (runtime bytecode)
// arc-preflight tx <hash> [--testnet] [--json]         explain a failed transaction
import { readFileSync } from "node:fs";
import { ARC, client, checkContract, diagnoseTx } from "../engine/preflight.mjs";

const [cmd, target, ...rest] = process.argv.slice(2);
const net = rest.includes("--testnet") ? ARC.testnet : ARC.mainnet;
const json = rest.includes("--json");
const rpc = client(process.env.ARC_RPC_URL || net.rpc);
const icon = { pass: "✅ PASS", fail: "❌ FAIL", warn: "⚠️  WARN", info: "ℹ️  INFO" };

if (cmd === "check" && target) {
  let code = null, addr = target;
  if (target === "--code") {
    const src = rest[0];
    code = src.startsWith("0x") ? src : (JSON.parse(readFileSync(src, "utf8")).deployed);
    addr = null;
  }
  const r = await checkContract(addr, { rpc, code });
  if (json) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`\nArc Preflight report for ${code ? `undeployed code (${r.codeSize} bytes)` : r.address} (chain ${net.chainId})\n`);
    for (const c of r.checks) {
      console.log(`${icon[c.status]}  ${c.title}`);
      if (c.detail) console.log(`         ${c.detail}`);
      if (c.fix && c.status !== "pass") console.log(`         Fix: ${c.fix}`);
    }
    const fails = r.checks.filter((c) => c.status === "fail").length;
    console.log(`\n${fails ? `❌ ${fails} blocking issue(s). Do not launch yet.` : "✅ No blocking issues."}\n`);
  }
  process.exit(r.checks.some((c) => c.status === "fail") ? 1 : 0);
} else if (cmd === "tx" && target) {
  const r = await diagnoseTx(target, { rpc });
  if (json) console.log(JSON.stringify(r, null, 2));
  else if (!r.found) console.log("Transaction not found on this network.");
  else {
    console.log(`\n${r.hash}\nstatus: ${r.status}   from ${r.from} -> ${r.to}   amount ${r.amount} USDC\n`);
    console.log(r.cause);
    if (r.caution) console.log(`\nNote: ${r.caution}`);
    if (r.fix) {
      console.log(`\nFix (${r.fixVerified ? "simulated at the original block: succeeds" : "not pre-simulated: step 2 depends on step 1"}): ${r.fix.label}`);
      r.fix.steps.forEach((st, i) => console.log(`  ${i + 1}. ${st.label}\n     to: ${st.to}\n     data: ${st.data}`));
    }
    console.log(`\nExplorer: ${net.explorer}/tx/${r.hash}\n`);
  }
} else {
  console.log("usage:\n  arc-preflight check <contract-address> [--testnet] [--json]\n  arc-preflight tx <tx-hash> [--testnet] [--json]");
  process.exit(2);
}
