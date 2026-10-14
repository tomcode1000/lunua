import { ARC, client, checkContract, diagnoseTx } from "./engine/lunua.mjs";

const rpc = client(ARC.mainnet.rpc);
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const out = $("#out"), X = ARC.mainnet.explorer, input = $("#i-scan");
const kindOf = (v) => /^0x[0-9a-fA-F]{64}$/.test(v) ? "tx" : /^0x[0-9a-fA-F]{40}$/.test(v) ? "address" : null;

function scan(v) { input.value = v; input.dispatchEvent(new Event("input")); $("#f-scan").requestSubmit(); }
input.addEventListener("input", () => {
  const k = kindOf(input.value.trim());
  $("#kind").textContent = k === "tx" ? "TX HASH" : k === "address" ? "ADDRESS" : "";
});
document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-v],[data-scan]");
  if (a) { e.preventDefault(); scan(a.dataset.v || a.dataset.scan); }
});

const busy = (label) => { out.innerHTML = `<div class="report"><div class="rhead"><span class="spin"></span><span class="d">${label}</span></div></div>`; };
const fail = (e) => { out.innerHTML = `<div class="report"><div class="rhead"><span class="tag fail" style="padding:3px 8px">ERROR</span><span>${esc(e.message)}</span></div></div>`; };

$("#f-scan").onsubmit = async (e) => {
  e.preventDefault();
  const v = input.value.trim(), k = kindOf(v), btn = e.target.querySelector("button");
  if (!k) return;
  try { history.replaceState(null, "", `?${k}=${v}`); } catch {}
  btn.disabled = true;
  try { k === "tx" ? await scanTx(v) : await scanAddress(v); } catch (err) { fail(err); }
  btn.disabled = false;
};

async function scanAddress(a) {
  busy("Simulating native, dust and ERC-20 sends on Arc mainnet · disassembling bytecode…");
  const r = await checkContract(a, { rpc });
  const n = (st) => r.checks.filter((c) => c.status === st).length;
  const f = n("fail"), w = n("warn"), p = n("pass");
  const lvl = !r.isContract ? "info" : f ? "fail" : w ? "warn" : "pass";
  const badge = { info: "EOA", fail: "RISK", warn: "CAUTION", pass: "SAFE" }[lvl];
  const verdict = !r.isContract ? "Wallet address, not a contract"
    : f ? `${f} blocking issue${f > 1 ? "s" : ""}: not safe to launch on Arc`
    : w ? "No blocking issues, review warnings" : "No Arc USDC issues found";
  out.innerHTML = `<div class="report">
    <div class="rhead"><div class="score s-${lvl}">${badge}</div><div style="min-width:0;flex:1">
      <div class="verdict">${verdict}</div>
      <div class="meta">${esc(r.address)}${r.codeSize ? ` · ${r.codeSize} bytes` : ""} · <a href="${X}/address/${esc(r.address)}" target="_blank" rel="noopener">explorer ↗</a></div>
      ${r.isContract ? `<div class="counts"><span class="fail">${f} FAIL</span><span class="warn">${w} WARN</span><span class="pass">${p} PASS</span></div>` : ""}
    </div></div>
    <div class="rbody">${r.checks.map((c) => `<div class="row"><span class="tag ${c.status}">${c.status.toUpperCase()}</span><div>
      <div class="t">${esc(c.title)}</div>${c.detail ? `<div class="d">${esc(c.detail)}</div>` : ""}
      ${c.fix && c.status !== "pass" ? `<div class="fix"><b>Fix:</b> ${esc(c.fix)} ${c.docs ? `<a href="${c.docs}" target="_blank" rel="noopener">Arc docs ↗</a>` : ""}</div>` : ""}
    </div></div>`).join("")}</div></div>`;
}

