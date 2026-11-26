# Creator-fee v2 mainnet preparation

**Unsigned, no broadcast authorized or performed.** Code candidate `e47fdef`; source/evidence digest `58c252dd452c6c54b2b91694ed6c25e52f65eb9face0725d6ba1b88461c0596b`. [Focused evidence](receipts/focused-v2-release/README.md) preserves original failures, repairs, measurements and limits. [Signature packet](receipts/focused-inventory-update/OWNER-SIGNATURE.md) includes exact commands. Local creator UI transaction approval remains pending; do not call this ready for production execution until it is completed or the owner explicitly accepts that gap.

## Deployment decision

Read-only Tenderly checks at mainnet block **26496902** found:

| Item | Observed value |
| --- | --- |
| Current factory | `0x6F018fF718Ab5A4287F937e4e4729Aa65610f53b` |
| Current implementation | `0xfEBaFdbFf526afb2bE2DCCedcb740962B5E91089` |
| Policy / keeper admin | `0xCB43078C32423F5348Cab5885911C3B5faE217F9` |
| Creation pause | Getter reverts; immutable factory has no pause capability |
| Current-factory pools | 0, scanned from 26489613 to 26496902 |
| RIPE signer | EIP-7702 delegated account; nonce 4249; 0.173661172256497776 ETH at the checked block |
| Reused dependencies / packaged legacy scans | PASS; no mismatches |

**Deploy a new factory and v2 implementation, reusing the existing FWA, Shapes, Packs and renderer.** This is required to include R112's creation pause. A pointer switch on the old factory would give only new clones v2 accounting and omit the pause. Existing pools stay on their fixed implementations; no NFT or ETH migration is automatic. Changed linked libraries deploy via canonical CREATE2 as needed. New factory starts publicly paused, allowing the policy admin's own canary.

The observed nonce, balance, pool count and addresses are readbacks, not future transaction commitments. Re-read at execution; obtain exact deployment addresses, count, calldata and gas from the dry run. Keep the existing factory operational for its pools. A new current-factory pool appearing before cutover needs its deployed ABI retained and inclusion in legacy discovery/keeper coverage.

## After UI acceptance, signature, and owner-authorized merge

R110 requires the main checkout on `main`, fast-forwarded to `origin/main`. A local commit grants no remote authority. The PR/merge remains for owner approval. Check that main contains the candidate and the public outcome signature; stop on a source digest mismatch. Do not reset unrelated work or switch this dirty checkout automatically.

```bash
cd /Users/dd/CascadeProjects/fwa-pool-balancer
export RPC=https://mainnet.gateway.tenderly.co
export DEPLOYER=0xCB43078C32423F5348Cab5885911C3B5faE217F9
export PACKS_ADMIN=$DEPLOYER KEEPER_ADMIN=$DEPLOYER POLICY_ADMIN=$DEPLOYER
export REUSE_DEPENDENCIES=true
unset IMPLEMENTATION_ONLY EXISTING_FACTORY EXPECTED_IMPLEMENTATION NEW_IMPLEMENTATION
(
set -eu
[ "$(git branch --show-current)" = main ]
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ]
python3 "$HOME/.agents/guidance/asset-flow-kit/asset_gate.py" . --config asset-flow-focused.json --no-run --require-review
node --import tsx scripts/deployment-preflight.ts --rpc-url https://mainnet.gateway.tenderly.co --out deployments/1.creator-fee-v2.preflight.json
cast chain-id --rpc-url https://mainnet.gateway.tenderly.co
cast nonce "$DEPLOYER" --rpc-url https://mainnet.gateway.tenderly.co
cast balance "$DEPLOYER" --rpc-url https://mainnet.gateway.tenderly.co --ether
cast base-fee --rpc-url https://mainnet.gateway.tenderly.co
)
```

Require chain 1, gate PASS, preflight `ok: true`, sufficient balance, and no unexplained pending nonce. The new-factory route does not call `setImplementation` on `0x6F018...`. Do not set the marker `ASSET_GATE_PASSED` yourself.

