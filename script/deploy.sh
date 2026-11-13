#!/usr/bin/env bash
# The deploy entry point for mainnet and for rehearsal.
# Usage: PACKS_ADMIN=0x.. KEEPER_ADMIN=0x.. script/deploy.sh --rpc-url <url> <signer flags> [--broadcast] [--verify]
# Every argument goes to `forge script script/Deploy.s.sol`. Signer: --account <keystore>, --ledger, or --unlocked on a
# local fork. Never pass a private key.
set -euo pipefail
cd "$(dirname "$0")/.."
# Asset-flow gate: every deployment through this script stops here unless it passes. No bypass flag.
GATE=/Users/dd/.agents/guidance/asset-flow-kit/asset_gate.py
[[ -f "$GATE" ]] || { echo "asset gate missing at $GATE; refusing to deploy." >&2; exit 1; }
python3 "$GATE" "$PWD" || { echo "asset gate not PASS (exit $?); refusing to deploy." >&2; exit 1; }
# read by Deploy.s.sol, which refuses chain id 1 without it (a hand-set variable defeats it)
export ASSET_GATE_PASSED=yes
exec forge script script/Deploy.s.sol "$@"
