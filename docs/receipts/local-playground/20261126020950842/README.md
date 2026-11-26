# Fresh local 8545 deployment

Owner R128 requested discarding the failed fork and redeploying. R129 requested a running keeper. This is local chain 31337 only; no mainnet transaction or production key was used. Saved prior-fork backups and receipts were preserved.

The fresh fork uses https://mainnet.gateway.tenderly.co at block 26485619. Anvil PID13432 is detached and persists current state every30seconds to /tmp/fwa-8545-fresh-current-state.json. App PID20512 serves http://127.0.0.1:5280/ with FROM_BLOCK26485620. Its previous26485861 scan start was beyond the new head; restarting with the fresh deployment block restored discovery.

Production Deploy.s.sol and the guarded wrapper deployed PoolPage, PoolInventory, PoolBalancer and BalancerFactory. All four successful receipts and runtime hashes were reconciled before finishing setup. The setup then failed because the DemoNFT artifact contained ABI only. The preserved failure is execution-failure.log. A targeted `forge build script/DevSetup.s.sol --no-cache` exited0 and restored its bytecode. Only the remaining demo deployment/mints and explicitly authorized public unpause were sent; the four deployed contracts were not replayed. Original partial journal.json remains unchanged. fresh-playground.json is the completed result, with eight successful zero-value receipts and total gas cost0.002729749185092788testETH, within the1testETH/12transaction local setup bounds. ripe0x.eth received1000additionaltestETH as external actor setup. No pool deposit, draw or NFT approval occurred.

Current factory0xbe49677a403f77136e81498e5681f8dc22aa1181 selects implementation0x940815eE17aa44E861bEfe77e6812EB0f2da9710, version2. Public creation is unpaused. Existing Shapes/Packs dependencies are reused.

Keeper PID22144 is the production keeper/keeper.ts, detached, configured for only local8545, chain31337, synthetic account1e004, this factory, LEGACY_FACTORIES=0, FROM_BLOCK26485620, poll2000ms, MAX_GAS_PRICE_GWEI=5, MAX_LOSS_WEI=0. No private-key or CANARY_PLAN environment was inherited. Health http://127.0.0.1:8787/health is ok:true, all checks true, no errors/pending transactions, zero discovered pools and zero sends. It will discover the user's new pools; this proves startup/discovery readiness, not a fresh upkeep execution. Its mutable state/logs remain uncommitted.

Browser acceptance: actual local development account connected, discovery completed and Create pool was enabled. Selected actual Demo Curated#1, entered0.25ETH, clicked Create pool and observed Confirm NFT values with the exact amount and collection-approval warning. Chose Back; removed the test selection and disconnected the test connector. No approval/creation was sent. Mainnet and extension-wallet signing were not exercised.

Things that do not make sense: the ABI-only demo artifact stopped seeding after successful deployment; its failure and recovery remain explicit. No new product behavior was changed.
