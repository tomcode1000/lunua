import { ARC, client, checkContract, diagnoseTx } from "./engine/lunua.mjs";

const rpc = client(ARC.mainnet.rpc);
const X = ARC.mainnet.explorer;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const out = $("#out"), input = $("#i-scan");
const kindOf = (v) => /^0x[0-9a-fA-F]{64}$/.test(v) ? "tx" : /^0x[0-9a-fA-F]{40}$/.test(v) ? "address" : null;
const short = (h, n = 6) => h ? `${h.slice(0, n + 2)}…${h.slice(-4)}` : "—";

// Display class per finding: severity comes from the engine (demonstrated impact only).
const cls = (c) => c.status === "pass" ? "pass" : c.status === "info" ? "info" : c.status === "signal" ? "unc"
  : ({ Critical: "high", High: "high", Medium: "med", Low: "low" }[c.severity] || "med");
const label = (c) => c.status === "pass" ? "Passed" : c.status === "info" ? "Info" : c.severity || "—";
const RANK = { high: 0, med: 1, low: 2, unc: 3, info: 4, pass: 5 };
const blobs = new Map(); // id -> text for copy/download buttons
let seq = 0;
const keep = (text) => { const id = "b" + ++seq; blobs.set(id, text); return id; };

// Live block height in the status strip.
async function tick() { try { $("#blk").textContent = parseInt(await rpc("eth_blockNumber", []), 16).toLocaleString("en-US"); } catch {} }
tick(); setInterval(tick, 4000);

input.addEventListener("input", () => {
  const k = kindOf(input.value.trim()), m = $("#kind");
  m.textContent = k === "tx" ? "TX HASH" : k === "address" ? "ADDRESS" : "—";
  m.classList.toggle("on", !!k);
});
function run(v) { input.value = v; input.dispatchEvent(new Event("input")); $("#f-scan").requestSubmit(); }

document.addEventListener("click", async (e) => {
  const v = e.target.closest("[data-v]");
  if (v) { e.preventDefault(); run(v.dataset.v); window.scrollTo({ top: 0, behavior: "smooth" }); return; }
  const c = e.target.closest("[data-copy]");
  if (c) { try { await navigator.clipboard.writeText(blobs.get(c.dataset.copy)); const t = c.textContent; c.textContent = "Copied"; setTimeout(() => (c.textContent = t), 1200); } catch {} return; }
  const d = e.target.closest("[data-dl]");
  if (d) {
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([blobs.get(d.dataset.dl)], { type: "text/plain" })), download: d.dataset.name });
    a.click(); URL.revokeObjectURL(a.href);
  }
});

$("#f-scan").onsubmit = async (e) => {
  e.preventDefault();
  const v = input.value.trim(), k = kindOf(v), btn = e.target.querySelector("button");
  if (!k) return;
  try { history.replaceState(null, "", `?${k}=${v}`); } catch {}
  btn.disabled = true; blobs.clear();
  out.innerHTML = `<div class="report"><div class="loading">${k === "tx" ? "Fetching receipt · replaying at block N−1 · counterfactual on the ERC-20 rail" : "eth_getCode · disassembling · simulating probes with state overrides at a pinned block"}</div></div>`;
  try { k === "tx" ? await reportTx(v) : await reportAddress(v); }
  catch (err) { out.innerHTML = `<div class="report"><div class="err">ERROR · ${esc(err.message)}</div></div>`; }
  btn.disabled = false;
};

async function reportId(obj) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(obj)));
  return "LUN-" + [...new Uint8Array(buf)].slice(0, 5).map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}
function wireActions(data, rid) {
  $("#a-json").onclick = () => {
    const blob = new Blob([JSON.stringify({ reportId: rid, generated: new Date().toISOString(), network: "arc-mainnet", chainId: 5042, ...data }, null, 2)], { type: "application/json" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `${rid}.json` }); a.click(); URL.revokeObjectURL(a.href);
  };
  $("#a-link").onclick = async (e) => { try { await navigator.clipboard.writeText(location.href); e.target.textContent = "Copied"; setTimeout(() => (e.target.textContent = "Copy link"), 1500); } catch {} };
}
const metaCell = (k, v) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
const head = (kind, rid) => `<div class="r-head"><span class="r-kind">${kind} · <b>${rid}</b></span><span class="r-act"><button id="a-link">Copy link</button><button id="a-json">Export JSON</button></span></div>`;

