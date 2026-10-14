#!/usr/bin/env bash
# Finishes deploy.sh after the RPC error: Breadchain record + the two live demo sends.
set -uo pipefail
cd "$(dirname "$0")/.."
CAST=~/.local/bin/arc-cast; RPC=https://rpc.mainnet.arc.io
REG=0x966Bf58DB6F257C63Edb11bF006B5eB3160721DE
PORTED=0xA8Bd8C8F580d5f00cEF41bfA524555de17E3B38F
FIXED=0x8f7349Dc451DFbC6B3773b49e33fa836b89C71f3
ME=0x5e73b0cad666881aacf8f99d64fdba251676b0df
read -rsp "Keystore password for 'preflight': " PW; echo
PWF=$(mktemp); printf '%s' "$PW" > "$PWF"; trap 'rm -f "$PWF"' EXIT
A=(--rpc-url "$RPC" --account preflight --password-file "$PWF" --async)
st() { sleep 3; $CAST receipt "$1" status --rpc-url "$RPC" 2>&1; }

H1=$($CAST send "${A[@]}" "$REG" "record(address,uint32,uint32)" 0x0970462cece33d425dba716cbf4855bb4f44fcf5 1 0)
echo "record breadchain: $H1 $(st $H1)"
FAILTX=$($CAST send "${A[@]}" "$PORTED" --value 0.01ether --gas-limit 60000)
echo "native 0.01 -> PortedVault (expect failed): $FAILTX $(st $FAILTX)"
OKTX=$($CAST send "${A[@]}" "$FIXED" --value 0.01ether --gas-limit 80000)
echo "native 0.01 -> ArcVault (expect success):  $OKTX $(st $OKTX)"
cat > deployments.json <<JSON
{ "chainId": 5042, "deployer": "$ME", "registry": "$REG", "ported": "$PORTED", "fixed": "$FIXED",
  "demoFailedTx": "$FAILTX", "demoOkTx": "$OKTX" }
JSON
echo "Remaining: $($CAST balance $ME --rpc-url $RPC --ether) USDC"
