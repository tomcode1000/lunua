import { ARC, client, checkContract, diagnoseTx, USDC } from "./engine/lunua.mjs";

const rpc = client(ARC.mainnet.rpc);
const X = ARC.mainnet.explorer;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const out = $("#out"), input = $("#i-scan");
const kindOf = (v) => /^0x[0-9a-fA-F]{64}$/.test(v) ? "tx" : /^0x[0-9a-fA-F]{40}$/.test(v) ? "address" : null;
const short = (h, n = 6) => h ? `${h.slice(0, n + 2)}…${h.slice(-4)}` : "—";

// Detector registry: engine check id -> public finding id, severity when it trips.
const DET = {
  "native-receive": { id: "LUN-01", sev: "high" },
  "two-views":      { id: "LUN-02", sev: "med" },
  "dust":           { id: "LUN-03", sev: "low" },
  "selfdestruct":   { id: "LUN-04", sev: "med" },
  "prevrandao":     { id: "LUN-05", sev: "high" },
  "eoa":            { id: "LUN-00", sev: "info" },
};
const SEV = { high: "High", med: "Medium", low: "Low", info: "Info", pass: "Passed" };
const RANK = { high: 0, med: 1, low: 2, info: 3, pass: 4 };
const sevOf = (c) => c.status === "pass" ? "pass" : c.status === "info" ? "info" : DET[c.id]?.sev || "med";

// Live block height in the status strip.
async function tick() { try { $("#blk").textContent = parseInt(await rpc("eth_blockNumber", []), 16).toLocaleString("en-US"); } catch {} }
tick(); setInterval(tick, 4000);

// Input handling.
input.addEventListener("input", () => {
  const k = kindOf(input.value.trim()), m = $("#kind");
  m.textContent = k === "tx" ? "TX HASH" : k === "address" ? "ADDRESS" : "—";
  m.classList.toggle("on", !!k);
});
function run(v) { input.value = v; input.dispatchEvent(new Event("input")); $("#f-scan").requestSubmit(); }
document.addEventListener("click", (e) => { const b = e.target.closest("[data-v]"); if (b) { e.preventDefault(); run(b.dataset.v); window.scrollTo({ top: 0, behavior: "smooth" }); } });

