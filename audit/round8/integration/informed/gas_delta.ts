// Isolated local-fork estimate -> next-block receipt comparison. No mainnet broadcast or secret.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, createTestClient, createWalletClient, http, parseAbi, type Address } from 'viem';

const repo = process.cwd();
const project = join(repo, 'audit/round8/integration/informed/project');
const port = 18568;
const rpc = `http://127.0.0.1:${port}`;
const actor = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;
const keeper = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' as Address;
const factoryAbi = parseAbi([
  'function predictBalancer(address creator,bytes32 salt) view returns (address)',
  'function createBalancer(bytes32 salt) payable returns (address)',
]);
const balAbi = parseAbi([
  'function configure(uint16 markupBps,uint256 target)',
  'function open()',
  'function performUpkeep() returns (uint256)',
  'function getActiveIds() view returns (uint256[])',
]);

const links = ['src', 'script', 'lib', 'foundry.toml'];
for (const link of links) {
  const path = join(project, link);
  assert(!existsSync(path), `${path} already exists`);
  symlinkSync(join(repo, link), path);
}
const anvil = spawn('anvil', [
  '--fork-url', 'https://mainnet.gateway.tenderly.co', '--fork-block-number', '26382349',
  '--chain-id', '31337', '--port', String(port), '--silent',
], { stdio: 'ignore' });
const pub = createPublicClient({ transport: http(rpc) });
const test = createTestClient({ mode: 'anvil', transport: http(rpc) });
const wallet = createWalletClient({ transport: http(rpc) });
const waitReceipt = async (hash: `0x${string}`) => {
  const r = await pub.waitForTransactionReceipt({ hash });
  assert.equal(r.status, 'success', `transaction ${hash}`);
  return r;
};

try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { await pub.getBlockNumber(); ready = true; break; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  assert(ready, 'local fork did not start');
  execFileSync('forge', [
    'script', 'script/Deploy.s.sol:Deploy', '--root', project, '--out', 'out', '--cache-path', 'cache',
    '--rpc-url', rpc, '--unlocked', '--sender', actor, '--broadcast', '-vv',
  ], {
    cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PACKS_ADMIN: actor, KEEPER_ADMIN: actor },
  });
  const { balancerFactory: factory } = JSON.parse(readFileSync(join(project, 'deployments/31337.json'), 'utf8')) as { balancerFactory: Address };
  const salt = `0x${'0'.repeat(64)}` as const;
  const bal = await pub.readContract({ address: factory, abi: factoryAbi, functionName: 'predictBalancer', args: [actor, salt] });
  await waitReceipt(await wallet.writeContract({ address: factory, abi: factoryAbi, functionName: 'createBalancer', args: [salt], account: actor, chain: null, value: 1n * 10n ** 18n }));
  await waitReceipt(await wallet.writeContract({ address: bal, abi: balAbi, functionName: 'configure', args: [0, 5n], account: actor, chain: null }));
  await waitReceipt(await wallet.writeContract({ address: bal, abi: balAbi, functionName: 'open', account: actor, chain: null }));

  const rows: { preMine: number; estimated: string; billed: string; delta: string; nextBlock: string }[] = [];
  for (let i = 0; i < 24; i++) {
    const snap = await test.snapshot();
    try {
      await test.mine({ blocks: i + 1 });
      const fee = { maxFeePerGas: 5_000_000_000n, maxPriorityFeePerGas: 50_000_000n };
      const estimated = await pub.estimateContractGas({ address: bal, abi: balAbi, functionName: 'performUpkeep', account: keeper, ...fee });
      await test.mine({ blocks: 1 });
      const hash = await wallet.writeContract({ address: bal, abi: balAbi, functionName: 'performUpkeep', account: keeper, chain: null, gas: estimated * 13n / 10n, ...fee });
      const receipt = await waitReceipt(hash);
      const ids = await pub.readContract({ address: bal, abi: balAbi, functionName: 'getActiveIds' });
      assert.equal(ids.length, 5);
      rows.push({ preMine: i + 1, estimated: estimated.toString(), billed: receipt.gasUsed.toString(), delta: (receipt.gasUsed - estimated).toString(), nextBlock: receipt.blockNumber.toString() });
    } finally { await test.revert({ id: snap }); }
  }
  const deltas = rows.map((r) => BigInt(r.delta));
  const max = deltas.reduce((a, b) => a > b ? a : b);
  const min = deltas.reduce((a, b) => a < b ? a : b);
  console.log(JSON.stringify({ pinnedBlock: 26382349, samples: rows.length, maxPositiveDelta: max.toString(), minDelta: min.toString(), rows }));
} finally {
  anvil.kill('SIGTERM'); // only the private child process started above
  for (const link of links) unlinkSync(join(project, link));
}
