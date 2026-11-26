#!/usr/bin/env bash
# The deploy entry point for mainnet and for rehearsal.
# Usage: PACKS_ADMIN=0x.. KEEPER_ADMIN=0x.. POLICY_ADMIN=0x.. script/deploy.sh --rpc-url <url> <signer flags> [--broadcast] [--verify]
# IMPLEMENTATION_ONLY=true REUSE_DEPENDENCIES=true EXISTING_FACTORY=0x.. EXPECTED_IMPLEMENTATION=0x.. deploys only the replacement.
# A separately confirmed switch uses --sig "switchImplementation()" and NEW_IMPLEMENTATION; never part of run().
# Every argument goes to `forge script script/Deploy.s.sol`. Signer: --account <keystore>, --ledger, or --unlocked on a
# local fork. Never pass a private key.
set -euo pipefail
cd "$(dirname "$0")/.."
# The explicit local route accepts only a reviewed, hash-bound plan for the owned isolated fork.
if [[ "${1:-}" == "--local-rehearsal-plan" ]]; then
    [[ $# -ge 5 && "${3:-}" == "--approved-plan-hash" ]] || { echo "local rehearsal requires a plan and approved hash" >&2; exit 1; }
    local_plan="$2"
    local_hash="$4"
    shift 4
    node --import tsx scripts/local-rehearsal-gate.ts --plan "$local_plan" --approved-plan-hash "$local_hash" --phase deploy -- "$@"
    # Local approval must never mint the mainnet gate marker, even if inherited from the shell.
    unset ASSET_GATE_PASSED
    exec forge script script/Deploy.s.sol "$@"
fi
# Existing-node interactive playground; its own exact packet cannot authorize any production action.
if [[ "${1:-}" == "--local-playground-plan" ]]; then
    [[ $# -ge 5 && "${3:-}" == "--approved-plan-hash" ]] || { echo "playground requires exact approved plan" >&2; exit 1; }
    playground_plan="$2"
    playground_hash="$4"
    shift 4
    node --import tsx scripts/local-playground.ts --gate "$playground_plan" --approved-plan-hash "$playground_hash" -- "$@"
    unset ASSET_GATE_PASSED
    exec forge script script/Deploy.s.sol "$@"
fi
# Existing factory implementation replacement on the preserved 8545 playground only.
if [[ "${1:-}" == "--local-implementation-plan" ]]; then
    [[ $# -ge 5 && "${3:-}" == "--approved-plan-hash" ]] || { echo "implementation update requires exact reviewed plan" >&2; exit 1; }
    implementation_plan="$2"
    implementation_hash="$4"
    shift 4
    node --import tsx scripts/local-implementation-update.ts --gate "$implementation_plan" --approved-plan-hash "$implementation_hash" -- "$@"
    unset ASSET_GATE_PASSED
    exec forge script script/Deploy.s.sol "$@"
fi
# Historical 2026-11-18 protected-revenue candidate route (scripts/current-local-rehearsal.ts): never an archived
# approval, and not evidence for the community release (its scenario calls the removed setKeeperPolicy).
if [[ "${1:-}" == "--current-local-rehearsal-plan" ]]; then
    [[ $# -ge 5 && "${3:-}" == "--approved-plan-hash" ]] || { echo "current rehearsal requires its exact frozen plan and hash" >&2; exit 1; }
    current_plan="$2"
    current_hash="$4"
    shift 4
    node --import tsx scripts/current-local-rehearsal.ts --plan "$current_plan" --approved-plan-hash "$current_hash" --phase deploy -- "$@"
    unset ASSET_GATE_PASSED
    exec forge script script/Deploy.s.sol "$@"
fi
for argument in "$@"; do
    case "$argument" in
        --local-rehearsal-plan*|--current-local-rehearsal-plan*|--local-playground-plan*|--local-implementation-plan*|--approved-plan-hash*) echo "local gate flags must precede Forge arguments" >&2; exit 1 ;;
    esac
done
# Owner-authorized inventory-update gate; the full economic campaign remains in asset-flow.json.
# Production still requires the focused outcome signature and exact-source independent review.
GATE="$HOME/.agents/guidance/asset-flow-kit/asset_gate.py"
[[ -f "$GATE" ]] || { echo "asset gate missing at $GATE; refusing to deploy." >&2; exit 1; }
python3 "$GATE" "$PWD" --config asset-flow-focused.json --require-review || { echo "asset gate not PASS (exit $?); refusing to deploy." >&2; exit 1; }
# read by Deploy.s.sol, which refuses chain id 1 without it (a hand-set variable defeats it)
export ASSET_GATE_PASSED=yes
exec forge script script/Deploy.s.sol "$@"