async function scanTx(h) {
  busy("Replaying the transaction at its original block on Arc mainnet…");
  const r = await diagnoseTx(h, { rpc });
  if (!r.found) { out.innerHTML = `<div class="report"><div class="rhead"><span class="d">Transaction not found on Arc mainnet.</span></div></div>`; return; }
  const lvl = r.status === "failed" ? "fail" : r.status === "success" ? "pass" : "info";
  const fix = r.fix ? `<div class="t" style="margin-top:14px">Remediation · ${esc(r.fix.label)}</div>
      <ol class="steps">${r.fix.steps.map((s) => `<li>${esc(s.label)} → ${esc(s.to.slice(0, 10))}…</li>`).join("")}</ol>
      <p class="d">${r.fixVerified ? "Pre-simulated at the original block: <b>succeeds</b>."
        : `${r.fix.steps.length} wallet confirmations. Step 2 depends on step 1's allowance, so it can't be pre-simulated in a single eth_call.`}</p>
      <button class="btn" id="resend">Resend on the correct rail</button> <span class="d" id="rs"></span>` : "";
  out.innerHTML = `<div class="report">
    <div class="rhead"><div class="score s-${lvl}">${{ fail: "FAILED", pass: "OK", info: "PEND" }[lvl]}</div><div style="min-width:0;flex:1">
      <div class="verdict">${r.status === "failed" ? `Payment of ${esc(r.amount)} USDC failed` : r.status === "success" ? "Payment succeeded" : "Pending"}</div>
      <div class="meta">${esc(r.from)} → ${esc(r.to)} · block ${parseInt(r.block, 16)} · <a href="${X}/tx/${esc(r.hash)}" target="_blank" rel="noopener">explorer ↗</a></div>
      ${r.kind ? `<div class="counts"><span class="info">${esc(r.kind)}</span></div>` : ""}
    </div></div>
    <div class="rbody" style="padding-top:16px">
      <div class="t">Root cause</div><p style="margin:6px 0 0">${esc(r.cause)}</p>
      ${r.caution ? `<div class="callout w"><b>Before you resend:</b> ${esc(r.caution)}</div>` : ""}
      ${fix}
      ${r.kind === "native-to-erc20-only-contract" ? `<p class="d" style="margin-top:14px"><a href="?address=${esc(r.to)}" data-scan="${esc(r.to)}">Scan the receiving contract →</a></p>` : ""}
    </div></div>`;
  if (r.fix) $("#resend").onclick = () => resend(r);
}

async function resend(r) {
  const s = $("#rs"), eth = window.ethereum;
  if (!eth) { s.textContent = "No browser wallet found. In your wallet, send the USDC token (0x3600…) instead of the native coin."; return; }
  try {
    const [from] = await eth.request({ method: "eth_requestAccounts" });
    if (from.toLowerCase() !== r.from.toLowerCase()) { s.textContent = `Connect the wallet that sent the original payment (${r.from}).`; return; }
    try { await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x13b2" }] }); }
    catch (err) {
      if (err.code !== 4902) throw err;
      await eth.request({ method: "wallet_addEthereumChain", params: [{ chainId: "0x13b2", chainName: "Arc", rpcUrls: [ARC.mainnet.rpc], blockExplorerUrls: [X], nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 } }] });
    }
    const links = [];
    for (const [i, st] of r.fix.steps.entries()) {
      s.innerHTML = `${links.join(" · ")} Confirm step ${i + 1}/${r.fix.steps.length} in your wallet: ${esc(st.label)}…`;
      const hash = await eth.request({ method: "eth_sendTransaction", params: [{ from, to: st.to, data: st.data, value: "0x0" }] });
      for (let k = 0; k < 20; k++) {
        const rc = await eth.request({ method: "eth_getTransactionReceipt", params: [hash] });
        if (rc) { if (rc.status !== "0x1") throw new Error(`Step ${i + 1} failed: ${hash}`); break; }
        await new Promise((z) => setTimeout(z, 500));
      }
      links.push(`step ${i + 1} ✅ <a href="${X}/tx/${hash}" target="_blank" rel="noopener">${hash.slice(0, 12)}…</a>`);
    }
    s.innerHTML = links.join(" · ") + " · done.";
  } catch (e) { s.textContent = e.message; }
}

// Shareable links: ?address=<contract> or ?tx=<hash> scan immediately.
const q = new URLSearchParams(location.search), v0 = q.get("address") || q.get("tx");
if (v0) scan(v0);
