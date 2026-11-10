// Keeper integration test on a local mainnet fork with the real FWA pool and Shapes.
// Starts its own anvil (port E2E_PORT, default 18546), deploys via script/Deploy.s.sol, creates two
// Balancers via script/DevSetup.s.sol, then exercises the keeper. Run: npm run keeper:e2e
import assert from 'node:assert/strict';
import { execSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, createTestClient, createWalletClient, http, keccak256, parseAbi, toHex, type Address } from 'viem';
import { fwaPoolAbi, poolBalancerAbi } from '../shared/abi';
import { Keeper } from './keeper';

const PORT = Number(process.env.E2E_PORT ?? 18546);
const RPC = `http://127.0.0.1:${PORT}`;
const FORK_BLOCK = 26382349n;
const ACCTS = [
  '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
] as const;
const VRF_SERVICE = '0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d' as const;
const serviceAbi = parseAbi(['function coordinator() view returns (address)', 'function rawFulfillRandomWords(uint256 requestId, uint256[] randomWords)']);

const pub = createPublicClient({ transport: http(RPC) });
const test = createTestClient({ mode: 'anvil', transport: http(RPC) });
const wallet = createWalletClient({ transport: http(RPC) });
const logs: string[] = [];

async function main() {
  try {
    execSync(`lsof -nP -iTCP:${PORT} -sTCP:LISTEN`, { stdio: 'ignore' });
    throw new Error(`port ${PORT} busy; set E2E_PORT`);
  } catch (e) {
    if ((e as Error).message.includes('busy')) throw e;
  }
  const anvil = spawn('anvil', ['--fork-url', 'https://mainnet.gateway.tenderly.co', '--fork-block-number', FORK_BLOCK.toString(), '--port', String(PORT), '--chain-id', '31337', '--silent'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) {
      try { await pub.getBlockNumber(); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
    await run();
    console.log('KEEPER E2E PASSED');
  } finally {
    anvil.kill();
  }
}

const sh = (cmd: string, env: Record<string, string> = {}) =>
  execSync(cmd, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

async function setupPool(sender: string, salt = '0'): Promise<Address> {
  const out = sh(`forge script script/DevSetup.s.sol --tc DevSetup --rpc-url ${RPC} --unlocked --sender ${sender} --broadcast`, { FACTORY: factory, SALT: salt });
  return out.match(/Balancer (0x[0-9a-fA-F]{40})/)![1] as Address;
}

let factory: Address;

async function status(b: Address) {
  return Number(await pub.readContract({ address: b, abi: poolBalancerAbi, functionName: 'admissionStatus' }));
}

async function tickUntil(k: Keeper, done: () => Promise<boolean>, max = 12) {
  for (let i = 0; i < max; i++) {
    await k.tick();
    if (await done()) return;
  }
  const info = [];
  for (const b of k.state.balancers) {
    const pool = (await pub.readContract({ address: b, abi: poolBalancerAbi, functionName: 'pool' })) as Address;
    info.push({ b, status: await status(b).catch(() => -1), unsettled: String(await pub.readContract({ address: pool, abi: fwaPoolAbi, functionName: 'unsettledAcquisitionCount' }).catch(() => -1)), seq: String(await pub.readContract({ address: pool, abi: fwaPoolAbi, functionName: 'lastIssuedSequence' }).catch(() => -1)), active: String(await pub.readContract({ address: pool, abi: fwaPoolAbi, functionName: 'activeListingCount' }).catch(() => -1)) });
  }
  throw new Error('condition not reached ' + JSON.stringify(info));
}

async function buyAndSettle(b: Address, count: number, buyer: Address, word: bigint) {
  const pool = (await pub.readContract({ address: b, abi: poolBalancerAbi, functionName: 'pool' })) as Address;
  await test.impersonateAccount({ address: buyer });
  await test.setBalance({ address: buyer, value: 10n ** 20n });
  const [, , total] = (await pub.readContract({ address: pool, abi: fwaPoolAbi, functionName: 'quoteAcquisitionPrice', args: [BigInt(count)] })) as readonly [bigint, bigint, bigint];
  const v = await pub.readContract({ address: pool, abi: fwaPoolAbi, functionName: 'inventoryVersion' });
  const before = await pub.readContract({ address: pool, abi: fwaPoolAbi, functionName: 'lastIssuedSequence' });
  const now = (await pub.getBlock()).timestamp;
  // The VRF fee follows the tx gas price, so overpay; FWA refunds the excess.
  const h = await wallet.writeContract({ address: pool, abi: fwaPoolAbi, functionName: 'acquireBatch', args: [buyer, BigInt(count), 0n, 0n, 10_000n, v as bigint, now + 600n], value: total * 2n + 10n ** 16n, account: buyer, chain: null, gas: 3_000_000n });
  assert.equal((await pub.waitForTransactionReceipt({ hash: h })).status, 'success', 'purchase');
  await test.mine({ blocks: 3 });
  const coord = (await pub.readContract({ address: VRF_SERVICE, abi: serviceAbi, functionName: 'coordinator' })) as Address;
  await test.impersonateAccount({ address: coord });
  await test.setBalance({ address: coord, value: 10n ** 18n });
  for (let s = Number(before) + 1; s <= Number(before) + count; s++) {
    const id = await pub.readContract({ address: pool, abi: fwaPoolAbi, functionName: 'requestIdAtSequence', args: [BigInt(s)] });
    const fh = await wallet.writeContract({ address: VRF_SERVICE, abi: serviceAbi, functionName: 'rawFulfillRandomWords', args: [id as bigint, [BigInt(keccak256(toHex(word * 1000n + BigInt(s))))]], account: coord, chain: null, gas: 5_000_000n });
    await pub.waitForTransactionReceipt({ hash: fh });
  }
  const unsettled = await pub.readContract({ address: pool, abi: fwaPoolAbi, functionName: 'unsettledAcquisitionCount' });
  if (unsettled) {
    const ph = await wallet.writeContract({ address: pool, abi: fwaPoolAbi, functionName: 'processAcquisitions', args: [5n], account: ACCTS[0], chain: null });
    await pub.waitForTransactionReceipt({ hash: ph });
  }
}

async function run() {
  sh(`forge script script/Deploy.s.sol --rpc-url ${RPC} --unlocked --sender ${ACCTS[0]} --broadcast`);
  factory = JSON.parse(readFileSync('deployments/31337.json', 'utf8')).balancerFactory;
  const b1 = await setupPool(ACCTS[1]);
  const b2 = await setupPool(ACCTS[2]);
  console.log('balancers', b1, b2);

  const dir = mkdtempSync(join(tmpdir(), 'keeper-e2e-'));
  const stateFile = join(dir, 'state.json');
  const keeperAddr = ACCTS[3] as Address;
  const mk = () => new Keeper({ rpcUrl: RPC, factory, fromBlock: FORK_BLOCK, stateFile, account: keeperAddr, replaceAfterBlocks: 2, log: (m, e) => logs.push(`${m} ${JSON.stringify(e ?? {})}`) });
  let k = mk();

  // 1. discovery and initial fill of both pools
  await tickUntil(k, async () => (await status(b1)) === 0 && (await status(b2)) === 0);
  assert.equal(k.state.balancers.length, 2, 'discovered both');
  const kb0 = await pub.getBalance({ address: keeperAddr });
  console.log('✓ discovered and filled 2 pools; sent', k.state.stats.sent);

  // 2. real FWA draws on both pools, then reconciliation and replenishment
  await buyAndSettle(b1, 3, '0x00000000000000000000000000000000000b0b01', 11n);
  await buyAndSettle(b2, 5, '0x00000000000000000000000000000000000b0b02', 99n);
  assert.notEqual(await status(b1), 0);
  assert.notEqual(await status(b2), 0);
  await tickUntil(k, async () => (await status(b1)) === 0 && (await status(b2)) === 0);
  const kb1 = await pub.getBalance({ address: keeperAddr });
  assert.ok(kb1 > kb0 - 10n ** 16n, 'keeper reimbursed');
  console.log('✓ reconciled and replenished after draws on both pools');

  // 3. restart from persisted state: no rediscovery duplicates, no redundant sends
  const sentBefore = k.state.stats.sent;
  k = mk();
  await k.tick();
  await k.tick();
  assert.equal(k.state.balancers.length, 2);
  assert.equal(k.state.stats.sent, sentBefore, 'no redundant sends after restart');
  console.log('✓ restart resumes without duplicate work');

  // 4. stuck transaction is replaced with bumped fees and mined once
  await buyAndSettle(b1, 1, '0x00000000000000000000000000000000000b0b03', 7n);
  await test.setAutomine(false);
  await k.tick(); // sends at ~2x current basefee
  assert.equal(Object.keys(k.state.pending).length, 1, 'one pending');
  const p = k.state.pending[b1];
  const high = BigInt(p.maxFeePerGas) * 4n;
  for (let i = 0; i < 3; i++) {
    await test.setNextBlockBaseFeePerGas({ baseFeePerGas: high });
    await test.mine({ blocks: 1 });
  }
  await k.tick(); // replaces
  assert.ok(k.state.stats.replaced >= 1, 'replaced');
  await test.setNextBlockBaseFeePerGas({ baseFeePerGas: 10n ** 8n });
  await test.mine({ blocks: 1 });
  await test.setAutomine(true);
  await tickUntil(k, async () => (await status(b1)) === 0);
  assert.equal(Object.keys(k.state.pending).length, 0);
  console.log('✓ replacement tx mined; stats', JSON.stringify(k.state.stats));

  // 5. reorg: a Balancer created in a reorged-out block is dropped
  const snap = await test.snapshot();
  const b3 = await setupPool(ACCTS[1], '1');
  await k.tick();
  assert.equal(k.state.balancers.length, 3);
  await test.revert({ id: snap });
  await k.tick();
  assert.equal(k.state.balancers.length, 2, 'reorged balancer dropped');
  assert.ok(!k.state.balancers.includes(b3));
  console.log('✓ reorg handled');

  // 6. one broken pool does not stop the others
  await buyAndSettle(b1, 2, '0x00000000000000000000000000000000000b0b04', 5n);
  await test.setCode({ address: b2, bytecode: '0xfe' });
  await tickUntil(k, async () => (await status(b1)) === 0);
  assert.ok(k.errors[b2], 'b2 error recorded');
  assert.equal(k.health().balancers, 2);
  console.log('✓ per-pool error isolation; health', JSON.stringify(k.health()));
}

main().catch((e) => {
  console.error(logs.slice(-20).join('\n'));
  console.error(e);
  process.exit(1);
});