Warm deployment artifacts only if absent; the existing canonical local deployment at source `213a6ab` and unchanged size evidence remain valid. Never clear caches. The focused wrapper stops and prints a targeted build command if test artifacts are ABI-only.

Dry run through the same production wrapper, **without broadcasting**:

```bash
(
set -eu
[ "$(git branch --show-current)" = main ]
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ]
script/deploy.sh --rpc-url https://mainnet.gateway.tenderly.co --account ripe0x --sender "$DEPLOYER" --slow
cp broadcast/Deploy.s.sol/1/dry-run/run-latest.json deployments/1.creator-fee-v2.reviewed-dry-run.json
shasum -a 256 deployments/1.creator-fee-v2.reviewed-dry-run.json
)
```

Review its decoded library creations, implementation dependencies, factory constructor, all zero native values, signer/nonces and estimated gas. Set a concrete max-fee/gas allowance for the exact action. At this point obtain immediate owner broadcast approval with that digest, predicted addresses and consequences. Deployment and later public unpause are separate approvals. R83 explicitly declined a mainnet canary for this launch; this packet does not reinstate one. The keystore handles signing; do not put keys/passwords in command literals.

The subsequent authorized deployment uses the same wrapper/arguments with `--broadcast --verify` and sequential `--slow`. Its exact fee cap is chosen against fresh fees and the reviewed allowance, not a stale number in this document. Reconcile partial receipts/nonces before any retry, never blindly rerun deployment. No broadcast command is executable from this unsigned packet alone.

Copy the actual broadcast file to `deployments/1.creator-fee-v2.broadcast.json`, then verify against the approved dry-run digest:

```bash
node --import tsx scripts/verify-deployment.ts --rpc-url https://mainnet.gateway.tenderly.co \
  --reviewed-dry-run deployments/1.creator-fee-v2.reviewed-dry-run.json \
  --reviewed-dry-run-sha256 "$DRY_SHA" \
  --broadcast deployments/1.creator-fee-v2.broadcast.json \
  --out deployments/1.creator-fee-v2.verified.json
```

`DRY_SHA` is the exact SHA-256 approved immediately before broadcast. Require `DEPLOYMENT VERIFIED`, canonical mined receipts, runtime/dependency checks and `creationPaused() == true`. A simulation's generated `deployments/1.json` is not deployment evidence.

## Paused deployment, then public cutover

1. Read the new implementation marker `profitAccountingVersion() == 2`, its locked owner, factory implementation/admin/settings, dependency hashes and paused state. Keep creation paused.
2. Reuse the existing fresh canonical local deployment rehearsal for unchanged runtime sources. It does not establish production inclusion or authentic live VRF delivery. R83 explicitly declines a mainnet canary for this launch; R112 makes the paused admin creation exception available but does not require exercising it. Do not silently add a canary, spending cap or unrelated audit campaign.
3. Before public opening, configure the app and keeper from the verified factory address and receipt block; retain existing factories/ABIs for discovery and service. R108 keeper settings stay `MAX_LOSS_WEI=0`, `MAX_GAS_PRICE_GWEI=1.5`, with existing alerting and owner-managed signer secrets. New factory constructor economics remain the reviewed source defaults; any subsequent settings transaction requires its own decoded approval.
4. Scan all prior factories, including `0x6F018...`, again at a block after deployment. Validate coverage of any pool created during cutover. Resolve deployment/readback or coverage failures before public unpause. Request explicit approval for `setCreationPaused(false)` on the verified new factory, zero ETH, by the policy admin. No global pause or migration exists for immutable old factories.
5. Public service cutover, pushes/merges, funding and mainnet transactions remain owner-authorized actions. Do not retire old pool management merely because the new factory is selected.

Things that don't make sense: an implementation-only switch cannot add an immutable factory's pause; a current zero-pool scan cannot prove no pools will be created during cutover; the focused gate cannot certify the separate campaign or live oracle/service operation.
