# Round 8 restricted-keeper UI preview attempt

Target production revision: `2ac7a7e7b965d1798729068566c026128a4ba4b9`. This was a separate post-seal attempt to verify the creator-facing restricted-keeper status/button in a visible app preview. **No UI interaction was executed.** The source-inferred issue and the real-fork creator authorization proof remain as stated in the sealed informed report; this attempt adds no visual confirmation.

## Exact blocker

- At 2026-11-12 17:14 UTC, `cua.getState()` returned `browsers: []`. It listed the Arc native app, but no connected browser surface or tab. The computer-use workflow grants native browser apps read-only access; it does not authorize navigation/clicking through Arc as a substitute for a connected browser tool.
- `cua.createBrowserTab('iab', 'about:blank', { visible: false })` returned exactly `Browser is not available: iab`. The built-in-browser skill also states that its pane cannot open shell-hosted localhost servers. Thus a Vite/Anvil preview started in this shell would not be accessible through the available browser surface.
- `lsof -nP -iTCP:5199 -sTCP:LISTEN` showed no Vite listener. `lsof -nP -iTCP:8545 -sTCP:LISTEN` showed an **existing** Anvil process (PID 16812), which was preserved and untouched. No new fork, deployment, app server, wallet connection or screenshot was made after the browser blocker was established.

The prior on-chain fork case `audit/round8/integration/informed/restricted_creator.output` proves a creator can run upkeep when the factory restricts keepers and does not approve the Balancer contract. The UI conclusion still comes only from `app/src/App.tsx:63-64,88,191-209,337-375`: its status probe uses the Balancer as caller, and admission-0 status/secondary button depend on that result. Admission statuses 2 and 6 render an upkeep action independently, so the unresolved visual case is specifically the open-state status/action. No claim is made about what a real connected wallet displayed.

## Scope and time

No files outside `audit/round8/integration/ui-validation/` were edited for this attempt; sealed informed SHA-256 remains `1deb2bfb1343fc5520fa84168ec2141b4c817a5ad7fe6298ba11beb7b876befe`. The assessor lane began 2026-11-12 15:39:50 UTC and stopped this attempt at 17:15:18 UTC: **1 hour 35 minutes 28 seconds** total elapsed, below the 2-hour ceiling. This is a tooling blocker, not a passing UI test.