$("#f-scan").onsubmit = async (e) => {
  e.preventDefault();
  const v = input.value.trim(), k = kindOf(v), btn = e.target.querySelector("button");
  if (!k) return;
  try { history.replaceState(null, "", `?${k}=${v}`); } catch {}
  btn.disabled = true;
  out.innerHTML = `<div class="report"><div class="loading">${k === "tx" ? "Fetching receipt · replaying at block N−1 · running counterfactual on the ERC-20 rail" : "eth_getCode · disassembling · simulating native, dust and ERC-20 probes with state overrides"}</div></div>`;
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

async function reportAddress(a) {
  const r = await checkContract(a, { rpc });
  const findings = r.checks.map((c) => ({ ...c, sev: sevOf(c), fid: DET[c.id]?.id || "LUN-??" })).sort((x, y) => RANK[x.sev] - RANK[y.sev]);
  const n = (s) => findings.filter((f) => f.sev === s).length;
  const H = n("high"), M = n("med"), L = n("low"), P = n("pass"), I = n("info");
  const rid = await reportId({ a: r.address, block: r.block, f: findings.map((f) => [f.fid, f.sev]) });
  const top = !r.isContract ? "info" : H ? "high" : M ? "med" : L ? "med" : "pass";
  const vt = !r.isContract ? "EOA" : H ? "BLOCKED" : M || L ? "REVIEW" : "CLEAR";
  const vs = !r.isContract ? "Externally owned account. No bytecode to analyse." : H ? `${H} high-severity finding${H > 1 ? "s" : ""}. Do not deploy or route funds.` : M || L ? "No blocking findings. Review medium/low items." : "No Arc duality defects detected.";
  const total = findings.length || 1;
  const seg = (c, k) => k ? `<i style="width:${(k / total) * 100}%;background:var(--${c})"></i>` : "";
  out.innerHTML = `<div class="report">
    ${head("Contract analysis", rid)}
    <div class="r-sum">
      <div class="verdict"><div class="v ${top}">${vt}</div><div class="vs">${vs}</div></div>
      <dl class="meta" style="margin:0">
        ${metaCell("Target", `<a href="${X}/address/${esc(r.address)}" target="_blank" rel="noopener">${esc(short(r.address, 8))}</a>`)}
        ${metaCell("Network", "Arc mainnet · 5042")}
        ${metaCell("Block", r.block ? r.block.toLocaleString("en-US") : "—")}
        ${metaCell("Bytecode", r.isContract ? `${r.codeSize} B · ${r.analysedBytes} B exec` : "none")}
        ${metaCell("Method", "eth_call + state override · opcode walk")}
        ${metaCell("Generated", new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC")}
      </dl>
    </div>
    <div class="bar">${seg("high", H)}${seg("med", M)}${seg("low", L)}${seg("info", I)}${seg("pass", P)}</div>
    <div class="counts"><span><b>${H}</b> High</span><span><b>${M}</b> Medium</span><span><b>${L}</b> Low</span><span><b>${I}</b> Info</span><span><b>${P}</b> Passed</span></div>
    ${findings.map((f, i) => `<details class="f"${f.sev !== "pass" && i < 3 ? " open" : ""}>
      <summary><span class="id">${f.fid}</span><span class="sev ${f.sev}">${SEV[f.sev]}</span><span class="t">${esc(f.title)}</span><span class="chev">›</span></summary>
      <div class="fb">
        ${f.detail ? `<div><h4>Description</h4><p>${esc(f.detail)}</p></div>` : ""}
        ${f.evidence?.length ? `<div><h4>Evidence</h4><ul class="ev">${f.evidence.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>` : ""}
        ${f.fix && f.sev !== "pass" ? `<div><h4>Remediation</h4><p>${esc(f.fix)}</p></div>` : ""}
        ${f.docs && f.sev !== "pass" ? `<div><h4>Reference</h4><p><a href="${f.docs}" target="_blank" rel="noopener">${esc(f.docs.replace("https://", ""))}</a></p></div>` : ""}
      </div></details>`).join("")}
  </div>`;
  wireActions({ type: "contract", target: r.address, block: r.block, codeSize: r.codeSize, findings: findings.map(({ fid, sev, title, detail, evidence, fix, docs }) => ({ id: fid, severity: SEV[sev], title, detail, evidence, remediation: fix, reference: docs })) }, rid);
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
      <p style="margin-top:8px">${r.fixVerified ? "Pre-simulated at the original block: succeeds." : `Requires ${r.fix.steps.length} signatures. Step 2 consumes the allowance created in step 1, so it can't be pre-simulated in a single eth_call.`}</p></div>
      <button class="go" id="resend">Execute on ERC-20 rail</button><span class="calldata" id="rs"></span>` : "";
  out.innerHTML = `<div class="report">
    ${head("Transaction forensics", rid)}
    <div class="r-sum">
      <div class="verdict"><div class="v ${top}">${vt}</div><div class="vs">${r.kind ? esc(r.kind) : esc(r.cause)}</div></div>
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
        ${r.evidence?.length ? `<div><h4>Evidence</h4><ul class="ev">${r.evidence.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>` : ""}
        ${r.caution ? `<p class="note">${esc(r.caution)}</p>` : ""}
        ${fix}
      </div></details>` : `<div class="loading" style="animation:none">${esc(r.cause)}</div>`}
  </div>`;
  wireActions({ type: "transaction", hash: r.hash, status: r.status, block: blk, from: r.from, to: r.to, valueWei: r.value18, classification: r.kind, rootCause: r.cause, evidence: r.evidence, remediation: r.fix || null }, rid);
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
