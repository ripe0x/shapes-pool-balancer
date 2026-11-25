# Main manager funding ABI follow-up

Main implementation candidate: `ripe0x/shapes-fwa-pool@1bbe54c`; app ABI revision: `1330b18`.
Its cash-funding correction adds the derived `fundingDeficit(bool)` view. The generated ABI preserves every existing entry and adds only
that view to PackManager and PackVault. Community ABIs, contracts, routes, settings and launch
switches are unchanged. No live application cutover occurred.

`SHAPES_FWA_POOL=/Users/dd/CascadeProjects/shapes-fwa-pool-completion node scripts/export-main-pool-abi.mjs --check`
passed at the recorded app ABI revision. `npm run typecheck` and
`npx vitest run app/src/main-manager-exit.test.ts app/src/main-pool-settings.test.ts`
also passed there, 14 tests. These existing checks were not rerun for this documentation closeout.
Existing actual browser-flow evidence retains its original revision; this additive unused view
changes no interaction. Main current-source fork receipts independently prove the
owner-paid CLI exit with zero keeper budgets and no account topups.

Manager engineering closeout is complete within the recorded focused validation and compatibility
scope. The main economic assessment remains bounded to real funding, accounting and round-trip
cost evidence; it establishes no monthly return forecast or production recommendation. The old
−28.5% return figure is withdrawn. The corrected paired backing study stopped incomplete; its
agent-selected 49,152 scenarios are not an owner-required acceptance condition, and its partial
results support no return conclusion. Keep this PR draft and both public main launch switches false.
No public transaction, live cutover, merge, deployment approval or acceptance signature is included.

## Operating evidence follow-up, 2026-11-25

The main repository now also has authenticated billed renewal/reuse and fee-change samples,
paid listing size measurements, a current production-image factory/restart/owner-exit rehearsal,
and refreshed unsigned manager-only deployment data. See the main draft PR's
[operating verification](https://github.com/ripe0x/shapes-fwa-pool/blob/codex/main-pool-completion/docs/receipts/manager-operating-verification.md)
and [economic assessment](https://github.com/ripe0x/shapes-fwa-pool/blob/codex/main-pool-completion/docs/receipts/manager-operating-economics.md).
Those records preserve their actual source revisions, assumptions and remaining limits; they do
not make an older UI receipt a new operating-return observation.

The ABI/default non-writing check above passed again against the unchanged main runtime on
2026-11-25. This follow-up changes documentation only. The fourteen existing affected tests and
actual preview evidence retain their original revisions; typechecking, building and UI rehearsal
were not repeated for unchanged interaction code. Community contracts, deployment selection,
legacy routes and keeper integration remain untouched. The replacement shared vault remains
undeployed and both main public launch switches remain false. Both PRs stay draft.

Things that don't make sense: treating preserved old return figures as current economic evidence.
