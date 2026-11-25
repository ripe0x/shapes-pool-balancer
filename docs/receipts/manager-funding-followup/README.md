# Main manager funding ABI follow-up

Main candidate: `ripe0x/shapes-fwa-pool@1bbe54c`. Its cash-funding correction adds the derived
`fundingDeficit(bool)` view. The generated ABI preserves every existing entry and adds only
that view to PackManager and PackVault. Community ABIs, contracts, routes, settings and launch
switches are unchanged. No live application cutover occurred.

`SHAPES_FWA_POOL=/Users/dd/CascadeProjects/shapes-fwa-pool-completion node scripts/export-main-pool-abi.mjs --check`
passes. `npm run typecheck` and `npx vitest run app/src/main-manager-exit.test.ts app/src/main-pool-settings.test.ts`
pass, 14 tests. Existing actual browser-flow evidence retains its original revision; this additive
unused view changes no interaction. Main current-source fork receipts independently prove the
owner-paid CLI exit with zero keeper budgets and no account topups.

The old −28.5% return figure is withdrawn. The corrected paired backing study and final numerical
review remain pending. Keep this PR draft and both public main launch switches false.

Things that don't make sense: treating preserved old return figures as current economic evidence.