// One proof item: label, outcome, and the raw request/response with a re-runnable curl.
function proofItem(p) {
  const raw = JSON.stringify({ request: p.request, response: p.response }, null, 2);
  return `<details class="pf"><summary><span class="pf-o ${p.ok ? "ok" : "rv"}">${p.ok ? "OK" : "REVERT"}</span><span>${esc(p.label)}</span><span class="pf-x">inspect</span></summary>
    <pre class="raw">${esc(raw)}</pre>
    <div class="pf-a"><button data-copy="${keep(p.curl)}">Copy curl</button><button data-copy="${keep(raw)}">Copy JSON</button></div></details>`;
}
function testBlock(name, src) {
  if (!src) return "";
  return `<div><h4>Next step · reproducible test</h4>
    <p class="hint">Foundry test pinned to the analysed block. Run with Arc Foundry: <code>arc-forge test --network arc -vvvv</code></p>
    <details class="pf"><summary><span class="pf-o tst">TEST</span><span>${esc(name)}.t.sol</span><span class="pf-x">view</span></summary><pre class="raw">${esc(src)}</pre></details>
    <div class="pf-a"><button data-copy="${keep(src)}">Copy test</button><button data-dl="${keep(src)}" data-name="${esc(name.replace("-", ""))}.t.sol">Download .t.sol</button></div></div>`;
}
function caseTable(c) {
  const row = (k, v) => v && v !== "—" ? `<tr><th>${k}</th><td>${esc(v)}</td></tr>` : "";
  return `<table class="case">${row("Trigger", c.trigger)}${row("Expected", c.expected)}${row("Actual", c.actual)}${row("Impact", c.impact)}${row("Confidence", c.confidence)}</table>`;
}

