// One isolated Anvil-fork opening upkeep receipt: compare measured reward, billed gas, and EOA P&L.
// Broadcasts only to 127.0.0.1; Tenderly mainnet is a read-only upstream.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, createTestClient, createWalletClient, decodeEventLog, http, parseAbi, type Address } from 'viem';

const repo = process.cwd();
const project = join(repo, 'audit/round8/integration/validation/project');
mkdirSync(project, { recursive: true });
mkdirSync(join(project, 'deployments'), { recursive: true });
const port = 18570;
const rpc = `http://127.0.0.1:${port}`;
const creator = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;
const keeper = '0x00000000000000000000000000000000000ce3e5' as Address;
const factoryAbi = parseAbi(['function predictBalancer(address,bytes32) view returns(address)', 'function createBalancer(bytes32) payable returns(address)']);
const balAbi = parseAbi([
  'function configure(uint16,uint256)', 'function open()', 'function performUpkeep() returns(uint256)',
  'function getActiveIds() view returns(uint256[])',
  'event KeeperPaid(address indexed keeper,uint256 amount,uint256 gasUsed)',
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
const success = async (hash: `0x${string}`) => {
  const r = await pub.waitForTransactionReceipt({ hash });
  assert.equal(r.status, 'success');
  return r;
};

try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { await pub.getBlockNumber(); ready = true; break; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  assert(ready, 'local fork did not start');
  execFileSync('forge', ['build', 'src/vendor/PacksBuild.sol', '--root', project, '--out', 'out', '--cache-path', 'cache'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('forge', [
    'script', 'script/Deploy.s.sol:Deploy', '--root', project, '--out', 'out', '--cache-path', 'cache',
    '--rpc-url', rpc, '--unlocked', '--sender', creator, '--broadcast', '-vv',
  ], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PACKS_ADMIN: creator, KEEPER_ADMIN: creator } });
  const { balancerFactory: factory } = JSON.parse(readFileSync(join(project, 'deployments/31337.json'), 'utf8')) as { balancerFactory: Address };
  const salt = `0x${'2'.repeat(64)}` as const;
  const bal = await pub.readContract({ address: factory, abi: factoryAbi, functionName: 'predictBalancer', args: [creator, salt] });
  await success(await wallet.writeContract({ address: factory, abi: factoryAbi, functionName: 'createBalancer', args: [salt], account: creator, chain: null, value: 1n * 10n ** 18n }));
  await success(await wallet.writeContract({ address: bal, abi: balAbi, functionName: 'configure', args: [0, 5n], account: creator, chain: null }));
  await success(await wallet.writeContract({ address: bal, abi: balAbi, functionName: 'open', account: creator, chain: null }));
  const code = await pub.getCode({ address: keeper });
  assert(!code || code === '0x', 'keeper wallet has code');
  await test.impersonateAccount({ address: keeper });
  await test.setBalance({ address: keeper, value: 1n * 10n ** 18n }); // external actor wallet setup
  const forcedBaseFee = process.env.CAP_BASEFEE_WEI ? BigInt(process.env.CAP_BASEFEE_WEI) : undefined;
  if (forcedBaseFee) {
    await test.setNextBlockBaseFeePerGas({ baseFeePerGas: forcedBaseFee });
    await test.mine({ blocks: 1 });
  }
  const fee = { maxFeePerGas: 5_000_000_000n, maxPriorityFeePerGas: 50_000_000n };
  const estimate = await pub.estimateContractGas({ address: bal, abi: balAbi, functionName: 'performUpkeep', account: keeper, ...fee });
  const before = await pub.getBalance({ address: keeper });
  if (forcedBaseFee) await test.setNextBlockBaseFeePerGas({ baseFeePerGas: forcedBaseFee });
  await test.mine({ blocks: 1 }); // inclusion after the estimate
  if (forcedBaseFee) await test.setNextBlockBaseFeePerGas({ baseFeePerGas: forcedBaseFee });
  const r = await success(await wallet.writeContract({ address: bal, abi: balAbi, functionName: 'performUpkeep', account: keeper, chain: null, gas: estimate * 13n / 10n, ...fee }));
  const after = await pub.getBalance({ address: keeper });
  const paid = r.logs.filter((l) => l.address.toLowerCase() === bal.toLowerCase()).flatMap((l) => {
    try {
      const ev = decodeEventLog({ abi: balAbi, data: l.data, topics: l.topics });
      return ev.eventName === 'KeeperPaid' ? [ev.args] : [];
    } catch { return []; }
  });
  assert.equal(paid.length, 1);
  assert.equal(paid[0].keeper.toLowerCase(), keeper.toLowerCase());
  const cost = r.gasUsed * r.effectiveGasPrice;
  assert.equal(after - before, paid[0].amount - cost);
  const ids = await pub.readContract({ address: bal, abi: balAbi, functionName: 'getActiveIds' });
  assert.equal(ids.length, 5);
  console.log(JSON.stringify({
    forkBlock: 26382349, estimate: estimate.toString(), billedGas: r.gasUsed.toString(),
    measuredGas: paid[0].gasUsed.toString(), rewardCap: '3200000', rewardWei: paid[0].amount.toString(),
    effectiveGasPrice: r.effectiveGasPrice.toString(), costWei: cost.toString(), netKeeperWei: (after - before).toString(),
    walletCode: code ?? '0x', forcedBaseFee: forcedBaseFee?.toString() ?? null, status: r.status,
  }));
} finally {
  anvil.kill('SIGTERM'); // only the private child process started above
  for (const link of links) unlinkSync(join(project, link));
}
