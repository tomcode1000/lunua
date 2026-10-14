#!/usr/bin/env bash
# Runs Lunua's generated Foundry reproductions against an Arc mainnet fork with Arc Foundry.
set -e
cd "$(dirname "$0")/../repro"
mkdir -p src lib
[ -d lib/forge-std ] || git clone -q --depth 1 https://github.com/foundry-rs/forge-std lib/forge-std
SOLC=$(pwd)/solc-0.8.30; [ -x "$SOLC" ] || chmod +x "$SOLC"
cp "$SOLC" /tmp/solc-0.8.30 && chmod +x /tmp/solc-0.8.30
~/.local/bin/arc-forge test --network arc --use /tmp/solc-0.8.30 --offline -vv 2>&1 | tail -45