async function reportAddress(a) {
  const r = await checkContract(a, { rpc });
  const fs = r.checks.map((c) => ({ ...c, k: cls(c) })).sort((x, y) => RANK[x.k] - RANK[y.k]);
  const n = (k) => fs.filter((f) => f.k === k).length;
  const blocking = fs.filter((f) => f.status === "fail").length;
  const rid = await reportId({ a: r.address, block: r.block, f: fs.map((f) => [f.id, f.status, f.severity]) });
  const top = !r.isContract ? "info" : blocking ? "high" : n("low") || n("unc") ? "med" : "pass";
  const vt = !r.isContract ? "EOA" : blocking ? "BLOCKED" : n("low") || n("unc") ? "REVIEW" : "CLEAR";
  const vs = !r.isContract ? "Externally owned account. No bytecode to analyse."
    : blocking ? `${blocking} demonstrated blocking finding${blocking > 1 ? "s" : ""}. Do not deploy or route funds.`
    : n("unc") ? `${n("unc")} unconfirmed signal${n("unc") > 1 ? "s" : ""} to triage. Nothing demonstrated as blocking.` : "No Arc duality defects demonstrated.";
  const total = fs.length || 1;
  const seg = (k, c) => n(k) ? `<i style="width:${(n(k) / total) * 100}%;background:var(--${c})"></i>` : "";
  out.innerHTML = `<div class="report">
    ${head("Contract analysis", rid)}
    <div class="r-sum">
      <div class="verdict"><div class="v ${top}">${vt}</div><div class="vs">${vs}</div></div>
      <dl class="meta" style="margin:0">
        ${metaCell("Target", `<a href="${X}/address/${esc(r.address)}" target="_blank" rel="noopener">${esc(short(r.address, 8))}</a>`)}
        ${metaCell("Network", "Arc mainnet · 5042")}
        ${metaCell("Pinned block", r.block ? r.block.toLocaleString("en-US") : "—")}
        ${metaCell("Bytecode", r.isContract ? `${r.codeSize} B · ${r.analysedBytes} B exec` : "none")}
        ${metaCell("Method", "eth_call + state override · opcode walk")}
        ${metaCell("Severity policy", "demonstrated impact only")}
      </dl>
    </div>
    <div class="bar">${seg("high", "high")}${seg("med", "med")}${seg("low", "low")}${seg("unc", "dim")}${seg("info", "info")}${seg("pass", "pass")}</div>
    <div class="counts"><span><b>${blocking}</b> Blocking</span><span><b>${n("low")}</b> Low</span><span><b>${n("unc")}</b> Unconfirmed</span><span><b>${n("pass")}</b> Passed</span></div>
    ${fs.map((f, i) => `<details class="f"${f.k !== "pass" && i < 2 ? " open" : ""}>
      <summary><span class="id">${f.id}</span><span class="sev ${f.k}">${label(f)}</span><span class="t">${esc(f.title)}</span><span class="chev">›</span></summary>
      <div class="fb">
        ${f.k !== "pass" ? caseTable(f) : `<p>${esc(f.actual)}</p>`}
        ${f.proof?.length ? `<div><h4>Proof · ${f.proof.length} live call${f.proof.length > 1 ? "s" : ""} at block ${r.block}</h4>${f.proof.map(proofItem).join("")}</div>` : ""}
        ${f.signals?.length ? `<div><h4>Static evidence</h4><ul class="ev">${f.signals.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>` : ""}
        ${f.remediation && f.k !== "pass" ? `<div><h4>Remediation</h4><p>${esc(f.remediation)}</p></div>` : ""}
        ${f.k !== "pass" ? testBlock(f.id, f.test) : ""}
        ${f.docs && f.k !== "pass" ? `<div><h4>Reference</h4><p><a href="${f.docs}" target="_blank" rel="noopener">${esc(f.docs.replace("https://", ""))}</a></p></div>` : ""}
      </div></details>`).join("")}
  </div>`;
  wireActions({ type: "contract", target: r.address, pinnedBlock: r.block, codeSize: r.codeSize, policy: r.policy,
    findings: fs.map(({ id, status, severity, confidence, title, trigger, expected, actual, impact, proof, signals, remediation, test, docs }) =>
      ({ id, status, severity, confidence, title, trigger, expected, actual, impact, proof: proof.map(({ label, ok, request, response, curl }) => ({ label, ok, request, response, curl })), signals, remediation, test, reference: docs })) }, rid);
}

