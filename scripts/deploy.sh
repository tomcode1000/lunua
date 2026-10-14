#!/usr/bin/env bash
# Deploys Arc Preflight's on-chain parts to Arc MAINNET and runs the live demo transactions.
# Prereq (once, typed by YOU, key never leaves your machine):
#   ~/.local/bin/arc-cast wallet import preflight --interactive
# Cost: about 0.03-0.05 USDC of gas in total.
set -euo pipefail
cd "$(dirname "$0")/.."
CAST=~/.local/bin/arc-cast
RPC=https://rpc.mainnet.arc.io
read -rsp "Keystore password for 'preflight': " PW; echo
PWF=$(mktemp); printf '%s' "$PW" > "$PWF"; trap 'rm -f "$PWF"' EXIT
A=(--rpc-url "$RPC" --account preflight --password-file "$PWF")
ME=$($CAST wallet address --account preflight --password-file "$PWF")
echo "Deployer: $ME   balance: $($CAST balance "$ME" --rpc-url $RPC --ether) USDC"
[ "$($CAST chain-id --rpc-url $RPC)" = "5042" ] || { echo "not Arc mainnet"; exit 1; }

deploy() { $CAST send "${A[@]}" --create "$(cat build/$1.bin)" --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["contractAddress"])'; }
REG=$(deploy PreflightRegistry); echo "PreflightRegistry $REG"
PORTED=$(deploy PortedVault);    echo "PortedVault       $PORTED"
FIXED=$(deploy ArcVault);        echo "ArcVault          $FIXED"

# Record preflight results on-chain. Bits: 0 native-receive, 1 dust, 2 two-views, 4 selfdestruct, 5 prevrandao
$CAST send "${A[@]}" "$REG" "record(address,uint32,uint32)" "$PORTED" 33 4 >/dev/null
$CAST send "${A[@]}" "$REG" "record(address,uint32,uint32)" "$FIXED" 0 0 >/dev/null
$CAST send "${A[@]}" "$REG" "record(address,uint32,uint32)" 0x0970462cece33d425dba716cbf4855bb4f44fcf5 1 0 >/dev/null
echo "Results recorded."

# Live demo: a wallet-style native send of 0.01 USDC to each vault.
FAILTX=$($CAST send "${A[@]}" "$PORTED" --value 0.01ether --gas-limit 60000 --json 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["transactionHash"])' || true)
OKTX=$($CAST send "${A[@]}" "$FIXED" --value 0.01ether --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["transactionHash"])')
echo "native send -> PortedVault (expected FAIL): $FAILTX"
echo "native send -> ArcVault    (expected OK):   $OKTX"

cat > deployments.json <<JSON
{ "chainId": 5042, "deployer": "$ME", "registry": "$REG", "ported": "$PORTED", "fixed": "$FIXED",
  "demoFailedTx": "$FAILTX", "demoOkTx": "$OKTX" }
JSON
cat deployments.json
echo "Remaining balance: $($CAST balance "$ME" --rpc-url $RPC --ether) USDC"
