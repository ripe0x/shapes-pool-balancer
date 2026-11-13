# Round 9 — Lane B addendum seal

Sealed (UTC): 2026-11-13T12:11:30Z. Auditor: blind discovery lane B. Target frozen at `c686534`. Fork block
26,382,349 via Tenderly public RPC. Total active time (original + addendum): ~40 minutes, under the 3-hour ceiling.
No excluded files read. The original `discovery-seal.md` files are byte-for-byte unchanged (re-verified at seal time).

SHA-256 of the new addendum files (all `out/` and `cache/` excluded):

```
165c74a27047441b9ad11ff7a21b4d5f4d7c126bf51d556de01ed90b2d9291df  Harness2.sol
12185234264e1e2d380a5758580d081f4f1559119f5eb4c7bd0af20f20c060df  ProbeRoute.t.sol
5a55c8cc2e2fa5a16f609141d3ce8efa5518e8006ea3836dfdfa30767f03e2db  AddendumGas.t.sol
cbbeb8a062d9ce6fe496a7abe470824539e1edb7952c902ce7a6d6d5e3703f91  AddendumBelowReserve.t.sol
d072485e293119f2d94aee5146e281e3816094a42b9388227140cd40da49e30c  AddendumScale.t.sol
b5ea46ce1088fc328ead4303af4bd95dbb07947c4594a5e6dda3ac1a38efb40b  addendum.md
9f55dc8013bd451b2f31690d57d02128c15346d44e444e79da5562197545b561  logs/proberoute.log
f1031d9f382a7aece3c7fee1013926aa335d04531efd4667c8a6dabde70c7b94  logs/addendum-gas.log
ce0157f8a8cfac2de4fbc45d4221f8ca4e3fbac3e40c87ebed9bcbeebaac6148  logs/addendum-below.log
3f61ccb576cb263db9d7d2a349f8bf41ef170c6ef9732668ca17ecd333d655c5  logs/addendum-scale.log
3b83af43e5904819e75abae451bfe0db2e3494dc7b09838e284dc0f5284b718a  logs/addendum-flight.log
588e5456fef0c62ba65706c4739a7f38674f8e8b4b53de72c5cfe6a2719355a2  logs/final-ProbeRoute.log
511bbb700adf6f29ff57a07afbb9286407285ce4bd42cf0710969f9e03aac985  logs/final-AddendumGas.log
338c6c7bf3e0540fac39f1b915c45269f3fc5b0183ee07a451adf611856b9532  logs/final-AddendumBelowReserve.log
c70fa2d3651038db0941520e61afcc74eb396c5ebd19e5466048aec8cbe8bb2b  logs/final-AddendumScale.log
```

Route note: VRF words delivered by the corrected route — prank the Chainlink coordinator
`0xD7f86b4b8Cae7D942340FF628F82735b7a20893a` (= `service.coordinator()`) and call
`service(0x7D93..Ed65d).rawFulfillRandomWords(chainlinkRequestId, words)`, where the requestId is the first data word
of the coordinator's request event (topic0 `0xeb0e3652..`), so the service settles its own request and forwards to the
pool. No `vm.mockCall` / `vm.etch` / `vm.store` on any protocol contract. No sealed file modified after this seal.
