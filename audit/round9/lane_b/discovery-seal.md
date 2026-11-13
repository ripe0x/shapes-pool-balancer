# Round 9 — Lane B discovery seal

Sealed (UTC): 2026-11-13T11:55:45Z
Auditor: blind discovery lane B. Target frozen at `c686534`. Fork block 26,382,349 via Tenderly public RPC.
Active time used: ~25 minutes (start 2026-11-13T11:30:34Z). Full seal (not partial). No excluded files read.

SHA-256 of every file in `audit/round9/lane_b/` except `out/` and `cache/` (and this seal file):

```
e20b392cfb6a3901d177091bc149d889f8ca77a303e5d50b997437462815287c  BelowReserve.t.sol
b82e158bf0f8ec968d5a7fd3c17356046e176ffd38612c0abb27d7c8e992970f  Econ.t.sol
8fc2ead5f8d4e4f8ab60b772f8bcce863b4566bbfda09baed1eb20cb3e477779  Harness.sol
8e92d89b2bbb9bd5c7262b9a2b3d147c28cac96b9988b2182f30ad59bf073f95  Keeper.t.sol
79578a3411904c65a871a0374516a519543e48855f4c07a2cdcfeddfbfab9130  MockNFT.sol
63a768dc234d1c3f527d7f2aa46a8270ff61bf9b05c1095a454e919a3ea332e0  Probe.t.sol
cf2a44a2c12c9f41faa05097348e696ea2afa6e724a40ad85dff38f7face9a80  Probe2.t.sol
a96dbec88ef07be297856cabb66103ad176d99b3359b25809fb2667976d0d771  Probe3.t.sol
23587a51b54793db0710999dd18585efedd6719e7f1c689d4b491f818707cbae  ProbeVrf.t.sol
0cd9ebf43ddf7ab68066062d96650108ac42bb26b90f27cbfbe8f36a083fcb11  Scenario.t.sol
7daa0ca8b0b35f4dae1df441e0a34069026638786c248ec654a4b1e6f3b0a4cc  Security.t.sol
d0429ceb85d629acad2bfe37550aad36cdb99a14826d0c6d1266ab0af159fbb4  logs/belowreserve.log
52b237c8d52e8984658b403df237c7946d2f5c50eba22b5f77f2044e2d5bbd51  logs/build.log
f885a538db03f233edf1f8ccd05feb638206bd03b124c3a33c4b67b44addb518  logs/econ-nft.log
6b11f4657dfe0496c24a715df3a4b39e215e0c274199f64c55b55ebf0b3fb9dd  logs/econ.log
1df8fef89a7b330037a44c89440435c4bd9a6ce081050c3f7e6a2d65e46d4f23  logs/final-Econ.log
d12601f0416a8d0daece44e2806f0fd37a1cbc274337f0f4fe99827df026ccad  logs/final-Keeper.log
7fc44d032e22e21e4c3e020763c5dadb5e9e4be07f4a72811c257053aa3d7f7f  logs/final-Scenario.log
115a7903c5f9c0190a7a3418822af08e82ed6184bfebb396b0c1d2376f989446  logs/final-Security.log
a8d65e35284104625d405209e47c2066fb3ec45dd5fe1fc5765dd6193a9b2705  logs/forge-version.log
b2e3d4968c0d92eab5a4c0777cafd09dba6c3f8c568e502a48b452ad67c0d88f  logs/keeper.log
df646e3433cbb7b90b54aeb5cae2cae97d3f5b77d7c4a5d4384bc1ec6a44ccc0  logs/probe.log
049c62307fe840c04e96ecb3c4af85df32394292e0e50a089b8f1f9890ad1f07  logs/probe2.log
cca97ba6d30d6e7282a5dd0a1c9c1bd298edcb0f92713b00db56e59c93f13054  logs/probe3.log
565b2f7435f8b0d581de78bf954c03267bf4b97ed7984dbe99c936965d6b3583  logs/probevrf.log
d81431578de8086aed118a8cbf9c985ac7f6e21cbdbda8794db2eab048b79e01  logs/scenario.log
ca82aa0e900378efe0d4cfd9e50f21d5209b71f25106f91c3f034edd6ee3005a  logs/scenario2.log
63dd0f417152d22e563c4a68b7da6f64d1263f3d20a2626c06dc14010156ca7d  logs/security.log
16762586737dfdf19c2844a0c4caf81ff0bcdba5804f0fe144e62f2b007e8ec8  logs/sentinel-fork.log
1ad85d9c95295afd439693859c9ddc774c2269a65f093fabd1c2035be01f6983  logs/sentinel-local.log
dcbd50577055c1c3d7cca5b12b12a199acbe6949d49afaf16e7d385d95ac2f49  preflight/record.md
4311613dc5ca1f01191b961bb5b5d94392c4127e8ab892a14ae2d712fcad9494  sealed-inventory.md
```

Method note: VRF words delivered by `vm.prank`-ing the real coordinator
`0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d` and calling the pool's real `rawFulfillRandomWords` (the accepted
"act as the coordinator through the real VRF service path"). No `vm.mockCall` / `vm.etch` / `vm.store` on any protocol
contract. Draw Packs / renderer deployed from `./out` build artifacts (per the deploy script). No sealed file modified
after this seal.
