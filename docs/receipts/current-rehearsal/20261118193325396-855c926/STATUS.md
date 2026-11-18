# Failed preparation, no transactions

Candidate `855c926`. This packet is invalid and must not execute. The strict artifact check rejected compiler-context
source-ID/source-map drift in the staged simulation; executable bytecode and compiler settings were unchanged.
No actor was funded or unlocked, no block was mined and no transaction was broadcast. The post-failure readback proves
all eight synthetic actors still have zero balances/nonces/code and all deployment targets are vacant.

The original-root diagnostic warm was read-only and restored `deployments/31337.json` exactly. It skipped compilation;
the staged library symlink, rather than source drift, caused the differing namespace. The next source revision copies
verified pinned dependency sources into ordinary directories and preserves cache timestamps. This failed packet,
simulation, node and diagnostic remain separate evidence, with no approval transferred to a successor packet.
