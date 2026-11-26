# Focused version 2 approval packet

**Signed and verified; committed as `9d0e79d`.** Contract checks, scorecards and independent review bind the current version 2 candidate. [Local creator-fee UI transaction acceptance](../focused-v2-ui/README.md) is now complete. No repeat signature is needed while the approved configuration and reviewed source remain unchanged. No mainnet transaction, public unpause or service cutover is authorized by an outcome signature.

Source/evidence digest: `58c252dd452c6c54b2b91694ed6c25e52f65eb9face0725d6ba1b88461c0596b`.
Approval/configuration digest: `5acc93973dcad11c81c9945851f85ddd62ea24a1ebea2f55264e7528331f4d3f`.
This supersedes the unsigned `191c4b69...` packet. Outcomes I1–I6 and their amounts are unchanged; the signed command/evidence now includes the v2 genuine-proof and fee regressions and a missing-bytecode check.

| Decision / option | Measured numbers and tradeoff | Recommendation |
| --- | --- | --- |
| Retain the already selected focused update scope (R113) | 46 focused contract tests; 2 NFT return; 1 WETH return; 1 ETH reference principal returned; paused admin canary .1 ETH returned; public refusal moves 0; all three reference leftovers/losses 0 | Already signed; the local UI interaction is now verified. It addresses changed flows without claiming the separate full campaign. |
| Defer signature/deployment | No production change; existing pools remain immutable and gain no v2 fee/reinvestment methods | Use if the bounded evidence/remaining limitations are unacceptable. No need to reconsider accepted pool settings or refund policy. |

Version 2 regressions additionally reach actual .066278634547026369 ETH owner receipts, 1067 bps allocation, .007071930306167713 ETH fees, and a separate .097190194207004119 ETH operating loss. Gross fees can coexist with losses. Deposits create 0 earnings; reinvestment moves 0 ETH and increases capital exactly as fees decrease; short reserve permits 0 withdrawal. These requirements remain R118–R121; I1–I6 are reference roundtrip metrics, not a new profitability promise.

Measured 20-item reprice raw EVM gas: 1,574,319; withdrawal: 2,085,973. Separate conservative transaction/calldata checks remain below 16,777,216 gas. Balancer runtime: 24,438 bytes, only 138 bytes spare. Caller gas is separate from principal-return outcomes.

[Evidence and limits](../focused-v2-release/README.md), [independent review](../../../audit/inventory-update-b44e35f/creator-fee-v2-20261125/REPORT.md), [production preparation](../../MAINNET-CREATOR-FEE-V2.md).

## Owner signing commands

Retained for reproducibility; already completed. No need to run again. Uses the existing owner SSH key; never send its private contents or password.

```bash
cd /Users/dd/CascadeProjects/fwa-pool-balancer
SIGN_DIR=$(mktemp -d /tmp/fwa-focused-sign.XXXXXX)
printf %s 5acc93973dcad11c81c9945851f85ddd62ea24a1ebea2f55264e7528331f4d3f > "$SIGN_DIR/outcomes.txt"
ssh-keygen -Y sign -f "$HOME/.ssh/asset_flow_owner" -n asset-flow "$SIGN_DIR/outcomes.txt"
python3 - "$SIGN_DIR/outcomes.txt.sig" <<'PY'
import datetime, importlib.util, json, sys
p = 'asset-flow-focused.json'
c = json.load(open(p))
s = importlib.util.spec_from_file_location('gate', '/Users/dd/.agents/guidance/asset-flow-kit/asset_gate.py')
gate = importlib.util.module_from_spec(s); s.loader.exec_module(gate)
assert gate.outcomes_hash(c) == '5acc93973dcad11c81c9945851f85ddd62ea24a1ebea2f55264e7528331f4d3f'
assert gate.src_hash('.', c) == '58c252dd452c6c54b2b91694ed6c25e52f65eb9face0725d6ba1b88461c0596b'
signature = open(sys.argv[1]).read()
c['approval'] = {'date': datetime.date.today().isoformat(), 'outcomes_sha256': gate.outcomes_hash(c), 'signature': signature}
assert gate.signature_problem(c['approval'], gate.outcomes_hash(c)) is None, 'Signature must match the existing allowed owner key'
open(p, 'w').write(json.dumps(c, indent=2) + '\n')
PY
python3 "$HOME/.agents/guidance/asset-flow-kit/asset_gate.py" . --config asset-flow-focused.json --no-run --require-review
```

Only proceed when the final command prints PASS. Commit the public signature change before the reviewed candidate is merged to main. Push/merge and mainnet writes each retain their existing owner authorization. The production wrapper reruns the full focused command; the no-run readback reuses evidence and is not substituted for that production enforcement.

Things that don't make sense: neither an SSH signature nor a gate PASS proves safety or authorizes production broadcasts. The separate local UI transaction evidence is now complete.
