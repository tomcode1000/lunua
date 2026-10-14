const solc = require("solc"), fs = require("fs"), path = require("path");
const dir = path.join(__dirname, "..", "contracts", "src");
const sources = {};
for (const f of fs.readdirSync(dir)) sources[f] = { content: fs.readFileSync(path.join(dir, f), "utf8") };
const out = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources,
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "prague", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } } } })));
for (const e of out.errors || []) console.log(e.severity, e.formattedMessage);
fs.mkdirSync(path.join(__dirname, "..", "build"), { recursive: true });
for (const [f, cs] of Object.entries(out.contracts || {})) for (const [n, c] of Object.entries(cs)) {
  fs.writeFileSync(path.join(__dirname, "..", "build", n + ".json"), JSON.stringify({ abi: c.abi, bytecode: "0x" + c.evm.bytecode.object, deployed: "0x" + c.evm.deployedBytecode.object }, null, 1));
  console.log("built", n, c.evm.deployedBytecode.object.length / 2, "bytes");
}
