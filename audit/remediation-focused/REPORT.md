# Focused remediation source review

Date: 2026-11-17. Baseline: `2ab49fdbe7a6b11fe4da7e1f093a0dc20fb1fe94`.

This is an independent, source-only security and economic review of the affected Solidity flow. It is not a full candidate audit, a release approval, or evidence that all defects are absent. No gate review seal or `SOURCE_HASH` file is created.

## Inputs and method

Reviewed the complete baseline diff for `src/PoolBalancer.sol`, `src/PoolInventory.sol`, `src/KeeperPolicyCalls.sol` and `src/interfaces/External.sol`, affected callers, owner requirements including R55–R58, and the permanent admission regressions in `test/SelectableInventory.t.sol:85`, `:108` and `:140`. Applied the adversarial security audit standard and holistic verification guidance. Initial discovery of the replaced staging queue's sync-only barrier preceded reading its implementation tests; later repair review was informed.

Final source SHA-256 values:

| File | SHA-256 |
| --- | --- |
| `src/PoolBalancer.sol` | `ce8814dfbd867f8e0481d219956845b760cde6129c353474e4338dd3e0799d66` |
| `src/PoolInventory.sol` | `793e74ca89c02a3a318b83182162132e5e460d88a34b7b8bb6532107153e144b` |
| `src/KeeperPolicyCalls.sol` | `ef5a39266f16b2590f5c9353b6de1378717f26353a6ba43a8430af7b11ced988` |
| `src/interfaces/External.sol` | `fa30810c2ceb604f13b2b271865b7cbc99eb8d331a692791fe22e17f6328d579` |

Read the supplied dependency source under `/private/tmp/fwa-audit-offchain-9b45/external/fwa-poolsv2/`: StandardPoolBuyback `0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7` and PoolFactory `0x8919814D825a5Af238cC04DE06b1C18c9eaA477C`. This lane did not independently establish complete deployed-bytecode/source correspondence or current live configuration.

Read-only commands: `shasum -a 256`, `git diff 2ab49fd --` for the four scoped source files, focused numbered source reads, and `git diff --check 2ab49fd --` for those files. Final hash and diff checks exited 0. No Forge, broad suites, RPC calls, protocol mocks, broadcasts, process changes or source edits were performed by this reviewer. The report is the only reviewer-authored file.

## Security result

No new actionable security defect was identified in the final affected source. This conclusion is bounded to the source arguments below and does not substitute for execution.

- `PoolInventory.admission:90–116` adds read-only count arithmetic, a conservative staged-Shape scalar, and FWA's actual public `reservedStagedCount`. `PoolBalancer.initialize:271–272` rejects an activation limit other than six. The interface getters match the actual factory's `uint16` activation limit and pool's `uint256` reserved count.
- All FWA active inventory is tracked at transaction boundaries: FWA admits owner-only inventory; the Balancer's mint/list, withdrawal and reconciliation paths update its records atomically. This subset invariant is necessary for the count argument below.
- The original per-item layout is retained. One uint256 `shapeStageUpper` is appended to `State`, which also shifts later Balancer storage. This is a changed prelaunch layout for newly deployed pools, not a compatible implementation upgrade for existing clones; no old-clone upgrade or migration is supplied. There is no per-item staging flag, queue, explicit cache synchronization, new activation wrapper or invented upkeep progress. Canonical upkeep compensation, atomic reward floors and payment caps are unchanged.
- `configure` retains creator authorization and the reentrancy guard. `validateTarget` preserves markup bounds, the 1–1,000 prize limit and all sixteen denomination counts. A uint256 already occupies exactly sixteen 16-bit counts; removing the former shift-by-256 check discards no representable input constraint.
- `recoverUntrackedNFT` retains creator authorization and the guard. Its fixed linked helper preserves zero-recipient rejection, FWA pool/factory protection, actual ownership verification, the ERC721 transfer selector and the creator-selected recipient.
- `unlistShapes` retains creator authorization, the guard and 1–20 batch validation. The linked helper preserves active membership checks, duplicate rejection, Shape/pack routing, FWA withdrawal to the Balancer, redemption to the Balancer, and accounting removal. The ETH event now measures the whole redemption batch; asset recipients are unchanged.
- Linked library addresses remain compiler-fixed execution targets. Creator-selected policies gain no delegatecall or other execution authority. `quoteKeeperReward` uses the existing bounded static policy call in the pool's caller context and returns zero when compensation is disabled. The view is an estimate, not payable-work authorization or a reward-floor promise.

