#!/usr/bin/env node
// lunua check <address>                       analyse a deployed contract
// lunua check --code <file.json|0xruntimehex>  analyse BEFORE deploying (runtime bytecode)
// lunua tx <hash>                             failed-transaction forensics
// flags: --testnet  --json  --repro <dir> (write Foundry reproductions)
// exit 1 if any demonstrated blocking finding (status "fail"): use as a deploy / CI gate.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ARC, client, checkContract, diagnoseTx } from "../engine/lunua.mjs";

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const [cmd, target] = argv;
const net = flag("--testnet") ? ARC.testnet : ARC.mainnet;
const rpc = client(process.env.ARC_RPC_URL || net.rpc);
const reproDir = opt("--repro");
const tag = { fail: "BLOCK ", warn: "LOW   ", signal: "SIGNAL", pass: "PASS  ", info: "INFO  " };

function writeRepro(name, src) {
  if (!reproDir || !src) return;
  mkdirSync(reproDir, { recursive: true });
  const f = join(reproDir, `${name.replace("-", "")}.t.sol`);
  writeFileSync(f, src);
  console.log(`         repro: ${f}`);
}

if (cmd === "check" && target) {
  let code = null, addr = target;
  if (target === "--code") {
    const src = argv[2];
    code = src.startsWith("0x") ? src : JSON.parse(readFileSync(src, "utf8")).deployed;
    addr = null;
  }
  const r = await checkContract(addr, { rpc, code });
  if (flag("--json")) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`\nLunua · ${code ? `undeployed code (${r.codeSize} B)` : r.address} · chain ${net.chainId} · block ${r.block}\n`);
    for (const c of r.checks) {
      console.log(`${tag[c.status]}  ${c.id}  ${c.severity ? `[${c.severity}] ` : ""}${c.title}`);
      if (c.status !== "pass") {
        if (c.actual && c.actual !== "—") console.log(`         actual: ${c.actual}`);
        if (c.impact && c.impact !== "—") console.log(`         impact: ${c.impact}`);
      }
      writeRepro(c.id, c.test);
    }
    const blocking = r.checks.filter((c) => c.status === "fail").length;
    console.log(`\n${blocking ? `${blocking} demonstrated blocking finding(s). Do not deploy.` : "No demonstrated blocking findings."}  ${r.policy || ""}\n`);
  }
  process.exit(r.checks.some((c) => c.status === "fail") ? 1 : 0);
} else if (cmd === "tx" && target) {
  const r = await diagnoseTx(target, { rpc });
  if (flag("--json")) console.log(JSON.stringify(r, null, 2));
  else if (!r.found) console.log("Transaction not found on this network.");
  else {
    console.log(`\n${r.hash}\nstatus ${r.status} · block ${parseInt(r.block, 16)} · gas ${r.gasUsed} · ${r.amount} USDC\n`);
    if (r.trigger) console.log(`trigger:  ${r.trigger}\nexpected: ${r.expected}\nactual:   ${r.actual}\n`);
    console.log(r.cause);
    if (r.caution) console.log(`\nnote: ${r.caution}`);
    if (r.fix) {
      console.log(`\nfix (${r.fixVerified ? "pre-simulated at the original block: succeeds" : "step 2 depends on step 1's allowance; not pre-simulated"}): ${r.fix.label}`);
      r.fix.steps.forEach((st, i) => console.log(`  ${i + 1}. ${st.label}\n     to ${st.to}\n     data ${st.data}`));
    }
    writeRepro("LUN-TX", r.test);
    console.log(`\n${net.explorer}/tx/${r.hash}\n`);
  }
} else {
  console.log("usage:\n  lunua check <address> | --code <file.json|0xhex>  [--repro <dir>] [--json] [--testnet]\n  lunua tx <hash>  [--repro <dir>] [--json] [--testnet]");
  process.exit(2);
}