async function reportTx(h) {
  const r = await diagnoseTx(h, { rpc });
  if (!r.found) { out.innerHTML = `<div class="report"><div class="err">Transaction not found on Arc mainnet.</div></div>`; return; }
  const rid = await reportId({ h: r.hash, k: r.kind, s: r.status });
  const top = r.status === "failed" ? "high" : r.status === "success" ? "pass" : "info";
  const vt = r.status === "failed" ? "REVERTED" : r.status === "success" ? "SUCCESS" : "PENDING";
  const blk = parseInt(r.block, 16);
  const fix = r.fix ? `<div><h4>Remediation · ${esc(r.fix.label)}</h4>
      <ul class="ev">${r.fix.steps.map((s, i) => `<li>${i + 1}. ${esc(s.label)}<br><span class="calldata">to ${esc(s.to)} · value 0 · data ${esc(s.data)}</span></li>`).join("")}</ul>
      <p class="hint">${r.fixVerified ? "Pre-simulated at the original block: succeeds." : `Requires ${r.fix.steps.length} signatures. Step 2 consumes the allowance from step 1, so it can't be pre-simulated in a single eth_call.`}</p>
      <button class="go" id="resend">Execute on ERC-20 rail</button><span class="calldata" id="rs"></span></div>` : "";
  out.innerHTML = `<div class="report">
    ${head("Transaction forensics", rid)}
    <div class="r-sum">
      <div class="verdict"><div class="v ${top}">${vt}</div><div class="vs">${esc(r.kind || r.cause)}</div></div>
      <dl class="meta" style="margin:0">
        ${metaCell("Tx", `<a href="${X}/tx/${esc(r.hash)}" target="_blank" rel="noopener">${esc(short(r.hash, 8))}</a>`)}
        ${metaCell("Block", blk.toLocaleString("en-US"))}
        ${metaCell("Gas used", r.gasUsed != null ? r.gasUsed.toLocaleString("en-US") : "—")}
        ${metaCell("From", `<a href="${X}/address/${esc(r.from)}" target="_blank" rel="noopener">${esc(short(r.from))}</a>`)}
        ${metaCell("To", r.to ? `<button class="lnk" data-v="${esc(r.to)}">${esc(short(r.to))} · analyse</button>` : "—")}
        ${metaCell("Value", `${esc(r.amount)} USDC · ${esc(r.value18)} wei`)}
      </dl>
    </div>
    ${r.status === "failed" ? `<details class="f" open>
      <summary><span class="id">LUN-TX</span><span class="sev ${top}">Root cause</span><span class="t">${esc(r.kind || "revert")}</span><span class="chev">›</span></summary>
      <div class="fb">
        <div><h4>Finding</h4><p>${esc(r.cause)}</p></div>
        ${r.trigger ? caseTable({ trigger: r.trigger, expected: r.expected, actual: r.actual, impact: `Sender paid ${r.gasUsed?.toLocaleString("en-US")} gas; ${r.amount} USDC not delivered. No funds lost.`, confidence: "demonstrated by replay at block N−1" }) : ""}
        ${r.proof?.length ? `<div><h4>Proof · replay and counterfactual</h4>${r.proof.map(proofItem).join("")}</div>` : ""}
        ${r.signals?.length ? `<div><h4>Static evidence</h4><ul class="ev">${r.signals.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>` : ""}
        ${r.caution ? `<p class="note">${esc(r.caution)}</p>` : ""}
        ${fix}
        ${testBlock("LUN-TX", r.test)}
      </div></details>` : `<div class="loading" style="animation:none">${esc(r.cause)}</div>`}
  </div>`;
  wireActions({ type: "transaction", hash: r.hash, status: r.status, block: blk, from: r.from, to: r.to, valueWei: r.value18, classification: r.kind,
    trigger: r.trigger, expected: r.expected, actual: r.actual, rootCause: r.cause,
    proof: (r.proof || []).map(({ label, ok, request, response, curl }) => ({ label, ok, request, response, curl })), signals: r.signals, remediation: r.fix || null, test: r.test || null }, rid);
  if (r.fix) $("#resend").onclick = () => resend(r);
}

async function resend(r) {
  const s = $("#rs"), eth = window.ethereum;
  if (!eth) { s.textContent = " No injected wallet. Send the USDC token (0x3600…) instead of the native asset."; return; }
  try {
    const [from] = await eth.request({ method: "eth_requestAccounts" });
    if (from.toLowerCase() !== r.from.toLowerCase()) { s.textContent = ` Connect the original sender ${r.from}.`; return; }
    try { await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x13b2" }] }); }
    catch (err) {
      if (err.code !== 4902) throw err;
      await eth.request({ method: "wallet_addEthereumChain", params: [{ chainId: "0x13b2", chainName: "Arc", rpcUrls: [ARC.mainnet.rpc], blockExplorerUrls: [X], nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 } }] });
    }
    const done = [];
    for (const [i, st] of r.fix.steps.entries()) {
      s.textContent = ` ${done.join(" · ")} sign ${i + 1}/${r.fix.steps.length}: ${st.label}…`;
      const hash = await eth.request({ method: "eth_sendTransaction", params: [{ from, to: st.to, data: st.data, value: "0x0" }] });
      for (let k = 0; k < 20; k++) {
        const rc = await eth.request({ method: "eth_getTransactionReceipt", params: [hash] });
        if (rc) { if (rc.status !== "0x1") throw new Error(`step ${i + 1} reverted: ${hash}`); break; }
        await new Promise((z) => setTimeout(z, 500));
      }
      done.push(`${i + 1} ✓ ${hash.slice(0, 10)}…`);
    }
    s.textContent = ` ${done.join(" · ")} · settled`;
  } catch (e) { s.textContent = ` ${e.message}`; }
}

const q = new URLSearchParams(location.search), v0 = q.get("address") || q.get("tx");
if (v0) run(v0);