## Economic result and admission proof

No new actionable economic defect was identified in the final affected source. The first 10% game allocation, creator markup share, surcharge accounting, `_collect`, reserve logic, prize backing and purchaser refund rights are unchanged by this patch.

Define `W` as tracked Shape weight, `M` as the maximum single Shape weight, `q` as issued minus reconciled sequences, `u` as unsettled sequences, `C` as tracked count minus FWA active count, floored at zero, `K` as FWA's current reserved staged count, and `U` as `shapeStageUpper`. Split inactive tracked records into already removed unreconciled records `R` and staged records `S`. Then `C = R + S`, `R <= q - u`, and `K <= S`.

All `K` existing reserved staged records belong to earlier canonical sequences, and activate before the first new sequence. That new sequence additionally reserves up to six unreserved staged records. Before it selects, at least `min(S, K + 6)` of the currently staged records therefore activate. Earlier outstanding sequences can remove at most `u` records. Therefore:

```text
unavailable <= R + max(0, S - K - 6) + u
            = max(R, C - K - 6) + u
            <= max(q, max(0, C - K - 6) + u)
```

Call that count bound `B = max(q, max(0, C - K - 6) + u)`. The second bound, `q + U`, counts all already removed and possible older-draw removals with `q`, then adds an upper bound on staged Shape/pack prizes. Both independently bound unavailable Shape count; therefore their minimum is also conservative:

```text
implemented unavailable = min(B, q + U)
```

The scalar invariant follows from the actual update paths. New clones start with zero inventory and `U = 0`. Only restocking creates tracked Shape/pack prizes; after tracking its `n` actual new prizes, it computes `min(U + n, listed Shape prizes)` (`PoolInventory.sol:275–280`). Both terms remain upper bounds on the actual staged Shape count. It clears only when FWA active count equals total tracked count, proving no tracked prize remains staged. Activation, removal and reconciliation without a decrement can only overestimate the staged count. Before curated listing, the same all-active proof clears stale uncertainty before NFT transfers or new curated staging (`:123–124`). Curated listing creates no Shape/pack prizes. The unused `_addActive` wrapper has no callers. Only the final scalar value is stored after restocking, avoiding a needless increment-then-clear storage cycle.

Each unavailable Shape weighs at most `M`; curated NFTs contribute zero Shape weight. The implemented subtraction is consequently conservative for **the first new sequence's selection**, while remaining at least the original `q * M` subtraction. If `U = 0`, the code returns the original `q` bound directly without reading extra FWA inventory counters. It does not guarantee the current pre-hook board or every subsequent draw in a newly purchased batch remains at 70%.

The supplied Factory source has a constant six activation limit (`PoolFactory.sol:81`), passes it to initialization (`:249`), and StandardPool copies it (`:689`). Its public `reservedStagedCount` (`StandardPool.sol:352`) increments only when reserving (`:882`) and decrements per reserved activation (`:900`). FWA reserves staging before requesting randomness (`:1378–1380`) and activates reserved batches on ready, expiry and timeout paths before advancing canonical order (`:1583–1599`). When idle it drains at least one six-record prefix before pricing a successful purchase. Relevant staged records are either reserved by older sequences or reserved atomically by the first new sequence, so they cannot be withdrawn (`:1007`). Later unreserved staged inventory is already excluded by the conservative count. Active withdrawal remains locked while draws are unsettled. The read-only hook and FWA reentrancy guard prevent an intervening mutation between its reads and reservation within a successful purchase; state changes before inclusion are evaluated afresh.

