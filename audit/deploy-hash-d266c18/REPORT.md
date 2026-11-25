# Independent review — Deploy.s.sol postflight creation-settings-hash (d266c18)

## Scope
One-line change in `script/Deploy.s.sol` (`git diff 920c586 d266c18`): the postflight's
independent reconstruction of `BalancerFactory.creationSettingsHash()` now appends
`address(impl)` to the `abi.encode`, matching the `implementation` field that PR #54
(920c586, audit/settable-impl-ab60c4b) bound into the on-chain hash. The mainnet dry run
had reverted at `_postflight` with "creation settings hash" because the script's formula
lacked that field. Nothing was broadcast. Review only; no commits, pushes or transactions.

## Method
- Read `src/BalancerFactory.sol` `creationSettingsHash()` and the storage field widths.
- Compared field order and ABI encoding against the script formula.
- Searched `script/ scripts/ sim/ keeper/ test/` for any other independent copy of the formula.
- Ran the Deploy simulation (no broadcast) against the running local anvil fork (chain 31337).

## Findings

1. Formula matches the contract exactly.
   - Contract (`src/BalancerFactory.sol:138-141`):
     `keccak256(abi.encode(settingsHash(_economics, FOLLOW, 0, true, mintFee), defaultBucketCapacity /*uint128*/, defaultBucketRefill /*uint96*/, implementation /*address*/))`
   - Script (`script/Deploy.s.sol:140-141`):
     `keccak256(abi.encode(KeeperPolicyCalls.settingsHash(e, FOLLOW, 0, true, impl.SHAPES().mintFee()), uint256(0.622 ether), uint256(0.05 ether)/12, address(impl)))`
   - Field order identical: settingsHash, capacity, refill, implementation.
   - uint256 vs uint128/uint96 is safe: `abi.encode` pads every integer to one 32-byte,
     left-zero-padded word, so for the same numeric value a uint256, uint128 and uint96
     produce identical words. 0.622 ether (6.22e17) fits uint128; 0.05 ether/12 (4166666666666666)
     fits uint96. The stored factory values equal these literals (independently asserted at
     lines 134-135), so the encoded words coincide bit-for-bit.
   - `address(impl)` equals the factory's `implementation` (asserted at line 128). The `e`
     and `mintFee` inputs are the same values the postflight already pins (lines 132-133, 146).

2. Postflight still independently checks every other value. The diff is a single line; all
   other `require`s (lines 128-137, 144-149: wiring, admins, economics struct, bucket
   capacity/refill, product limits, impl lock, packs wiring, pack minimum, code present)
   are unchanged and still reconstruct their expected values independently of the constructor.

3. No other stale copy of the formula.
   - `scripts/verify-deployment.ts:45-56` is the only other independent reconstruction; it
     already encodes `'bytes32, uint128, uint96, address'` with `[pool, bucketCapacity,
     bucketRefill, implementation]`, so it is current (uint128/uint96 widths match the contract).
   - Every other reference in `script/ scripts/ sim/ keeper/ test/` reads the live
     `factory.creationSettingsHash()` rather than recomputing it, so none can drift.

4. Simulation. `KEEPER_ADMIN=POLICY_ADMIN=PACKS_ADMIN=0x172E… forge script script/Deploy.s.sol
   --rpc-url http://127.0.0.1:8545 --sender 0x172E…` printed "Script ran successfully."
   `run()` invokes `_postflight`, so the creation-settings-hash assertion executed against the
   freshly deployed factory and did not revert. (Full mode on 31337: packs created; the
   fork was neither started, stopped nor reset.)

## Economic pass
Deploy-time verification only. The change adds an address to a hash reconstruction used in a
postflight `require`; it moves no asset, fee, payment or reserve. Bucket capacity (0.622 ether),
refill (0.05 ether/12), the economics struct and product limits are untouched. The implementation
was already part of the on-chain `creationSettingsHash` since PR #54; this only teaches the
script's independent copy to match. No approved outcome number changes.

## Verdict
PASS. No blocking finding.

## Things that don't make sense
None.
