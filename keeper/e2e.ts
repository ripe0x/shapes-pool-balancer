// Keeper integration test on a local mainnet fork with the real FWA pool and Shapes.
// Starts its own anvil (port E2E_PORT, default 18546), deploys via script/Deploy.s.sol, creates two
// Balancers via script/DevSetup.s.sol, then exercises the keeper. Run: npm run keeper:e2e
import assert from 'node:assert/strict';
import { execSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, createTestClient, createWalletClient, http, keccak256, parseAbi, toBytes, toHex, type Address } from 'viem';
import { fwaPoolAbi, poolBalancerAbi } from '../shared/abi';
import { MAX_KEEPER_REWARD } from '../shared/planner';
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

/** Admitting, every draw reconciled and the target fully listed: what the keeper restores after draws. */
async function stocked(b: Address) {
  const r = (fn: string) => pub.readContract({ address: b, abi: poolBalancerAbi, functionName: fn as never });
  const pool = (await r('pool')) as Address;
  const t = (await r('target')) as bigint;
  const have = (await r('getActiveShapes')) as readonly number[];
  const last = await pub.readContract({ address: pool, abi: fwaPoolAbi, functionName: 'lastIssuedSequence' });
  if ((await r('reconciledSequence')) !== last) return false;
  for (let d = 0; d < 16; d++) if (Number((t >> BigInt(16 * d)) & 0xffffn) !== Number(have[d])) return false;
  return (await status(b)) === 0;
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

/** Buy `count` draws directly through FWA with ETH and deliver randomness. `purchaser` defaults to `buyer`. */
async function buyAndSettle(b: Address, count: number, buyer: Address, word: bigint, purchaser: Address = buyer) {
  const pool = (await pub.readContract({ address: b, abi: poolBalancerAbi, functionName: 'pool' })) as Address;
  await test.impersonateAccount({ address: buyer });
  await test.setBalance({ address: buyer, value: 10n ** 20n });
  const [, , total] = (await pub.readContract({ address: pool, abi: fwaPoolAbi, functionName: 'quoteAcquisitionPrice', args: [BigInt(count)] })) as readonly [bigint, bigint, bigint];
  const v = await pub.readContract({ address: pool, abi: fwaPoolAbi, functionName: 'inventoryVersion' });
  const before = await pub.readContract({ address: pool, abi: fwaPoolAbi, functionName: 'lastIssuedSequence' });
  const now = (await pub.getBlock()).timestamp;
  // The VRF fee follows the tx gas price, so overpay; FWA refunds the excess.
  const value = total * 2n + 10n ** 16n;
  const h = await wallet.writeContract({ address: pool, abi: fwaPoolAbi, functionName: 'acquireBatch', args: [purchaser, BigInt(count), 0n, 0n, 10_000n, v as bigint, now + 600n], value, account: buyer, chain: null, gas: 3_000_000n });
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
  sh(`PACKS_ADMIN=${ACCTS[0]} forge script script/Deploy.s.sol --rpc-url ${RPC} --unlocked --sender ${ACCTS[0]} --broadcast`);
  factory = JSON.parse(readFileSync('deployments/31337.json', 'utf8')).balancerFactory;
  const b1 = await setupPool(ACCTS[1]);
  const b2 = await setupPool(ACCTS[2]);
  console.log('balancers', b1, b2);

  const dir = mkdtempSync(join(tmpdir(), 'keeper-e2e-'));
  const stateFile = join(dir, 'state.json');
  // Fresh code-free keeper address: Hardhat test accounts carry EIP-7702 sweeper delegations on mainnet.
  const keeperAddr = '0x00000000000000000000000000000000000ce3e5' as Address;
  await test.impersonateAccount({ address: keeperAddr });
  await test.setBalance({ address: keeperAddr, value: 10n ** 18n });
  const mk = () => new Keeper({ rpcUrl: RPC, factory, fromBlock: FORK_BLOCK, stateFile, account: keeperAddr, replaceAfterBlocks: 2, maxLossWei: 10n ** 14n, log: (m, e) => logs.push(`${m} ${JSON.stringify(e ?? {})}`) });
  let k = mk();

  // 1. discovery and initial fill of both pools
  await tickUntil(k, async () => (await stocked(b1)) && (await stocked(b2)));
  assert.equal(k.state.balancers.length, 2, 'discovered both');
  const kb0 = await pub.getBalance({ address: keeperAddr });
  console.log('✓ discovered and filled 2 pools; sent', k.state.stats.sent);

  // 2. real FWA draws on both pools, then reconciliation and replenishment
  await buyAndSettle(b1, 3, '0x00000000000000000000000000000000000b0b01', 11n);
  await buyAndSettle(b2, 5, '0x00000000000000000000000000000000000b0b02', 99n);
  assert.equal(await stocked(b1), false, 'drawn prizes are missing until upkeep');
  assert.equal(await stocked(b2), false, 'drawn prizes are missing until upkeep');
  await tickUntil(k, async () => (await stocked(b1)) && (await stocked(b2)));
  const kb1 = await pub.getBalance({ address: keeperAddr });
  assert.ok(kb1 > kb0, 'keeper earned more than it spent');
  console.log('✓ reconciled and replenished after draws on both pools (direct FWA ETH purchases, 5-draw batch)');
  checkAudit(k);

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
  await tickUntil(k, async () => (await stocked(b1)));
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

  // 6. keeper downtime: draws happen while no keeper runs; a fresh instance catches up from state
  await buyAndSettle(b1, 2, '0x00000000000000000000000000000000000b0b05', 21n);
  await buyAndSettle(b2, 4, '0x00000000000000000000000000000000000b0b06', 22n);
  k = mk();
  await tickUntil(k, async () => (await stocked(b1)) && (await stocked(b2)));
  console.log('✓ downtime: restarted keeper restored both pools');

  // 7. gas policy: above the bid cap the keeper waits instead of overbidding
  await buyAndSettle(b1, 1, '0x00000000000000000000000000000000000b0b07', 31n);
  await test.setNextBlockBaseFeePerGas({ baseFeePerGas: 6n * 10n ** 9n });
  await test.mine({ blocks: 1 });
  const sentBeforeSpike = k.state.stats.sent;
  await k.tick();
  assert.equal(k.state.stats.sent, sentBeforeSpike, 'no send above the 5 gwei bid cap');
  assert.ok(logs.some((l) => l.startsWith('skip: basefee above bid cap')));
  await test.setNextBlockBaseFeePerGas({ baseFeePerGas: 10n ** 8n });
  await test.mine({ blocks: 1 });
  await tickUntil(k, async () => (await stocked(b1)));
  console.log('✓ waited through a basefee spike, then serviced');

  // 8. Purchaser gate. The only known way to make a Shape delivery fail is a purchase naming the Shapes contract
  //    (Shapes rejects only transfers to itself); the Balancer refuses it, so FWA reverts the purchase.
  //    `recoverRefunded` stays for unknown failures and is covered by the fork test with a mocked revert.
  const SHAPES = '0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0' as Address;
  const pool1 = (await pub.readContract({ address: b1, abi: poolBalancerAbi, functionName: 'pool' })) as Address;
  const gateBuyer = '0x00000000000000000000000000000000000b0b08' as Address;
  await test.setBalance({ address: gateBuyer, value: 10n ** 20n });
  const v1 = await pub.readContract({ address: pool1, abi: fwaPoolAbi, functionName: 'inventoryVersion' });
  const deadline = (await pub.getBlock()).timestamp + 600n;
  await assert.rejects(
    pub.simulateContract({ address: pool1, abi: fwaPoolAbi, functionName: 'acquireBatch', args: [SHAPES, 1n, 0n, 0n, 10_000n, v1 as bigint, deadline], value: 10n ** 17n, account: gateBuyer }),
    'a purchase naming the Shapes contract as purchaser is refused',
  );
  assert.equal(await pub.readContract({ address: b1, abi: poolBalancerAbi, functionName: 'canPurchase', args: [SHAPES] }), false);
  console.log('✓ purchaser gate refuses the Shapes contract (no failed Shape delivery can be bought)');
  checkAudit(k);

  // 9. FWA pool page: the creator approves FWA's exact message; viem verifyMessage (ERC-1271 path, as a
  //    viem-based server would verify) accepts it and rejects any altered message.
  const creator1 = ACCTS[1] as Address;
  const issuedAt = new Date().toISOString();
  const metadata = { name: 'Demo Shapes Pool', profile: { avatarUrl: '', bannerUrl: '', description: '', websiteUrl: '', xUrl: '', discordUrl: '' } };
  const metadataHash = keccak256(toBytes(JSON.stringify(metadata)));
  const ah = await wallet.writeContract({ address: b1, abi: poolBalancerAbi, functionName: 'approvePoolPage', args: [issuedAt, metadataHash], account: creator1, chain: null });
  assert.equal((await pub.waitForTransactionReceipt({ hash: ah })).status, 'success');
  const pageMessage = (pool: string, meta: typeof metadata) => [
    'Publish FWA Pools page\nSite: pools.fwa.fun\nChain: 1',
    'Factories: 0x8919814d825a5af238cc04de06b1c18c9eaa477c, 0xf5a3a153164791ab579c3d9ba5dbecf7cdfd300c',
    `Pool: ${pool.toLowerCase()}`, `Issued at: ${issuedAt}`, `Metadata hash: ${keccak256(toBytes(JSON.stringify(meta)))}`,
  ].join('\n'); // pools.fwa.fun client template (V2 pool)
  // The Balancer ignores signature bytes; viem treats 1-byte signatures as invalid before asking the
  // contract, so the dashboard submits 66 zero bytes (no ECDSA interpretation is possible either).
  const PLACEHOLDER_SIG = `0x${'00'.repeat(66)}` as const;
  assert.equal(await pub.verifyMessage({ address: b1, message: pageMessage(pool1, metadata), signature: PLACEHOLDER_SIG }), true, 'approved page verifies');
  assert.equal(await pub.verifyMessage({ address: b1, message: pageMessage(pool1, { ...metadata, name: 'Other' }), signature: PLACEHOLDER_SIG }), false, 'other content rejected');
  assert.equal(await pub.verifyMessage({ address: b1, message: 'hello', signature: PLACEHOLDER_SIG }), false, 'arbitrary message rejected');
  console.log('✓ pool page approval verifies through viem ERC-1271; other messages rejected');

  // 10. one broken pool does not stop the others
  await buyAndSettle(b1, 2, '0x00000000000000000000000000000000000b0b04', 5n);
  await test.setCode({ address: b2, bytecode: '0xfe' });
  await tickUntil(k, async () => (await stocked(b1)));
  assert.ok(k.errors[b2], 'b2 error recorded');
  assert.equal(k.health().balancers, 2);
  console.log('✓ per-pool error isolation; health', JSON.stringify(k.health()));
}

/** Every reward stays within the per-call maximum; outside creator work the contract also caps it by the restocking fees of the prizes listed. */
function checkAudit(k: Keeper) {
  const rows = k.audit.map((a) => ({ fn: a.fn, gasUsed: Number(a.gasUsed), measuredGas: Number(a.measuredGas), rewardWei: a.reward.toString(), costWei: a.cost.toString() }));
  console.table(rows);
  for (const a of k.audit) assert.ok(a.reward <= MAX_KEEPER_REWARD, `reward ${a.reward} above the maximum (${a.hash})`);
  console.log('✓ rewards within MAX_KEEPER_REWARD for', k.audit.length, 'keeper txs');
}

main().catch((e) => {
  console.error(logs.slice(-20).join('\n'));
  console.error(e);
  process.exit(1);
});