When all tracked inventory is active, `C = 0` and `q >= u`, so the result is exactly the original admission bound even if `U` is stale. The rejected queue design's sync-only barrier is absent. The permanent regressions explicitly check admission with four staged replacements, FWA's later reserved-prefix activation, unchanged Balancer reconciliation, and a subsequent actual purchase without another upkeep. A second regression creates twelve staged Shapes after three concurrent purchases, checks the fourth and fifth requests, expires the draws, asserts 0.32 ETH backing, then adds twenty-four curated NFTs after a new pending draw and checks purchases without a bookkeeping call. A third starts with twenty Shapes, stages twenty-four curated NFTs, checks four more concurrent requests and the expiry round trip with 0.20 ETH backing. This reviewer read those tests but did not execute them or claim their results.

### Source-derived flow scorecard

These are source bounds and destinations, not measured regime outcomes.

| Flow or case | Result and limitation |
| --- | --- |
| Twenty 0.01 ETH Shapes | Actual redeemable backing totals 0.20 ETH; staging changes selectability, not custody or backing. |
| Four activated replacements and five expired unreconciled draws | Original allowance is 15/20 = 75%; no cached staging survives to block it. |
| Target expanded from twenty to one hundred with eighty staged and one unsettled draw, none already reserved | `max(q, 80 - 0 - 6 + 1) = 75` unavailable records; only 25% remains in the conservative first-selection bound, so admission fails. |
| Thirty-two target Shapes, twelve staged, and three unsettled draws | Initially `q = u = 3`, `C = U = 12`, `K = 0`: `B = 9` leaves 23/32 = 71.875%. After the fourth request reserves six, `q = u = 4`, `K = 6`: `B = 4` leaves 28/32 = 87.5%, so the fifth concurrent request remains admissible. |
| Twenty Shapes and twenty-four staged curated NFTs after an all-active proof | `U = 0`; the original `q` bound applies. With four unsettled draws, 16/20 = 80% remains in that bound, rather than counting curated staging as lost Shapes. |
| Buyer acquisition payment | Remains FWA escrow until delivery or refund; Balancer collects only `ownerProceeds`. Refund credits and delivery escrow are not creator operating capital. |
| Creator operating fund | Funds actual minting and keeper transfers. No additional reserve, capital ratchet or sync compensation is introduced. |
| Scalar running cost | Successful restocks store one final scalar value; curated listing can clear it after an all-active proof. The creator bears maintenance compensation and their own listing gas. This lane did not measure the incremental gas or its share of creator margin. |
| Creator allocation | Existing current-board approximation remains. The universal source ceiling is 45% of collected owner proceeds; this is not a proven small drift tolerance or an owner-approved replacement for previous numeric outcomes. |
| Closeout | Existing unlisting, backing redemption and creator claims remain; FWA purchaser/protocol obligations remain separate. |

## Limits and things that do not make sense

Original curated-presence approximation is intentionally retained: a staged or unreconciled curated listing can still satisfy the old presence check. `U` can overestimate after activation or removal until an existing mutation observes the all-active proof; it does not understate actual staged Shapes. Mixed Shape/curated inactivity can therefore still cause conservative refusals while `U` remains nonzero. All-active boards always use the original bound, and curated-only staging following the all-active reset creates no new Shape deficit. Physical activation may still be needed; there is no explicit bookkeeping-only synchronization requirement. The scalar can reset and is not an asset or reserve ratchet.

This lane did not execute the regressions, check the final scalar/nonzero-scalar hook branches and extra reserved-count getter against the 100k runtime stipend, check final bytecode size, run full economic regimes or coalition attack accounting, validate gas/basefee inside transactions, or conduct a rehearsal/canary. Earlier canonical sequences must still become processable and be processed before a later sequence can select; the algebra gives no processing-time guarantee. No runtime fee, profitability, liveness-duration or release-readiness claim follows from this report. Lead-run evidence must supply those results separately.

Things that do not make sense: none beyond the explicitly retained approximation and conservative refusal limits above.
