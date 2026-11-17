// Keeper integration test on a local mainnet fork with the real FWA pool and Shapes.
// Starts its own anvil (port E2E_PORT, default 18546), deploys via script/Deploy.s.sol, creates two
// Balancers via script/DevSetup.s.sol, then exercises the keeper. Run: npm run keeper:e2e
import assert from 'node:assert/strict';
import { execSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, createTestClient, createWalletClient, decodeEventLog, http, getAddress, keccak256, parseAbi, toBytes, toHex, type Address } from 'viem';
import { balancerFactoryAbi, fwaPoolAbi, poolBalancerAbi } from '../shared/abi';
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

const pub = createPublicClient({ pollingInterval: 100, transport: http(RPC, { timeout: 60_000 }) });
const test = createTestClient({ mode: 'anvil', transport: http(RPC, { timeout: 60_000 }) });
const wallet = createWalletClient({ transport: http(RPC, { timeout: 60_000 }) });
const logs: string[] = [];

async function main() {
  try {
    execSync(`lsof -nP -iTCP:${PORT} -sTCP:LISTEN`, { stdio: 'ignore' });
    throw new Error(`port ${PORT} busy; set E2E_PORT`);
  } catch (e) {
    if ((e as Error).message.includes('busy')) throw e;
  }
  const anvil = spawn('anvil', ['--fork-url', 'https://mainnet.gateway.tenderly.co', '--fork-block-number', FORK_BLOCK.toString(), '--port', String(PORT), '--chain-id', '31337', '--silent'], { stdio: 'ignore', detached: process.env.E2E_KEEP_NODE === '1' });
  let succeeded = false;
  try {
    for (let i = 0; i < 50; i++) {
      try { await pub.getBlockNumber(); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
    await run();
    console.log(process.env.E2E_RECOVERY_ONLY === '1' ? 'KEEPER RECOVERY E2E PASSED' : 'KEEPER E2E PASSED');
    succeeded = true;
  } finally {
    if (succeeded && process.env.E2E_KEEP_NODE === '1') {
      console.log('KEEPER_E2E_NODE', JSON.stringify({ pid: anvil.pid, rpc: RPC, factory, creator: ACCTS[1] }));
      anvil.unref();
    } else anvil.kill();
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
    if (await done() && Object.keys(k.state.pending).length === 0) return;
  }
  const info = [];
  for (const b of k.state.balancers) {
    const pool = (await pub.readContract({ address: b, abi: poolBalancerAbi, functionName: 'pool' })) as Address;
    info.push({ b, status: await status(b).catch(() => -1), unsettled: String(await pub.readContract({ address: pool, abi: fwaPoolAbi, functionName: 'unsettledAcquisitionCount' }).catch(() => -1)), seq: String(await pub.readContract({ address: pool, abi: fwaPoolAbi, functionName: 'lastIssuedSequence' }).catch(() => -1)), active: String(await pub.readContract({ address: pool, abi: fwaPoolAbi, functionName: 'activeListingCount' }).catch(() => -1)) });
  }
  throw new Error('condition not reached ' + JSON.stringify(info));
}

/** Buy `count` draws directly through FWA with ETH and deliver randomness. `purchaser` defaults to `buyer`. */
async function buyAndSettle(b: Address, count: number, buyer: Address, word: bigint, purchaser: Address = buyer, settle = true) {
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
  if (!settle) return;
  const coord = (await pub.readContract({ address: VRF_SERVICE, abi: serviceAbi, functionName: 'coordinator' })) as Address;
  await test.impersonateAccount({ address: coord });
  await test.setBalance({ address: coord, value: 10n ** 18n });
  for (let s = Number(before) + 1; s <= Number(before) + count; s++) {
    const id = await pub.readContract({ address: pool, abi: fwaPoolAbi, functionName: 'requestIdAtSequence', args: [BigInt(s)] });
    const fh = await wallet.writeContract({ address: VRF_SERVICE, abi: serviceAbi, functionName: 'rawFulfillRandomWords', args: [id as bigint, [BigInt(keccak256(toHex(word * 1000n + BigInt(s))))]], account: coord, chain: null, gas: 5_000_000n });
    await pub.waitForTransactionReceipt({ hash: fh });
  }
  // Nobody processes FWA's queue here: draws the randomness fast path skips wait for the keeper's upkeep (D16).
}

async function run() {
  sh(`PACKS_ADMIN=${ACCTS[0]} KEEPER_ADMIN=${ACCTS[0]} POLICY_ADMIN=${ACCTS[0]} forge script script/Deploy.s.sol --rpc-url ${RPC} --unlocked --sender ${ACCTS[0]} --broadcast`);
  factory = JSON.parse(readFileSync('deployments/31337.json', 'utf8')).balancerFactory;
  const b1 = await setupPool(ACCTS[1]);
  const b2 = await setupPool(ACCTS[2]);
  console.log('balancers', b1, b2);
  const hardMaxReward = await pub.readContract({ address: b1, abi: poolBalancerAbi, functionName: 'HARD_MAX_KEEPER_REWARD' } as never) as bigint;

  const dir = mkdtempSync(join(tmpdir(), 'keeper-e2e-'));
  const stateFile = join(dir, 'state.json');
  // Fresh code-free keeper address: Hardhat test accounts carry EIP-7702 sweeper delegations on mainnet.
  const keeperAddr = '0x00000000000000000000000000000000000ce3e5' as Address;
  await test.impersonateAccount({ address: keeperAddr });
  await test.setBalance({ address: keeperAddr, value: 10n ** 18n });
  const mk = (replaceAfterBlocks = 2) => new Keeper({ rpcUrl: RPC, factory, fromBlock: FORK_BLOCK, stateFile, account: keeperAddr, replaceAfterBlocks, maxLossWei: 10n ** 14n, log: (m, e) => logs.push(`${m} ${JSON.stringify(e ?? {})}`) });
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
  checkAudit(k, hardMaxReward);

  // 3. restart from persisted state: no rediscovery duplicates, no redundant sends
  const sentBefore = k.state.stats.sent;
  k = mk();
  await k.tick();
  await k.tick();
  assert.equal(k.state.balancers.length, 2);
  assert.equal(k.state.stats.sent, sentBefore, 'no redundant sends after restart');
  console.log('✓ restart resumes without duplicate work');

  // 3b. crash right after broadcasting, before the hash was saved: the restart must not send a second upkeep
  await buyAndSettle(b1, 1, '0x00000000000000000000000000000000000b0b04', 11n);
  await test.setAutomine(false);
  await k.tick();
  const crashed = k.state.pending[b1];
  assert.ok(crashed, 'upkeep in flight');
  const crashedHash = crashed.hashes[0];
  const statsBeforeCrash = { ...k.state.stats };
  crashed.offers = {};
  crashed.hashes = []; // the state file as written before the broadcast
  k.save();
  const sentBeforeCrash = k.state.stats.sent;
  k = mk();
  await k.tick();
  assert.equal(k.state.stats.sent, sentBeforeCrash, 'no second upkeep after the restart');
  assert.equal(await pub.getTransactionCount({ address: keeperAddr, blockTag: 'pending' }), crashed.nonce + 1, 'one transaction at that nonce');
  await test.mine({ blocks: 1 });
  await test.setAutomine(true);
  const readNonce = k.pub.getTransactionCount;
  k.pub.getTransactionCount = (args) => args.blockNumber !== undefined ? Promise.reject(new Error('historical RPC unavailable')) : readNonce(args);
  await k.tick();
  assert.ok(k.state.pending[b1], 'historical RPC failure retains receipt accounting');
  assert.equal(k.state.stats.mined, statsBeforeCrash.mined, 'failed historical read invents no receipt');
  assert.ok(k.errors[b1]?.includes('historical RPC unavailable'), 'historical RPC failure is visible');
  k.pub.getTransactionCount = readNonce;
  await tickUntil(k, async () => (await stocked(b1)) && Object.keys(k.state.pending).length === 0);
  const recoveredReceipt = await pub.getTransactionReceipt({ hash: crashedHash });
  let recoveredReward = 0n;
  for (const log of recoveredReceipt.logs) {
    if (log.address.toLowerCase() !== b1.toLowerCase()) continue;
    try {
      const event = decodeEventLog({ abi: poolBalancerAbi, data: log.data, topics: log.topics });
      if (event.eventName === 'KeeperPaid') recoveredReward += event.args.amount;
    } catch {}
  }
  const recoveredCost = recoveredReceipt.gasUsed * recoveredReceipt.effectiveGasPrice;
  assert.equal(k.state.stats.mined, statsBeforeCrash.mined + 1, 'lost response receipt counted');
  assert.equal(BigInt(k.state.stats.earnedWei), BigInt(statsBeforeCrash.earnedWei) + recoveredReward, 'lost response reward recovered exactly');
  assert.equal(BigInt(k.state.stats.spentWei), BigInt(statsBeforeCrash.spentWei) + recoveredCost, 'lost response gas recovered exactly');
  const recoveredStats = { ...k.state.stats };
  await k.tick();
  assert.deepEqual(k.state.stats, recoveredStats, 'recovered receipt is counted only once');
  console.log('✓ restart recovers unrecorded receipt and exact costs/rewards once without duplicate work');
  // An evicted, hashless send can be mined by a peer after the real pending-nonce read and before slot release.
  await buyAndSettle(b1, 1, '0x00000000000000000000000000000000000b0b17', 71n);
  k = mk(0);
  await test.setAutomine(false);
  await k.tick();
  const eviction = k.state.pending[b1];
  const evictedHash = eviction.hashes[0];
  const evictedTx = await pub.getTransaction({ hash: evictedHash });
  const beforeEviction = { ...k.state.stats };
  eviction.hashes = [];
  eviction.offers = {};
  k.save();
  await test.dropTransaction({ hash: evictedHash });
  const actualNonceRead = k.pub.getTransactionCount;
  let peerMinedAtBoundary = false;
  k.pub.getTransactionCount = async (args) => {
    const actual = await actualNonceRead(args);
    if (!peerMinedAtBoundary && args.blockTag === 'pending') {
      assert.equal(actual, eviction.nonce, 'real read observes the transaction evicted');
      peerMinedAtBoundary = true;
      await wallet.sendTransaction({ account: keeperAddr, to: evictedTx.to!, data: evictedTx.input, nonce: evictedTx.nonce, gas: evictedTx.gas, maxFeePerGas: evictedTx.maxFeePerGas!, maxPriorityFeePerGas: evictedTx.maxPriorityFeePerGas!, chain: null });
      await test.mine({ blocks: 1 });
      await test.setAutomine(true);
    }
    return actual; // actual successful RPC answer; the intervening chain transition creates the race
  };
  await k.tick();
  k.pub.getTransactionCount = actualNonceRead;
  assert.ok(peerMinedAtBoundary, 'peer mined the original at the eviction boundary');
  assert.ok(k.state.accounting[String(eviction.nonce)], 'evicted send stays in accounting after slot release');
  await k.tick();
  const evictionReceipt = await pub.getTransactionReceipt({ hash: evictedHash });
  const evictionReward = evictionReceipt.logs.reduce((sum, log) => {
    if (log.address.toLowerCase() !== b1.toLowerCase()) return sum;
    try { const event = decodeEventLog({ abi: poolBalancerAbi, data: log.data, topics: log.topics }); return event.eventName === 'KeeperPaid' ? sum + event.args.amount : sum; } catch { return sum; }
  }, 0n);
  assert.equal(k.state.stats.mined, beforeEviction.mined + 1, 'boundary-mined receipt counted once');
  assert.equal(BigInt(k.state.stats.spentWei), BigInt(beforeEviction.spentWei) + evictionReceipt.gasUsed * evictionReceipt.effectiveGasPrice, 'boundary-mined gas recovered exactly');
  assert.equal(BigInt(k.state.stats.earnedWei), BigInt(beforeEviction.earnedWei) + evictionReward, 'boundary-mined reward recovered exactly');
  assert.equal(k.state.accounting[String(eviction.nonce)], undefined, 'canonical receipt clears its retry nonce');
  const afterEviction = { ...k.state.stats };
  await k.tick();
  assert.deepEqual(k.state.stats, afterEviction, 'boundary receipt is never accounted twice');
  console.log('✓ peer-mined eviction boundary preserves exact once-only financial accounting');
  if (process.env.E2E_RECOVERY_ONLY === '1') return;

  // 4. A known pending transaction is replaced at the same nonce. Keep it in the node's mempool; mining blocks
  //    above its fee cap can evict it on Anvil, which exercises resending instead of replacement.
  await buyAndSettle(b1, 1, '0x00000000000000000000000000000000000b0b03', 7n);
  k = mk(0);
  await test.setAutomine(false);
  await k.tick();
  assert.equal(Object.keys(k.state.pending).length, 1, 'one pending');
  const p = k.state.pending[b1];
  const nonceBeforeReplacement = p.nonce;
  const replacementsBefore = k.state.stats.replaced;
  await k.tick();
  assert.equal(k.state.stats.replaced, replacementsBefore + 1, 'known transaction replaced');
  assert.equal(k.state.pending[b1].nonce, nonceBeforeReplacement, 'replacement keeps nonce');
  const replacementBase = (BigInt(p.maxFeePerGas) - BigInt(p.maxPriorityFeePerGas)) / 2n;
  await test.setNextBlockBaseFeePerGas({ baseFeePerGas: replacementBase });
  await test.mine({ blocks: 1 });
  await test.setAutomine(true);
  await tickUntil(k, async () => (await stocked(b1)));
  assert.equal(Object.keys(k.state.pending).length, 0);
  console.log('✓ replacement tx mined; stats', JSON.stringify(k.state.stats));
  k = mk();

  // 5. reorg: a Balancer created in a reorged-out block is dropped
  const beforeReorg = { ...k.state.stats };
  const snap = await test.snapshot();
  const b3 = await setupPool(ACCTS[1], '1');
  await k.tick();
  await k.tick(); // observe the first receipt before orphaning it; the next fill may be pending
  assert.equal(k.state.balancers.length, 3);
  assert.ok(k.state.receipts.some((r) => r.balancer === b3), 'receipt journal observed the future orphan');
  const orphanedHashes = [...k.state.receipts.filter((r) => r.balancer === b3).map((r) => r.hash), ...k.state.pending[b3].hashes];
  const orphanedTransactions = await Promise.all(orphanedHashes.map((hash) => pub.getTransaction({ hash })));
  await test.revert({ id: snap });
  await k.tick();
  assert.equal(k.state.balancers.length, 2, 'reorged balancer dropped');
  assert.ok(!k.state.balancers.includes(b3));
  assert.equal(k.state.stats.mined, beforeReorg.mined, 'orphaned success rolled back');
  assert.equal(k.state.stats.spentWei, beforeReorg.spentWei, 'orphaned gas rolled back');
  assert.equal(k.state.stats.earnedWei, beforeReorg.earnedWei, 'orphaned reward rolled back');
  assert.equal(await pub.getCode({ address: b3 }), undefined, 'orphaned pool has no code');
  const sentBeforePeer = k.state.stats.sent;
  const graceHead = Object.values(k.state.accounting).reduce((n, r) => BigInt(r.pending.sentBlock) > n ? BigInt(r.pending.sentBlock) : n, 0n) + 3n;
  const headBeforePeer = await pub.getBlockNumber({ cacheTime: 0 });
  if (graceHead > headBeforePeer) await test.mine({ blocks: Number(graceHead - headBeforePeer) });
  await k.tick();
  assert.equal(k.state.stats.sent, sentBeforePeer, 'accounting retries never send duplicate or cancellation transactions');
  assert.equal(k.health().ok, false, 'unconsumed orphaned nonce requires operator action');
  assert.ok(Object.values(k.health().accounting.errors).some((e) => e.includes('operator rebroadcast or cancellation')), 'blocked orphaned nonce is visible');
  console.log('✓ without peer rebroadcast, orphaned nonce stays tracked and reports operator action without spending');
  await test.setAutomine(false);
  for (const tx of orphanedTransactions) {
    const known = await pub.getTransaction({ hash: tx.hash }).catch(() => null);
    if (known && known.blockNumber === null) continue;
    // A peer may rebroadcast an orphaned transaction. The accounting retry queue itself never broadcasts.
    await wallet.sendTransaction({ account: keeperAddr, to: tx.to!, data: tx.input, nonce: tx.nonce, gas: tx.gas, maxFeePerGas: tx.maxFeePerGas!, maxPriorityFeePerGas: tx.maxPriorityFeePerGas!, chain: null });
  }
  await test.mine({ blocks: 1 });
  await test.setAutomine(true);
  await k.tick();
  assert.equal(Object.keys(k.state.accounting).length, 0, 're-mined accounting retry queue cleared');
  assert.ok(BigInt(k.state.stats.spentWei) > BigInt(beforeReorg.spentWei), 'real gas charged for re-mined empty-target transaction');
  assert.equal(k.state.stats.earnedWei, beforeReorg.earnedWei, 'empty target paid no reward');
  assert.equal(k.health().ok, true, 'operator rebroadcast clears accounting action requirement');
  console.log('✓ reorg rolls back orphaned receipts and accounts re-mined empty-target gas');

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
  //    `recoverRefunded` remains available for real external delivery failures.
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
  checkAudit(k, hardMaxReward, new Set([b3]));

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

  // 9b. keeper list (on the factory, keeper admin = deployer): while restricted to other keepers the pool is skipped
  //     quietly; once approved, it is serviced
  const restrict = async (fn: 'setKeepersRestricted' | 'setKeeperApproved', args: readonly unknown[]) => {
    const h = await wallet.writeContract({ address: factory, abi: balancerFactoryAbi, functionName: fn, args: args as never, account: ACCTS[0] as Address, chain: null });
    assert.equal((await pub.waitForTransactionReceipt({ hash: h })).status, 'success');
  };
  await restrict('setKeepersRestricted', [true]);
  await buyAndSettle(b1, 1, '0x00000000000000000000000000000000000b0b08', 41n);
  const sentBeforeList = k.state.stats.sent;
  await k.tick();
  assert.equal(k.state.stats.sent, sentBeforeList, 'no send to a pool that has not approved this keeper');
  assert.ok(!k.errors[b1], 'a restricted pool is not reported as an error');
  await restrict('setKeeperApproved', [keeperAddr, true]);
  await tickUntil(k, async () => (await stocked(b1)));
  await restrict('setKeepersRestricted', [false]);
  console.log('✓ keeper list: skipped while not approved, serviced once approved');

  // Quote and receipt calibration at the three requested total transaction gas prices, with fee fields pinned.
  for (const gasPrice of [150_000_000n, 500_000_000n, 5_000_000_000n]) {
    await buyAndSettle(b1, 1, '0x00000000000000000000000000000000000b0b10', gasPrice);
    const auditStart = k.audit.length;
    const baseFee = gasPrice - 50_000_000n;
    let complete = false;
    for (let i = 0; i < 12; i++) {
      await test.setNextBlockBaseFeePerGas({ baseFeePerGas: baseFee });
      await test.mine({ blocks: 1 });
      await test.setNextBlockBaseFeePerGas({ baseFeePerGas: baseFee });
      await k.tick();
      if (await stocked(b1) && Object.keys(k.state.pending).length === 0) { complete = true; break; }
    }
    assert.ok(complete, `work completed at ${gasPrice} wei transaction gas price`);
    const receipts = k.audit.slice(auditStart).filter((a) => a.balancer === b1);
    assert.ok(receipts.length > 0, 'a real keeper transaction was mined');
    const net = receipts.reduce((sum, a) => sum + a.reward - a.cost, 0n);
    assert.ok(net > 0n, `keeper has positive receipt-based profit at ${gasPrice} wei`);
    for (const a of receipts) {
      assert.equal(a.cost / a.gasUsed, gasPrice, 'actual receipt gas price matches the named context');
      assert.ok(a.reward > 0n && a.reward >= a.minimumReward, 'positive payment satisfies the accepted floor');
    }
    console.log('keeper calibration', JSON.stringify({ transactionGasPriceWei: gasPrice.toString(), netWei: net.toString(), receipts: receipts.map((a) => ({ estimate: a.gasEstimate.toString(), expenseGas: a.expenseGas.toString(), source: a.expenseSource, billed: a.gasUsed.toString(), rewardWei: a.reward.toString() })) }));
  }

  // Expiry-only reconciliation at 5 gwei uses real FWA timeout processing and no randomness impersonation.
  const timeoutBuyer = '0x00000000000000000000000000000000000b0b15' as Address;
  await buyAndSettle(b1, 1, timeoutBuyer, 0n, timeoutBuyer, false);
  await test.mine({ blocks: 31 });
  const timeoutStart = k.audit.length;
  let timeoutComplete = false;
  for (let i = 0; i < 12; i++) {
    await test.setNextBlockBaseFeePerGas({ baseFeePerGas: 4_950_000_000n });
    await test.mine({ blocks: 1 });
    await test.setNextBlockBaseFeePerGas({ baseFeePerGas: 4_950_000_000n });
    await k.tick();
    if (await stocked(b1) && Object.keys(k.state.pending).length === 0) { timeoutComplete = true; break; }
  }
  assert.ok(timeoutComplete, 'real timeout reconciled');
  const timeoutReceipts = k.audit.slice(timeoutStart).filter((a) => a.balancer === b1);
  assert.ok(timeoutReceipts.length > 0, 'timeout paid real keeper receipts');
  const timeoutNet = timeoutReceipts.reduce((sum, a) => sum + a.reward - a.cost, 0n);
  for (const a of timeoutReceipts) assert.equal(a.cost / a.gasUsed, 5_000_000_000n, 'timeout receipt gas context');
  console.log('timeout keeper calibration', JSON.stringify({ transactionGasPriceWei: '5000000000', netWei: timeoutNet.toString(), receipts: timeoutReceipts.map((a) => ({ estimate: a.gasEstimate.toString(), expenseGas: a.expenseGas.toString(), source: a.expenseSource, billed: a.gasUsed.toString(), rewardWei: a.reward.toString() })) }));
  assert.ok(timeoutNet > 0n, 'timeout-only keeper has positive receipt-based profit at5gwei');

  // Factory defaults are future-only. V2 has a different formula and no optional settings() metadata.
  const v1Policy = await pub.readContract({ address: b1, abi: poolBalancerAbi, functionName: 'keeperPolicy' } as never) as Address;
  const v2Artifact = JSON.parse(readFileSync('out/Settings.t.sol/KeeperPolicyV2.json', 'utf8'));
  const deployedV2 = await wallet.deployContract({ abi: v2Artifact.abi, bytecode: v2Artifact.bytecode.object, account: ACCTS[0], chain: null });
  const v2Receipt = await pub.waitForTransactionReceipt({ hash: deployedV2 });
  assert.equal(v2Receipt.status, 'success');
  const v2 = getAddress(v2Receipt.contractAddress!);
  const writeFactory = async (functionName: string, args: readonly unknown[] = []) => {
    const hash = await wallet.writeContract({ address: factory, abi: balancerFactoryAbi, functionName, args, account: ACCTS[0], chain: null } as never);
    assert.equal((await pub.waitForTransactionReceipt({ hash })).status, 'success', functionName);
  };
  await writeFactory('proposeDefaultKeeperPolicy', [v2]);
  await test.increaseTime({ seconds: 2 * 86_400 });
  await test.mine({ blocks: 1 });
  await writeFactory('activateDefaultKeeperPolicy');
  for (const b of [b1, b2]) assert.equal(await pub.readContract({ address: b, abi: poolBalancerAbi, functionName: 'keeperPolicy' } as never), v1Policy, 'old pool remains V1');
  const upgradedPool = await setupPool(ACCTS[1], '2');
  assert.equal(await pub.readContract({ address: upgradedPool, abi: poolBalancerAbi, functionName: 'keeperPolicy' } as never), v2, 'new pool starts V2');
  const setupRevertedBefore = k.state.stats.reverted;
  await tickUntil(k, async () => await stocked(upgradedPool));
  assert.equal(k.state.stats.reverted, setupRevertedBefore, 'falling basefee does not cause minimum-payment reverts');
  assert.equal(k.policies[upgradedPool].address, v2, 'shared keeper discovers V2 without formula changes');

  const propose = await wallet.writeContract({ address: b1, abi: poolBalancerAbi, functionName: 'proposeKeeperPolicy', args: [v2], account: ACCTS[1], chain: null } as never);
  assert.equal((await pub.waitForTransactionReceipt({ hash: propose })).status, 'success');
  await assert.rejects(pub.simulateContract({ address: b1, abi: poolBalancerAbi, functionName: 'activateKeeperPolicy', account: ACCTS[0] } as never), 'creator switch is delayed');
  await test.increaseTime({ seconds: 2 * 86_400 });
  await test.mine({ blocks: 1 });
  await buyAndSettle(b1, 1, '0x00000000000000000000000000000000000b0b11', 45n);
  await test.setAutomine(false);
  await k.tick();
  const oldOffer = k.state.pending[b1];
  assert.ok(oldOffer?.hashes.length, 'V1-priced keeper transaction pending');
  const oldHash = oldOffer.hashes[0];
  // Higher priority gives the activation first position in the local block, explicitly testing the inclusion race.
  const activated = await wallet.writeContract({ address: b1, abi: poolBalancerAbi, functionName: 'activateKeeperPolicy', account: ACCTS[0], chain: null, gas: 2_000_000n, maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n } as never);
  await test.mine({ blocks: 1 });
  await test.setAutomine(true);
  assert.equal((await pub.waitForTransactionReceipt({ hash: activated })).status, 'success');
  const stale = await pub.waitForTransactionReceipt({ hash: oldHash });
  assert.equal(stale.status, 'reverted', 'old policy offer reverts atomically after activation');
  const revertedBefore = k.state.stats.reverted;
  await tickUntil(k, async () => await stocked(b1) && Object.keys(k.state.pending).length === 0);
  assert.equal(k.state.stats.reverted, revertedBefore + 1, 'stale attempt expense is accounted');
  assert.equal(await pub.readContract({ address: b1, abi: poolBalancerAbi, functionName: 'keeperPolicy' } as never), v2);
  assert.equal(await pub.readContract({ address: b2, abi: poolBalancerAbi, functionName: 'keeperPolicy' } as never), v1Policy);
  for (const [i, b] of [b1, b2, upgradedPool].entries()) await buyAndSettle(b, 1, `0x00000000000000000000000000000000000b0b${12 + i}` as Address, 50n + BigInt(i));
  await tickUntil(k, async () => (await stocked(b1)) && (await stocked(b2)) && (await stocked(upgradedPool)));
  console.log('✓ mixed V1/V2 service, delayed funded switch and stale pending transaction recovery');

  // A policy-changing replacement may be accepted by the node before its response/metadata reaches disk.
  const replaceProposal = await wallet.writeContract({ address: b2, abi: poolBalancerAbi, functionName: 'proposeKeeperPolicy', args: [v2], account: ACCTS[2], chain: null } as never);
  assert.equal((await pub.waitForTransactionReceipt({ hash: replaceProposal })).status, 'success');
  await test.increaseTime({ seconds: 2 * 86_400 });
  await test.mine({ blocks: 1 });
  await buyAndSettle(b2, 1, '0x00000000000000000000000000000000000b0b16', 61n);
  k = mk(0);
  await test.setAutomine(false);
  await k.tick();
  const beforeReplacement = structuredClone(k.state.pending[b2]);
  assert.ok(beforeReplacement, 'old-policy offer queued');
  const replacementStats = { ...k.state.stats };
  await test.setBlockGasLimit({ gasLimit: 2_000_000n });
  const activationOnly = await wallet.writeContract({ address: b2, abi: poolBalancerAbi, functionName: 'activateKeeperPolicy', account: ACCTS[0], chain: null, gas: 2_000_000n, maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n } as never);
  await test.mine({ blocks: 1 });
  assert.equal((await pub.waitForTransactionReceipt({ hash: activationOnly })).status, 'success');
  assert.equal(await pub.getTransactionReceipt({ hash: beforeReplacement.hashes[0] }).catch(() => null), null, 'old4M-gas offer did not fit the activation-only block');
  await test.setBlockGasLimit({ gasLimit: 30_000_000n });
  await k.tick();
  const replacementHash = k.state.pending[b2].hashes.at(-1)!;
  assert.notEqual(replacementHash, beforeReplacement.hashes[0], 'new-policy replacement accepted');
  k.state.pending[b2] = beforeReplacement; // persisted state from before the real broadcast response arrived
  k.save();
  k = mk();
  await test.mine({ blocks: 1 });
  await test.setAutomine(true);
  await tickUntil(k, async () => await stocked(b2));
  const replacementReceipt = await pub.getTransactionReceipt({ hash: replacementHash });
  assert.equal(replacementReceipt.status, 'success');
  assert.equal(k.state.stats.mined, replacementStats.mined + 1, 'replacement receipt recovered under its actual policy hash');
  assert.equal(BigInt(k.state.stats.spentWei), BigInt(replacementStats.spentWei) + replacementReceipt.gasUsed * replacementReceipt.effectiveGasPrice, 'replacement gas recovered once');
  assert.equal(k.audit.find((a) => a.hash === replacementHash)?.policy, undefined, 'unknown replacement policy is not mislabeled with old policy metadata');
  console.log('✓ policy-changing replacement response loss recovers actual receipt and calldata floors');

  // 10. A creator's emergency payment disable affects only that pool. No protocol code or storage is replaced.
  await buyAndSettle(b1, 2, '0x00000000000000000000000000000000000b0b04', 5n);
  const disabled = await wallet.writeContract({ address: b2, abi: poolBalancerAbi, functionName: 'setPaidUpkeepEnabled', args: [false], account: ACCTS[2], chain: null } as never);
  assert.equal((await pub.waitForTransactionReceipt({ hash: disabled })).status, 'success');
  await buyAndSettle(b2, 1, '0x00000000000000000000000000000000000b0b09', 6n);
  await tickUntil(k, async () => (await stocked(b1)));
  assert.equal(k.policies[b2].paid, false, 'disabled pool is observed');
  assert.equal(k.errors[b2], undefined, 'disabled pool is skipped quietly');
  assert.equal(await stocked(b2), false, 'keeper does not perform paid work while disabled');
  const unpaid = await wallet.writeContract({ address: b2, abi: poolBalancerAbi, functionName: 'performUpkeepUnpaid', account: ACCTS[2], chain: null, gas: 4_000_000n } as never);
  assert.equal((await pub.waitForTransactionReceipt({ hash: unpaid })).status, 'success');
  assert.equal(k.health().balancers, 3);
  console.log('✓ per-pool payment disable and unpaid maintenance; health', JSON.stringify(k.health()));
  const canonicalHead = await pub.getBlockNumber({ cacheTime: 0 });
  const canonicalTransactions = [];
  for (let block = FORK_BLOCK + 1n; block <= canonicalHead; block++) {
    const row = await pub.getBlock({ blockNumber: block, includeTransactions: true });
    canonicalTransactions.push(...row.transactions.filter((t) => typeof t !== 'string' && t.from.toLowerCase() === keeperAddr.toLowerCase()));
  }
  let canonicalGas = 0n, canonicalRewards = 0n, canonicalSuccess = 0, canonicalReverts = 0;
  for (const tx of canonicalTransactions) {
    if (typeof tx === 'string') continue;
    const receipt = await pub.getTransactionReceipt({ hash: tx.hash });
    canonicalGas += receipt.gasUsed * receipt.effectiveGasPrice;
    if (receipt.status === 'success') canonicalSuccess++; else canonicalReverts++;
    for (const log of receipt.logs) {
      if (![b1, b2, upgradedPool, b3].some((b) => b.toLowerCase() === log.address.toLowerCase())) continue;
      try {
        const event = decodeEventLog({ abi: poolBalancerAbi, data: log.data, topics: log.topics });
        if (event.eventName === 'KeeperPaid' && event.args.keeper.toLowerCase() === keeperAddr.toLowerCase()) canonicalRewards += event.args.amount;
      } catch {}
    }
  }
  assert.equal(k.state.stats.mined, canonicalSuccess, 'health success count matches canonical transactions');
  assert.equal(k.state.stats.reverted, canonicalReverts, 'health failure count matches canonical transactions');
  assert.equal(BigInt(k.state.stats.spentWei), canonicalGas, 'health gas expense matches every canonical receipt');
  assert.equal(BigInt(k.state.stats.earnedWei), canonicalRewards, 'health rewards match canonical pool events');
  console.log('canonical keeper accounting', JSON.stringify({ transactions: canonicalTransactions.length, success: canonicalSuccess, reverted: canonicalReverts, gasWei: canonicalGas.toString(), rewardsWei: canonicalRewards.toString() }));
  checkAudit(k, hardMaxReward, new Set([b3]));
}

/** Actual receipts calibrate the execution estimate and verify each transaction's accepted payment floor. */
function checkAudit(k: Keeper, hardMaxReward: bigint, reorgedPools = new Set<Address>()) {
  const rows = k.audit.map((a) => ({ gasUsed: Number(a.gasUsed), estimate: Number(a.gasEstimate), estimateMinusBilled: Number(a.gasEstimate - a.gasUsed), expenseGas: Number(a.expenseGas), source: a.expenseSource, expenseMinusBilled: Number(a.expenseGas - a.gasUsed), measuredGas: Number(a.measuredGas), rewardWei: a.reward.toString(), costWei: a.cost.toString() }));
  console.table(rows);
  for (const a of k.audit) {
    assert.ok(a.reward <= hardMaxReward, `reward ${a.reward} above the immutable maximum (${a.hash})`);
    if (a.status === 'success' && !reorgedPools.has(a.balancer)) assert.ok(a.reward >= a.minimumReward, `reward below accepted minimum (${a.hash})`);
    assert.ok(a.gasEstimate >= a.gasUsed, `receipt exceeded the conservative execution estimate (${a.hash})`);
  }
  console.log('✓ rewards within immutable maximum for', k.audit.length, 'keeper txs');
}

main().catch((e) => {
  console.error(logs.slice(-20).join('\n'));
  console.error(e);
  process.exit(1);
});
