const RPC = "https://rpc.mainnet.arc.io";
const rpc = async (method, params) => (await (await fetch(RPC, {method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({jsonrpc:"2.0", id:1, method, params})})).json());
const h = process.argv[2];
const tx = (await rpc("eth_getTransactionByHash", [h])).result;
const rc = (await rpc("eth_getTransactionReceipt", [h])).result;
console.log({from: tx?.from, to: tx?.to, value: tx?.value, input: tx?.input?.slice(0,74), block: tx?.blockNumber, status: rc?.status, gasUsed: rc?.gasUsed});
if (tx) {
  const code = (await rpc("eth_getCode", [tx.to, tx.blockNumber])).result;
  console.log("target code bytes:", (code.length-2)/2);
  const prev = "0x" + (BigInt(tx.blockNumber)-1n).toString(16);
  console.log("replay:", JSON.stringify(await rpc("eth_call", [{from: tx.from, to: tx.to, value: tx.value, data: tx.input}, prev])));
}
