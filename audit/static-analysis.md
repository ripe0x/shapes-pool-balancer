# Static analysis triage (discovery stage)

Command: `slither . --json audit/slither.json` at revision `0f017843ec333f499809f751e19017be325448e3` with Slither 0.11.5 and Foundry Solidity 0.8.28/via IR settings. Exit 255; 326 raw detector records. The JSON is retained at `audit/slither.json` (SHA-256 `ae003b6bfc0c727c9630559039f24756e274c5ed89e8de3f95099b6`). A detector is a lead, not a confirmed finding.

## Balancer-specific leads

| Detector | Sites | Initial triage and deciding evidence |
| --- | --- | --- |
| High `reentrancy-eth` | `_fillDeficit`, 798–835 | The ETH goes to the fixed Shapes address at line 815. Its `_safeMint` should call this Balancer's pure `onERC721Received`; the FWA `listNFTs` call precedes tracking writes. Verify fixed dependency implementations and callback graph on the fork; do not dismiss solely because of the local `nonReentrant` guard. |
| Medium `reentrancy-no-eth` | `updateCuratedPrice`, 365–377; `_reprice`, 728–742 | `pool.updatePrice` precedes the tracked price write. Need FWA verified source/fork evidence that this call cannot reach an attacker callback, plus analysis of creator-callable unguarded entries if the creator is a contract. |
| Medium `divide-before-multiply` | `_payKeeper`, `_curatedTotals`, `_shapeTotals`, `_feasible` | The keeper calculation intentionally floors one fifth; check economic bound independently. Shape/curated rounding must match live FWA; `_checkpoint` separately reads live `acquisitionFee`, but a mismatch can affect plan selection or liveness. |
| Medium `unused-return` | FWA listing/acquisition reads, ENS setName | Partial tuple reads are purposeful, but listing identity and status assumptions need dependency validation. ENS return value has no local economic use; registrar can revert or lie about the record. |
| Medium `uninitialized-local` | `missing`, `sW`, `sWP`, `shapesListed`, `edgePaid` | Solidity local integers default to zero; no independent vulnerability from the detector. |
| Medium `incorrect-equality` | `_payKeeper` `reward == 0` | Exact zero is a control branch, not an oracle assumption; no independent vulnerability from the detector. |
| Low `missing-zero-check` | factory/implementation constructors, `transferCreator(0)` | The production deployment path supplies fixed nonzero addresses; arbitrary third-party factory deployments are outside the frozen factory deployment. Zero pending creator can cancel a transfer. Check initialization behavior, rather than using this detector as a finding. |
| Low `calls-loop` | bounded FWA, Shapes and ERC721 calls | The local limits are 5 draw reconciliation, 6 upkeep operations, 20 curated batch/unwind, 100 active listings, 9 denomination iterations. Verify gas/liveness at those bounds, including hostile ERC721 calls. |
| Low reentrancy/event leads | initialization, list, upkeep, ENS, retire, close | Evaluate actual external call recipient and callback sender. `nonReentrant` applies to fund/asset mutators, but creator operations such as `configure`, `open`, `close`, role transfer and ENS/page approval remain callback-reachable if the external recipient is also the creator. |

Most of the 326 records concern Solady library assembly, naming, formatting or generic arithmetic. Those are not Balancer findings without a reachable effect. Slither itself invoked `forge clean`, removing the previous build cache before compiling; the full run and exit are retained in the run record.

## Informed disposition after discovery seal

- The High `_fillDeficit` reentrancy lead did not yield a Shape mint callback that can mutate Balancer custody: the inspected pinned Shapes source safe-mints to Balancer's pure `onERC721Received`, and `performUpkeep` holds the Balancer guard. The fork probe minted/redeemed actual Shapes, the selected existing `test_gasGriefingCollectionCannotTaxUpkeep` passed, and the guided campaign refilled 128 drawn Shapes. This is **not** proof against arbitrary future Shapes code or every callback ordering.
- The Medium FWA `updatePrice` reentrancy lead did not show a hostile collection call from FWA's price update in the inspected source. However, a separate **unguarded creator `configure` callback** from curated `transferFrom`/`approve` was independently demonstrated and is reported as F2. This illustrates why static detector output alone was not the finding boundary.
- The integer `divide-before-multiply` sites were compared to FWA's integer fee/weight math and tested at reserve/keeper boundaries. The gas reimbursement's 4/5 floor is deliberate and follows EIP-3529's one-fifth transaction refund cap. No specific overflow or profitable rounding sequence was demonstrated. This is bounded by the pinned 500-bps edge and examined values.
- The remaining High/Medium detector records have **not** each been mapped to a path and executable postcondition in the schema-2 manifest. The target-focused table above is triage by category, not a completed 326-record adjudication. The structural gate remains incomplete.
