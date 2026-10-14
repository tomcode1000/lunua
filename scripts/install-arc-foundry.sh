#!/usr/bin/env bash
set -e
V=v0.8.0-2
T=arc-foundry-$V-x86_64-unknown-linux-gnu.tar.gz
mkdir -p ~/arcf && cd ~/arcf
curl -sL -o "$T" "https://github.com/circlefin/arc-foundry/releases/download/$V/$T"
curl -sL -o "$T.sha256" "https://github.com/circlefin/arc-foundry/releases/download/$V/$T.sha256"
cat "$T.sha256"; sha256sum "$T"
tar -xzf "$T"
mkdir -p ~/.local/bin
for b in forge cast anvil; do
  f=$(find . -name "$b" -type f | head -1)
  cp "$f" ~/.local/bin/arc-$b
done
~/.local/bin/arc-forge --version
