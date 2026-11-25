# Focused update approval packet

The owner explicitly approved focused release scope in R113. Existing production policy additionally requires
an SSH outcome/configuration signature; the full-campaign signature remains separate and cannot sign this payload.
No deployment, activation, canary spending or public unpause follows from this packet.

Approval hash: `191c4b697f12aa9908add65777a92f04a2a11115120ea8388dc6289019620f4d`

| Focused outcome | Measured/asserted amount | Retained limit |
| --- | --- | --- |
| Curated inventory roundtrip | Exactly2NFTs return;1ETHcapital returns |1..20distinct IDs; auth/rollback/lock checks |
| ERC20 roundtrip | Exactly1WETH returns to currentcreator | No donor claim; nativecapital/credit unchanged |
| Paused creation | Policyadmin canary deposits/exits0.1ETH | Publicpause stayson; deniedpubliccaller moves0ETH |
| Reference leftovers |0trackedinventory/ERC20/native assets | FWAproceeds/creatorcredit0at exit |
| Reentrant callback | Native/WETHdrains rejected with Reentrancy | Actualnonzerocredit and0.1WETH protected |
| Gas/size |20-item reprice1476308rawgas;withdraw2010227 | Conservativeintrinsic/calldata bound below16777216; runtime24453bytes |

Recommendation: sign the focused scope for this update, retaining the separate incomplete monthly economiccampaign.
Alternative: retain the full-campaign gate as the release blocker; it requires the larger proof/scheduling campaign.
The focused choice changes acceptance scope, not participant entitlements, pricing or keeper-payment formulas.
The owner already selected it; the remaining action is its existing cryptographic approval step.

Run locally using the existing owner SSH signing key from the allowed-signers policy:

```sh
printf %s 191c4b697f12aa9908add65777a92f04a2a11115120ea8388dc6289019620f4d > /tmp/af-focused.txt
ssh-keygen -Y sign -f <existing-owner-ssh-key> -n asset-flow /tmp/af-focused.txt
```

Only the PUBLIC signature in /tmp/af-focused.txt.sig is needed in asset-flow-focused.json approval.signature.
Never share the private key or password. After insertion, rerun the gate's --no-run --require-review readback.
The deployed/runtime candidate, mainnet preflight and immediate decoded broadcast approvals remain separate.

No new whole-system audit is recommended solely for this scoped update. The independent changed-flow review and
affected-repair reviews are in audit/inventory-update-b44e35f/REPORT.md. They do not certify absence of bugs.

Things that don't make sense: treating the focused signature or gate PASS as authority to deploy, open publiccreation
orclaim the separate28-regime economics are verified.
