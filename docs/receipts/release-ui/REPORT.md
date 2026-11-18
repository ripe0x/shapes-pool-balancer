# Dashboard interaction evidence

**Partial acceptance, no transaction or real-wallet signature.** UI revision `04bc760`; development preview `http://127.0.0.1:5182/`, real local RPC `http://127.0.0.1:18554`, chain 31337. Existing pool `0xf2295c51bB08056109eC2e125941569717965F16` uses historical `9b45f91` bytecode. This demonstrates final-UI legacy compatibility, not current-contract rehearsal.

Using the existing explicitly labelled local development connector and synthetic account ending `1d005`, actual interactions passed:

- Pool discovery and Overview load, real inventory rendering: 12 selectable, zero staged.
- Separate displayed backing, operating ETH, booked profit, reserve, withdrawable capital and expected unsold fee income. The values were independently read at pinned block 26,438,542 with explicit fee fields in `legacy-readback.json`.
- Settings active V1, version, factory recommendation, enabled payments, 0.01645 ETH policy maximum and 0.000317 ETH listing surcharge. Missing new reward view on the legacy pool does not disable the dashboard.
- Invalid candidate `not-an-address` disables proposal; using the factory recommendation restores the actual funding preview. Candidate pricing remains explicitly unverified before activation.
- Disconnect development account and open the normal wallet picker. Browser Wallet reaches “Opening Browser Wallet… Confirm connection in the extension.” User handoff remains pending. This is not a successful extension connection or signing test.

No propose, cancel, activate, disable, deposit, upkeep, close or withdraw transaction was submitted. No keys were created/imported and no wallet extension was installed. The development connector uses the real local node, but is not a browser-wallet signature. Existing other tabs, previews and nodes remain untouched.

Screenshots: `legacy-overview.jpg`, `legacy-policy.jpg`, `wallet-connection-pending.jpg`. Readback contains exact wei values and the older contract revision. UI writes, user rejection, wallet/network switching, real signing and final-contract interactions remain untested.

## Things that don't make sense

A successful legacy display or local development connection cannot be reported as real-wallet signing or repaired-bytecode rehearsal.
