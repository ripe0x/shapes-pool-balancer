#!/usr/bin/env bash
set -euo pipefail

main_checkout=/Users/dd/CascadeProjects/fwa-pool-balancer
fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ "$(pwd -P)" == "$main_checkout" ]] || fail "Run only from $main_checkout."
[[ "$(git rev-parse --show-toplevel)" == "$main_checkout" ]] || fail "Not the main checkout."
[[ "$(git branch --show-current)" == main ]] || fail "The main checkout must be on main."
git diff --quiet && git diff --cached --quiet || fail "Tracked changes must be committed before deployment."
: "${KEEPER_APP:?Set the public Fly app name.}"
: "${KEEPER_ADDRESS:?Set the keeper public address.}"
: "${KEEPER_RELEASE:?Set the reviewed full commit hash merged into origin/main.}"
[[ "$KEEPER_APP" =~ ^[a-z0-9][a-z0-9-]+$ ]] || fail "Invalid Fly app name."
[[ "$KEEPER_ADDRESS" =~ ^0x[0-9a-fA-F]{40}$ ]] || fail "Invalid keeper public address."
[[ "$KEEPER_RELEASE" =~ ^[0-9a-f]{40}$ ]] || fail "KEEPER_RELEASE must be a full commit hash."

git fetch origin main
git merge --ff-only origin/main
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] || fail "main must exactly match origin/main."
[[ "$(git rev-parse HEAD)" == "$KEEPER_RELEASE" ]] || fail "origin/main differs from the reviewed release."
git diff --quiet && git diff --cached --quiet || fail "Tracked changes appeared during preparation."

machine_count=$(fly machines list --app "$KEEPER_APP" --json | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')
[[ "$machine_count" -le 1 ]] || fail "Expected at most one Machine. Reconcile the existing signer processes before deploying."

printf 'Deploying keeper commit %s to %s for public signer %s\n' "$KEEPER_RELEASE" "$KEEPER_APP" "$KEEPER_ADDRESS"
exec fly deploy . --config keeper/fly.toml --app "$KEEPER_APP" --env "KEEPER_EXPECTED_ADDRESS=$KEEPER_ADDRESS" --ha=false --strategy rolling --max-concurrent 1 --remote-only
