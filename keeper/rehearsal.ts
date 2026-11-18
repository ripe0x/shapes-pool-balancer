// Launch rehearsal on a local mainnet fork: the production deploy script, two pools, the real keeper service
// (`keeper/keeper.ts`, run as its own process exactly as in production) and a driver that only does what players,
// creators and the network do: buys draws on FWA, delivers randomness, moves basefee, edits curated inventory,
// and restarts the keeper process. Nobody calls upkeep by hand.
//
// Checks: buyers find pools open; pools reopen after every batch without intervention; the keeper services below and
// near the 5 gwei cap, waits above it and resumes when gas falls; fallback plans switch on purchase-caused and
// creator-caused curated changes; restarts resume from persisted state; and the keeper's ETH balance reconciles to
// the wei against its gas receipts, reward events and any other value transfers.
// Run: npm run rehearsal [-- --rounds 300]
import assert from 'node:assert/strict';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CurrentRehearsal } from '../scripts/current-local-rehearsal';
import {
  createPublicClient, createTestClient, createWalletClient, decodeEventLog, http, keccak256, parseAbi, parseAbiItem, toHex, type Address, type Hex,
} from 'viem';
import { balancerFactoryAbi, erc721Abi, fwaPoolAbi, poolBalancerAbi, shapesAbi } from '../shared/abi';
import { SHAPES_IN, prizeBase, restockFeeAt } from '../shared/planner';

const PORT = Number(process.env.REHEARSAL_PORT ?? 18547);
const HEALTH = PORT + 300;
const RPC = `http://127.0.0.1:${PORT}`;
const FORK_BLOCK = 26382349n;
const DEPLOYER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const CREATORS = ['0x70997970C51812dc3A010C7d01b50e0d17dc79C8', '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'] as const;
// A fresh address with no code (checked below). The public Hardhat test accounts #3-#6 carry an EIP-7702 delegation on
// mainnet whose receive() forwards incoming ETH to another address, so rewards paid to them leave immediately.
const KEEPER = '0x00000000000000000000000000000000000ce3e5' as Address;
const VRF_SERVICE = '0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d' as const;
const serviceAbi = parseAbi(['function coordinator() view returns (address)', 'function rawFulfillRandomWords(uint256 requestId, uint256[] randomWords)']);
const demoAbi = parseAbi(['function mint(address to, uint256 id)']);
const GWEI = 10n ** 9n;
const FEE_OPTS = { maxFeePerGas: 20n * GWEI, maxPriorityFeePerGas: 0n } as const; // above the highest pinned basefee (8 gwei)

const pub = createPublicClient({ transport: http(RPC) });
const test = createTestClient({ mode: 'anvil', transport: http(RPC) });
const wallet = createWalletClient({ transport: http(RPC) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd: string, env: Record<string, string> = {}) =>
  execSync(cmd, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

let seed = 7n;
const rand = () => { seed = BigInt(keccak256(toHex(seed))); return Number(seed % 1_000_000n) / 1_000_000; };

const read = <T,>(address: Address, abi: readonly unknown[], functionName: string, args: unknown[] = []) =>
  pub.readContract({ address, abi: abi as never, functionName: functionName as never, args: args as never }) as Promise<T>;
const status = (b: Address) => read<number>(b, poolBalancerAbi, 'admissionStatus').then(Number);
/** Admitting, every draw reconciled and the target fully listed: what the keeper restores after each batch. */
async function stocked(b: Address) {
  const pool = await read<Address>(b, poolBalancerAbi, 'pool');
  const [t, have, rec, last] = await Promise.all([
    read<bigint>(b, poolBalancerAbi, 'target'), read<readonly number[]>(b, poolBalancerAbi, 'getActiveShapes'),
    read<bigint>(b, poolBalancerAbi, 'reconciledSequence'), read<bigint>(pool, fwaPoolAbi, 'lastIssuedSequence'),
  ]);
  if (rec !== last) return false;
  for (let d = 0; d < 16; d++) if (Number((t >> BigInt(16 * d)) & 0xffffn) !== Number(have[d])) return false;
  return (await status(b)) === 0;
}

/** Basefee (gwei) by round: mainnet median, with periods below, near and above the 5 gwei reimbursement cap. */
function basefeeFor(round: number): { gwei: number; period: 'normal' | 'below' | 'near' | 'above' } {
  const r = round % 50;
  if (r >= 20 && r < 24) return { gwei: 3, period: 'below' };
  if (r >= 28 && r < 32) return { gwei: 4.9, period: 'near' };
  if (r >= 35 && r < 39) return { gwei: 8, period: 'above' };
  return { gwei: 0.08, period: 'normal' };
}

// anvil adjusts basefee after every block (EIP-1559); every block the driver mines is pinned to the current level,
// and so is the next block, which is where the keeper's transaction lands.
let level = 0.08;
const hold = () => test.setNextBlockBaseFeePerGas({ baseFeePerGas: BigInt(Math.round(level * 1e9)) });
async function setBasefee(gwei: number) {
  level = gwei;
  await hold();
  await test.mine({ blocks: 1 });
  await hold();
}
async function send(p: Record<string, unknown>) {
  await hold();
  // 30% over the estimate, like the keeper and dashboard: FWA listing gas can exceed an exact estimate at inclusion.
  const gas = (p.gas as bigint | undefined) ?? ((await pub.estimateContractGas({ ...p, ...FEE_OPTS } as never)) * 13n) / 10n;
  const h = await wallet.writeContract({ ...p, chain: null, gas, ...FEE_OPTS } as never);
  // anvil automines, so the receipt exists at once; viem's receipt watcher would poll every 4 s.
  let r;
  for (let i = 0; !r; i++) {
    try { r = await pub.getTransactionReceipt({ hash: h }); } catch { if (i > 500) throw new Error(`no receipt for ${h}`); await sleep(20); }
  }
  if (r.status !== 'success') {
    let why = 'unknown';
    try { await pub.simulateContract({ ...p, blockNumber: r.blockNumber - 1n } as never); } catch (e) { why = (e as { shortMessage?: string }).shortMessage ?? String(e); }
    const tx = await pub.getTransaction({ hash: h });
    const blk = await pub.getBlock({ blockNumber: r.blockNumber });
    assert.fail(`tx ${String(p.functionName)} reverted in block ${r.blockNumber} (gas ${r.gasUsed}/${tx.gas}, ${blk.transactions.length} txs in block, index ${r.transactionIndex}): ${why}`);
  }
  await hold();
  return r;
}

async function buyAndSettle(b: Address, count: number, buyer: Address, words: bigint[]) {
  const pool = await read<Address>(b, poolBalancerAbi, 'pool');
  await test.impersonateAccount({ address: buyer });
  await test.setBalance({ address: buyer, value: 10n ** 21n });
  const [, , total] = await read<readonly [bigint, bigint, bigint]>(pool, fwaPoolAbi, 'quoteAcquisitionPrice', [BigInt(count)]);
  const v = await read<bigint>(pool, fwaPoolAbi, 'inventoryVersion');
  const before = Number(await read<bigint>(pool, fwaPoolAbi, 'lastIssuedSequence'));
  const now = (await pub.getBlock()).timestamp;
  await send({ address: pool, abi: fwaPoolAbi, functionName: 'acquireBatch', args: [buyer, BigInt(count), 0n, 0n, 10_000n, v, now + 600n], value: total * 3n + 10n ** 17n, account: buyer, gas: 3_000_000n });
  for (let i = 0; i < 3; i++) { await hold(); await test.mine({ blocks: 1 }); }
  const coord = await read<Address>(VRF_SERVICE, serviceAbi, 'coordinator');
  await test.impersonateAccount({ address: coord });
  await test.setBalance({ address: coord, value: 10n ** 20n });
  for (let s = before + 1; s <= before + count; s++) {
    const id = await read<bigint>(pool, fwaPoolAbi, 'requestIdAtSequence', [BigInt(s)]);
    await send({ address: VRF_SERVICE, abi: serviceAbi, functionName: 'rawFulfillRandomWords', args: [id, [words[s - before - 1]]], account: coord, gas: 5_000_000n });
  }
  // Nobody processes FWA's queue here: draws the randomness fast path skips wait for the keeper's upkeep (D16).
}

async function main() {
  const roundsArg = process.argv.indexOf('--rounds');
  const ROUNDS = roundsArg > 0 ? Number(process.argv[roundsArg + 1]) : 150;
  const anvil = spawn('anvil', ['--fork-url', 'https://mainnet.gateway.tenderly.co', '--fork-block-number', FORK_BLOCK.toString(), '--port', String(PORT), '--chain-id', '31337', '--silent'], { stdio: 'ignore' });
  let keeper: ChildProcess | undefined;
  const keeperLog: string[] = [];
  try {
    for (let i = 0; i < 300; i++) { try { await pub.getBlockNumber(); break; } catch { await sleep(200); } }
    assert.equal(await pub.getCode({ address: KEEPER, blockNumber: FORK_BLOCK }), undefined, 'keeper has no code or delegation at the fork block');
    sh(`PACKS_ADMIN=${DEPLOYER} KEEPER_ADMIN=${DEPLOYER} POLICY_ADMIN=${DEPLOYER} forge script script/Deploy.s.sol --rpc-url ${RPC} --unlocked --sender ${DEPLOYER} --broadcast`);
    const factory = JSON.parse(readFileSync('deployments/31337.json', 'utf8')).balancerFactory as Address;
    const balancers: Address[] = [];
    const demo: Address[] = [];
    for (const c of CREATORS) {
      const out = sh(`forge script script/DevSetup.s.sol --tc DevSetup --rpc-url ${RPC} --unlocked --sender ${c} --broadcast`, { FACTORY: factory });
      balancers.push(out.match(/Balancer (0x[0-9a-fA-F]{40})/)![1] as Address);
      demo.push(out.match(/DemoNFT (0x[0-9a-fA-F]{40})/)![1] as Address);
    }
    const [bA, bB] = balancers;

    // Keeper account: fresh, funded once by the harness; this funding precedes the reconciliation window.
    await test.impersonateAccount({ address: KEEPER });
    await test.setBalance({ address: KEEPER, value: 10n ** 18n });
    await setBasefee(0.08);
    const kb0 = await pub.getBalance({ address: KEEPER });
    const startBlock = await pub.getBlockNumber();

    const dir = mkdtempSync(join(tmpdir(), 'rehearsal-'));
    const startKeeper = () => {
      const k = spawn('npx', ['tsx', 'keeper/keeper.ts'], {
        env: { ...process.env, RPC_URL: RPC, FACTORY: factory, FROM_BLOCK: FORK_BLOCK.toString(), KEEPER_PRIVATE_KEY: '', KEEPER_ADDRESS: KEEPER, STATE_FILE: join(dir, 'state.json'), POLL_MS: '800', HEALTH_PORT: String(HEALTH) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      k.stdout!.on('data', (d) => keeperLog.push(...d.toString().trim().split('\n')));
      k.stderr!.on('data', (d) => keeperLog.push(...d.toString().trim().split('\n')));
      return k;
    };
    keeper = startKeeper();
    const waitOpen = async (b: Address, maxMs: number, pin = false) => {
      const t0 = Date.now();
      while (Date.now() - t0 < maxMs) {
        if (pin) await setBasefee(level);
        if (await stocked(b)) return Date.now() - t0;
        await sleep(300);
      }
      return -1;
    };
    const mustOpen = async (b: Address, why: string, maxMs = 60_000, pin = false) => {
      const t = await waitOpen(b, maxMs, pin);
      if (t < 0) {
        console.error(keeperLog.slice(-25).join('\n'));
        assert.fail(`${why} (status ${await status(b)})`);
      }
      return t;
    };
    for (const b of balancers) await mustOpen(b, `pool ${b} filled and opened by the keeper`, 120_000);
    console.log('pools filled and opened by the keeper service', new Date().toISOString());

    const stats = {
      arrivals: 0, foundOpen: 0, batches: 0, draws: 0, reopenMs: [] as number[],
      byPeriod: { normal: 0, below: 0, near: 0, above: 0 } as Record<string, number>,
      aboveCapWaited: 0, aboveCapSent: 0, resumedAfterSpike: 0,
      markupChanges: 0, creatorEdits: 0, creatorRestocks: 0, restarts: 0,
    };
    let nextDemoId = 100n;
    const curatedCount = async (b: Address) => {
      let n = 0;
      for (const id of await read<bigint[]>(b, poolBalancerAbi, 'getActiveIds')) if (Number((await read<readonly unknown[]>(b, poolBalancerAbi, 'items', [id]))[0]) === 1) n++;
      return n;
    };
    // Buyers draw curated NFTs; like a real creator, list a new one when a pool runs low (it closes at none).
    const restock = async (i: number) => {
      const id = nextDemoId++;
      await test.impersonateAccount({ address: CREATORS[i] });
      await send({ address: demo[i], abi: demoAbi, functionName: 'mint', args: [CREATORS[i], id], account: CREATORS[i] });
      await send({ address: demo[i], abi: erc721Abi, functionName: 'approve', args: [balancers[i], id], account: CREATORS[i] });
      await send({ address: balancers[i], abi: poolBalancerAbi, functionName: 'listCuratedBatch', args: [[{ collection: demo[i], tokenId: id, base: 25n * 10n ** 16n }]], account: CREATORS[i] });
      stats.creatorRestocks++;
    };
    const keepStocked = async () => {
      for (let i = 0; i < balancers.length; i++) {
        const st = await status(balancers[i]);
        if ((st === 0 || st === 3) && (await curatedCount(balancers[i])) < 2) { // 3: NO_CURATED
          await restock(i);
          await mustOpen(balancers[i], 'reopened after a curated restock', 60_000, true);
        }
      }
    };
    for (let round = 0; round < ROUNDS; round++) {
      const { gwei, period } = basefeeFor(round);
      await setBasefee(0.08);
      await keepStocked();
      await setBasefee(gwei);

      // Keeper restarts from persisted state.
      if (round === Math.floor(ROUNDS / 3) || round === Math.floor((2 * ROUNDS) / 3)) {
        keeper.kill();
        await sleep(1500);
        keeper = startKeeper();
        stats.restarts++;
      }

      // Markup change on pool B: existing listings keep their price; prizes restocked afterwards use the new markup.
      if ((round % 50 === 12 || round % 50 === 44) && (await stocked(bB))) {
        const markup = round % 50 === 12 ? 1000 : 1500;
        const t = await read<bigint>(bB, poolBalancerAbi, 'target');
        await test.impersonateAccount({ address: CREATORS[1] });
        await send({ address: bB, abi: poolBalancerAbi, functionName: 'configure', args: [markup, t], account: CREATORS[1] });
        assert.equal(await status(bB), 0, 'a markup change with the target listed keeps purchases open');
        await buyAndSettle(bB, 1, `0x${(0xc0de0000 + round).toString(16).padStart(40, '0')}` as Address, [BigInt(keccak256(toHex(BigInt(round))))]);
        await mustOpen(bB, 'pool B restocked after a markup change', 60_000, true);
        const ids = await read<bigint[]>(bB, poolBalancerAbi, 'getActiveIds');
        const last = await read<readonly unknown[]>(bB, poolBalancerAbi, 'items', [ids.reduce((a, x) => (x > a ? x : a))]);
        if (Number(last[0]) === 2) {
          // Shape prize: base = backing + mint fees + markup on backing; price adds one restocking fee per Shape at the
          // listing block's basefee, which lies between the fee at 0 gwei and the 5 gwei cap.
          const d = Number(last[1]);
          const shapes = BigInt(SHAPES_IN[d]);
          const mintFee = await read<bigint>(await read<Address>(bB, poolBalancerAbi, 'SHAPES'), shapesAbi, 'mintFee');
          const [base, price] = [last[3] as bigint, last[4] as bigint];
          assert.equal(base, prizeBase(d, mintFee, markup), 'restocked prize priced at the new markup');
          assert.equal((price - base) % shapes, 0n, 'one restocking fee per Shape');
          const fee = (price - base) / shapes;
          assert.ok(fee >= restockFeeAt(0n) && fee <= restockFeeAt(5n * 10n ** 9n), 'restocking fee within its basefee bounds');
        }
        stats.markupChanges++;
        continue;
      }

      const b = balancers[Math.floor(rand() * balancers.length)];
      stats.arrivals++;
      if ((await status(b)) !== 0) continue; // buyer turned away
      stats.foundOpen++;
      const count = 1 + Math.floor(rand() * 5);
      const words = Array.from({ length: count }, (_, i) => BigInt(keccak256(toHex(BigInt(round) * 10n + BigInt(i)))));
      await buyAndSettle(b, count, `0x${(0xb0b00000 + round).toString(16).padStart(40, '0')}` as Address, words);
      stats.batches++;
      stats.draws += count;
      stats.byPeriod[period]++;
      if (period === 'above') {
        // Above the cap: the keeper must wait while gas stays high, then resume on its own.
        const t = await waitOpen(b, 8_000, true);
        if (t < 0) stats.aboveCapWaited++;
        else stats.aboveCapSent++;
        await setBasefee(0.08);
        stats.reopenMs.push(await mustOpen(b, 'pool reopened after the spike ended'));
        stats.resumedAfterSpike++;
      } else {
        if ((await waitOpen(b, 60_000, true)) < 0 && (await status(b)) === 4) await keepStocked(); // last curated drawn
        stats.reopenMs.push(await mustOpen(b, `pool reopened at ${gwei} gwei`, 60_000, true));
      }

      // Creator edit on pool A: a curated price change needs no upkeep.
      if (round % 40 === 39) {
        const ids = await read<bigint[]>(bA, poolBalancerAbi, 'getActiveIds');
        for (const id of ids) {
          const it = await read<readonly unknown[]>(bA, poolBalancerAbi, 'items', [id]);
          if (Number(it[0]) !== 1) continue;
          await test.impersonateAccount({ address: CREATORS[0] });
          await send({ address: bA, abi: poolBalancerAbi, functionName: 'updateCuratedPrice', args: [id, (it[3] as bigint) + 10n ** 15n], account: CREATORS[0] });
          break;
        }
        stats.creatorEdits++;
        assert.ok(await stocked(bA), 'still open after a creator edit');
      }
    }

    await setBasefee(0.08);
    await sleep(3000); // let the last in-flight keeper tx resolve
    const health = await (await fetch(`http://127.0.0.1:${HEALTH}/health`)).json();
    const kb1 = await pub.getBalance({ address: KEEPER });
    const head = await pub.getBlockNumber();
    assert.equal(await pub.getCode({ address: KEEPER }), undefined, 'keeper still has no code or delegation');

    // Reconciliation: keeper balance change = rewards - gas paid + value received - value sent, to the wei.
    const paidEvent = parseAbiItem('event KeeperPaid(address indexed keeper, uint256 amount, uint256 gasUsed)');
    let rewards = 0n;
    let rewardEvents = 0;
    for (const b of balancers) {
      for (const l of await pub.getLogs({ address: b, event: paidEvent, args: { keeper: KEEPER }, fromBlock: startBlock, toBlock: head })) {
        rewards += l.args.amount!;
        rewardEvents++;
      }
    }
    let gasPaid = 0n;
    let valueIn = 0n;
    let valueOut = 0n;
    let keeperTxs = 0;
    for (let n = startBlock + 1n; n <= head; n++) {
      const blk = await pub.getBlock({ blockNumber: n, includeTransactions: true });
      for (const t of blk.transactions) {
        if (typeof t === 'string') continue;
        if (t.to?.toLowerCase() === KEEPER) valueIn += t.value;
        if (t.from.toLowerCase() !== KEEPER) continue;
        keeperTxs++;
        valueOut += t.value;
        const r = await pub.getTransactionReceipt({ hash: t.hash });
        gasPaid += r.gasUsed * r.effectiveGasPrice;
      }
    }
    // eth_estimateGas vs billed gas for every keeper send: the gap a keeper's cost estimate adds over real cost.
    const gaps: number[] = [];
    const traceGaps: number[] = [];
    for (const line of keeperLog) {
      try {
        const e = JSON.parse(line);
        if (e.msg === 'mined' && e.gasEstimate) gaps.push(Number(e.gasEstimate) - Number(e.gasUsed));
        if (e.msg === 'mined' && e.expenseSource === 'trace') traceGaps.push(Number(e.expenseGas) - Number(e.gasUsed));
      } catch {}
    }
    gaps.sort((a, b) => a - b);
    traceGaps.sort((a, b) => a - b);
    console.log(JSON.stringify({ estimateMinusBilled: { n: gaps.length, min: gaps[0], median: gaps[Math.floor(gaps.length / 2)], max: gaps.at(-1) }, traceExpenseMinusBilled: { n: traceGaps.length, min: traceGaps[0], median: traceGaps[Math.floor(traceGaps.length / 2)], max: traceGaps.at(-1) } }));
    const recon = { balanceDelta: (kb1 - kb0).toString(), rewards: rewards.toString(), rewardEvents, gasPaid: gasPaid.toString(), keeperTxs, valueIn: valueIn.toString(), valueOut: valueOut.toString() };
    console.log(JSON.stringify(recon));
    assert.equal(kb1 - kb0, rewards - gasPaid + valueIn - valueOut, 'keeper balance reconciles to the wei');

    const sorted = [...stats.reopenMs].sort((a, b) => a - b);
    const summary = {
      rounds: ROUNDS, arrivals: stats.arrivals, foundOpenPct: +(100 * stats.foundOpen / Math.max(1, stats.arrivals)).toFixed(1),
      batches: stats.batches, draws: stats.draws, batchesByPeriod: stats.byPeriod,
      reopenMs: { median: sorted[Math.floor(sorted.length / 2)], p90: sorted[Math.floor(sorted.length * 0.9)], max: sorted.at(-1) },
      aboveCap: { keeperWaited: stats.aboveCapWaited, keeperSent: stats.aboveCapSent, resumedWithoutIntervention: stats.resumedAfterSpike },
      markupChanges: stats.markupChanges,
      creatorEdits: stats.creatorEdits, creatorRestocks: stats.creatorRestocks, keeperRestarts: stats.restarts,
      keeper: { netWei: (kb1 - kb0).toString(), sent: health.stats.sent, mined: health.stats.mined, reverted: health.stats.reverted, replaced: health.stats.replaced, skippedUnprofitable: health.stats.skippedUnprofitable, errors: health.errors },
      healthOk: health.ok,
    };
    console.log(JSON.stringify(summary, null, 2));
    assert.equal(health.ok, true, 'keeper health');
    assert.deepEqual(health.errors, {}, 'no pool errors');
    if (health.stats.reverted) console.error(keeperLog.filter((l) => l.includes('"reverted"') || l.includes('revert')).join('\n'));
    assert.equal(health.stats.reverted, 0, 'no reverted keeper transactions since the last restart');
    assert.equal(stats.aboveCapSent, 0, 'keeper never serviced above the cap');
    if (ROUNDS >= 50) assert.ok(stats.byPeriod.above > 0 && stats.byPeriod.near > 0 && stats.byPeriod.below > 0, 'all gas periods exercised');
    if (ROUNDS >= 25) assert.ok(stats.markupChanges > 0, 'markup changes exercised');
    assert.ok(kb1 > kb0, 'keeper earned more than it spent');
    console.log('REHEARSAL PASSED');
  } finally {
    keeper?.kill();
    anvil.kill();
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/** The same real Keeper and FWA driver, operating through the current candidate's bounded transaction journal. */
export async function runPreparedRehearsal(run: CurrentRehearsal) {
    const r = run.roles, p = run.plan, zero = `0x${'00'.repeat(32)}` as Hex;
    const more = parseAbi(['function selectionTimeoutBlocks() view returns(uint256)', 'function acquisitionEscrowTotal() view returns(uint256)', 'function deliveryEscrowTotal() view returns(uint256)', 'function acquisitionRefundCreditTotal() view returns(uint256)', 'function accruedProtocolFees() view returns(uint256)', 'function acquisitionRefundCredit(address) view returns(uint256)', 'function withdrawAcquisitionRefund() returns(uint256)']);
    const service = parseAbi(['function coordinator() view returns(address)', 'function requestStatus(uint256) view returns(uint8)', 'function rawFulfillRandomWords(uint256,uint256[])', 'function deliverRandomness(uint256) returns(bool)']);
    const E = 10n ** 18n, fee = await run.read<bigint>('0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0', shapesAbi, 'mintFee');
    assert.equal(String(fee), p.parameters.mintFeeWei, 'frozen current Shapes mint fee');
    const read = <T,>(b: Address, fn: string, a: unknown[] = []) => run.read<T>(b, poolBalancerAbi, fn, a);
    const poolRead = <T,>(b: Address, fn: string, a: unknown[] = []) => run.read<T>(b, fwaPoolAbi, fn, a);
    const note = (name: string, value: unknown) => run.report({ name, block: run.journal.checkedBlock, value });
    const sent = (b: any, fn: string, a: unknown[] = []) => run.send(b.creator, b.balancer, poolBalancerAbi, fn, a);
    let staged = false;
    async function reconciled(b: any) { return await read<bigint>(b.balancer, 'reconciledSequence') === await poolRead<bigint>(b.pool, 'lastIssuedSequence') && await poolRead<bigint>(b.pool, 'unsettledAcquisitionCount') === 0n; }
    async function drain(requireInventory = true) { for (let n = 0; n < 24; n++) {
        await run.tick();
        let done = !Object.keys(run.keeper.state.pending).length && !Object.keys(run.keeper.state.accounting).length;
        for (const b of run.journal.pools) {
            if (await read<boolean>(b.balancer, 'paidUpkeepEnabled') && (!await reconciled(b) || requireInventory && !await preparedStocked(b)))
                done = false;
        }
        if (done)
            return;
    } throw Error('bounded production Keeper ticks did not complete'); }
    async function preparedStocked(b: any) { const have = await read<readonly number[]>(b.balancer, 'getActiveShapes'); return have.every((v, d) => BigInt(v) === (BigInt(b.target) >> BigInt(16 * d) & 0xffffn)) && await read<number>(b.balancer, 'admissionStatus') === 0; }
    async function cash(b: any, label: string) { const block = await run.pub.getBlock(); const [balance, credit, reserve, proceeds] = await Promise.all([run.pub.getBalance({ address: b.balancer, blockNumber: block.number }), run.read<bigint>(b.balancer, poolBalancerAbi, 'creatorCredit', [], { blockNumber: block.number }), run.read<bigint>(b.balancer, poolBalancerAbi, 'requiredReserve', [], { blockNumber: block.number }), run.read<bigint>(b.pool, fwaPoolAbi, 'ownerProceeds', [], { blockNumber: block.number })]); assert.ok(balance >= credit); const bucket = await Promise.all(['acquisitionEscrowTotal', 'deliveryEscrowTotal', 'acquisitionRefundCreditTotal', 'accruedProtocolFees'].map(fn => run.read<bigint>(b.pool, more, fn, [], { blockNumber: block.number }))); assert.equal(await run.pub.getBalance({ address: b.pool, blockNumber: block.number }), bucket.reduce((a, v) => a + v, proceeds), 'every actual FWA wei has a named obligation'); note(label, { balancer: b.balancer, balance, creatorCredit: credit, operating: balance - credit, reserve, fwaOwnerProceeds: proceeds, purchaserEscrow: bucket[0] + bucket[1], purchaserRefunds: bucket[2], protocolFees: bucket[3] }); return { balance, credit, operating: balance - credit, reserve }; }
    for (const [i, creator] of [r.creatorA, r.creatorB].entries()) {
        const demo = await run.create(creator, 'DemoNFT');
        const balancer = await run.read<Address>(run.factory, balancerFactoryAbi, 'predictBalancer', [creator, zero]);
        const b = { creator, demo, balancer, pool: '' as Address, target: p.scenario.targets[i] };
        run.journal.pools.push(b);
        run.save();
        const curated = [];
        for (let id = 1n; id <= 2n; id++) {
            await run.send(creator, demo, demoAbi, 'mint', [creator, id]);
            await run.send(creator, demo, erc721Abi, 'approve', [balancer, id]);
            curated.push({ collection: demo, tokenId: id, base: BigInt(p.scenario.curatedValues[Number(id) - 1]) });
        }
        if (i === 0)
            await run.creationReceiptProbe(creator, curated, fee);
        const receipt = await run.send(creator, run.factory, balancerFactoryAbi, 'createBalancer', [zero, { markupBps: p.scenario.markupBps, creatorRevenueBps: p.scenario.creatorRevenueBps, target: BigInt(b.target), mintFeeCap: fee }, curated], BigInt(p.scenario.initialDeposits[i]), 'atomic-creation');
        b.pool = await read<Address>(balancer, 'pool');
        run.save();
        eqPrepared(await read<Address>(balancer, 'creator'), creator);
        eqPrepared(await poolRead<Address>(b.pool, 'owner'), balancer);
        assert.equal(await read<bigint>(balancer, 'target'), BigInt(b.target));
        assert.equal(await read<number>(balancer, 'creatorRevenueBps'), 400);
        assert.equal(await read<bigint>(balancer, 'listedShapePrizes'), 0n, 'creation minted no inventory');
        assert.equal(await read<number>(balancer, 'admissionStatus'), 2, 'purchases remain closed during initial stocking');
        for (let id = 1n; id <= 2n; id++)
            eqPrepared(await run.read<Address>(demo, erc721Abi, 'ownerOf', [id]), b.pool);
        note('atomic-approved-creation', { balancer, transaction: receipt.transactionHash, target: b.target, funding: p.scenario.initialDeposits[i], listedCurated: 2, listedShapes: 0 });
    }
    const [a, b] = run.journal.pools;
    await drain();
    for (const x of run.journal.pools) {
        assert.ok(await preparedStocked(x));
        await cash(x, 'initial-stocked-cash');
    }
    const coordinator = await run.read<Address>(VRF_SERVICE, service, 'coordinator');
    await run.coordinator(coordinator);
    async function request(x: any, count: number, category = 'buyer') {
        assert.ok(run.journal.draws.length + count <= Number(p.caps.draws));
        const block = await run.pub.getBlock();
        const bid = (block.baseFeePerGas ?? 0n) * 2n + 50_000_000n;
        const [feeQuote, vrf, total] = await run.read<readonly [bigint, bigint, bigint]>(x.pool, fwaPoolAbi, 'quoteAcquisitionPrice', [BigInt(count)], { account: r.buyer, gasPrice: bid });
        assert.equal(total, BigInt(count) * (feeQuote + vrf));
        // Before inclusion the entire acquisition fee is the conservative upper bound on its edge component.
        assert.ok(BigInt(run.journal.spent.edge) + BigInt(count) * feeQuote <= BigInt(p.caps.edge), 'per-action edge reservation');
        assert.ok(BigInt(run.journal.spent.vrf) + BigInt(count) * vrf <= BigInt(p.caps.vrf), 'per-action VRF reservation');
        const seq = await poolRead<bigint>(x.pool, 'lastIssuedSequence');
        const version = await poolRead<bigint>(x.pool, 'inventoryVersion');
        const before = await run.pub.getBalance({ address: r.buyer });
        const receipt = await run.send(r.buyer, x.pool, fwaPoolAbi, 'acquireBatch', [r.buyer, BigInt(count), feeQuote, 0n, 10000n, version, block.timestamp + 600n], total, category, 3_000_000n);
        const after = await run.pub.getBalance({ address: r.buyer });
        const debit = before - after - receipt.gasUsed * receipt.effectiveGasPrice;
        const requestedEvent = parseAbiItem('event AcquisitionRequested(uint256 indexed requestId,address indexed purchaser,uint256 acquisitionFee,uint256 totalWeight)');
        const vrfEvent = parseAbiItem('event VrfServiceFeePaid(address indexed payer,uint256 amount)');
        const requests = receipt.logs.filter(log => log.address.toLowerCase() === x.pool.toLowerCase() && log.topics[0] === keccak256(toHex('AcquisitionRequested(uint256,address,uint256,uint256)')))
            .map(log => decodeEventLog({ abi: [requestedEvent], topics: log.topics, data: log.data }).args);
        const vrfPayments = receipt.logs.filter(log => log.address.toLowerCase() === x.pool.toLowerCase() && log.topics[0] === keccak256(toHex('VrfServiceFeePaid(address,uint256)')))
            .map(log => decodeEventLog({ abi: [vrfEvent], topics: log.topics, data: log.data }).args);
        assert.equal(requests.length, count); assert.equal(vrfPayments.length, 1); eqPrepared(vrfPayments[0].payer, r.buyer);
        // acquireBatch applies idle staged activation before fixing each request's owner base. No callback ran in this block.
        const [actualWeight, actualWeightedValue] = await Promise.all(['totalWeight', 'weightedBackingTotal'].map(fn => run.read<bigint>(x.pool, fwaPoolAbi, fn, [], { blockNumber: receipt.blockNumber })));
        assert.ok(actualWeight > 0n);
        const requestBase = actualWeightedValue / actualWeight;
        let actualFees = 0n, actualEdge = 0n;
        for (const requested of requests) {
            eqPrepared(requested.purchaser, r.buyer); assert.equal(requested.totalWeight, actualWeight);
            assert.equal(requested.acquisitionFee, feeQuote); assert.ok(requested.acquisitionFee >= requestBase);
            actualFees += requested.acquisitionFee; actualEdge += requested.acquisitionFee - requestBase;
        }
        const actualVrf = vrfPayments[0].amount;
        assert.equal(debit, actualFees + actualVrf, 'actual buyer debit separates request escrow and VRF payment');
        assert.ok(debit <= total); assert.ok(actualVrf <= BigInt(count) * vrf);
        assert.ok(BigInt(run.journal.spent.edge) + actualEdge <= BigInt(p.caps.edge), 'actual nonnegative edge cap');
        assert.ok(BigInt(run.journal.spent.vrf) + actualVrf <= BigInt(p.caps.vrf), 'actual VRF cap');
        run.journal.spent.edge = String(BigInt(run.journal.spent.edge) + actualEdge);
        run.journal.spent.vrf = String(BigInt(run.journal.spent.vrf) + actualVrf);
        const draws = [];
        for (let j = 1; j <= count; j++) {
            const id = await poolRead<bigint>(x.pool, 'requestIdAtSequence', [seq + BigInt(j)]);
            assert.equal(requests[j - 1].requestId, id);
            const draw = { pool: x.pool, id: String(id), feeWei: String(requests[j - 1].acquisitionFee), ownerBase: String(requestBase), category };
            run.journal.draws.push(draw); draws.push(draw);
        }
        run.save();
        return draws;
    }
    async function selectedWord(x: any, d = 0) { const ids = await read<bigint[]>(x.balancer, 'getActiveIds'); let chosen = 0n; const listings = []; for (const id of ids) {
        const it = await read<any[]>(x.balancer, 'items', [id]);
        const l = await poolRead<any[]>(x.pool, 'listings', [id]);
        if (Number(l[7]) !== 1)
            continue;
        listings.push(l);
        if (Number(it[0]) === 2 && Number(it[1]) === d && !chosen)
            chosen = l[6];
    } assert.ok(chosen > 0n, 'planned real Shape prize remains available'); return listings.filter(l => l[6] < chosen).reduce((n, l) => n + l[4], 0n); }
    async function deliver(x: any, draw: any, d = 0, maintain = true) { await run.mine(3); const word = await selectedWord(x, d); draw.word = String(word); run.save(); const status = Number(await run.read<number>(VRF_SERVICE, service, 'requestStatus', [BigInt(draw.id)])); assert.equal(status, 1, 'real service request awaits its authenticated coordinator'); await run.send(coordinator, VRF_SERVICE, service, 'rawFulfillRandomWords', [BigInt(draw.id), [word]], 0n, 'controlled-coordinator', 5000000n); const delivered = Number(await run.read<number>(VRF_SERVICE, service, 'requestStatus', [BigInt(draw.id)])); if (delivered === 2)
        await run.send(r.buyer, VRF_SERVICE, service, 'deliverRandomness', [BigInt(draw.id)], 0n, 'authenticated-service-retry', 5000000n); assert.equal(Number(await run.read<number>(VRF_SERVICE, service, 'requestStatus', [BigInt(draw.id)])), 4); if (maintain) {
        for (let n = 0; n < 4; n++)
            await run.tick();
        const tracked = (await read<bigint[]>(x.balancer, 'getActiveIds')).length;
        if (await poolRead<bigint>(x.pool, 'unsettledAcquisitionCount') > 0n && await poolRead<bigint>(x.pool, 'activeListingCount') < BigInt(tracked))
            staged = true;
    } }
    async function verifyOutcomes() { for (const draw of run.journal.draws) {
        const acq = await poolRead<any[]>(draw.pool, 'acquisitions', [BigInt(draw.id)]);
        const state = Number(acq[4]);
        if (state === 2) {
            const l = await poolRead<any[]>(draw.pool, 'listings', [acq[3]]);
            eqPrepared(await run.read<Address>(l[0], erc721Abi, 'ownerOf', [l[3]]), r.buyer);
        }
        else
            assert.ok(state === 3 || state === 4, 'only actual delivery, expiry or slippage refund is final');
        draw.outcome = state;
    } run.save(); }
    // Fifty existing 1..5-draw rounds with controlled choices preserve the one-ETH prize for the explicit deficit case.
    for (let round = 0; round < Number(p.caps.rounds); round++) {
        const period = basefeeFor(round);
        await run.basefee(BigInt(Math.round(period.gwei * 1e9)));
        const x = run.journal.pools[round % 2];
        const draws = await request(x, 1 + round % 5);
        if (round === 0) {
            const second = await request(x, 1);
            draws.push(...second);
            assert.equal(await poolRead<bigint>(x.pool, 'unsettledAcquisitionCount'), 2n);
            note('concurrent-separate-purchases', { issued: await poolRead<bigint>(x.pool, 'lastIssuedSequence'), unsettled: 2 });
        }
        const sentBefore = run.keeper.state.stats.sent;
        for (const draw of draws)
            await deliver(x, draw, 0, period.period !== 'above');
        if (period.period === 'above') {
            await run.tick();
            assert.equal(run.keeper.state.stats.sent, sentBefore, 'real Keeper waits above selected-policy reimbursement');
            await run.basefee(80000000n);
        }
        await drain();
        await verifyOutcomes();
        if (round === 16 || round === 33) {
            run.keeper.save();
            run.newKeeper();
        }
        if ([0, 19, 23, 31, 38, 49].includes(round))
            await cash(x, `round-${round + 1}-${period.period}`);
    }
    assert.ok(staged, 'real maintenance staged replenishment while another draw remained pending');
    await run.basefee(500000000n);
    const surplus = await read<bigint>(a.balancer, 'withdrawableSurplus');
    await sent(a, 'claimSurplus', [surplus, a.creator]);
    const target = await read<bigint>(a.balancer, 'target'), deposits = run.journal.spent.deposits;
    const large = (await request(a, 1, 'one-ETH-deficit'))[0];
    await deliver(a, large, 4, false);
    const largeAcquisition = await poolRead<any[]>(a.pool, 'acquisitions', [BigInt(large.id)]);
    assert.equal(Number(largeAcquisition[4]), 2, 'one-ETH prize actually delivered');
    const largeListing = await poolRead<any[]>(a.pool, 'listings', [largeAcquisition[3]]);
    eqPrepared(await run.read<Address>(largeListing[0], erc721Abi, 'ownerOf', [largeListing[3]]), r.buyer);
    assert.equal(await run.read<bigint>(largeListing[0], parseAbi(['function backingOf(uint256) view returns(uint256)']), 'backingOf', [largeListing[3]]), E, 'actual winner keeps the one-ETH-backed Shape');
    note('actual-one-ETH-winner', { collection: largeListing[0], tokenId: largeListing[3], owner: r.buyer, backingWei: E });
    const amount = await poolRead<bigint>(a.pool, 'ownerProceeds'), creditBefore = await read<bigint>(a.balancer, 'creatorCredit');
    assert.ok(amount > 0n);
    await sent(a, 'collectProceeds');
    assert.equal(await read<bigint>(a.balancer, 'creatorCredit'), creditBefore + amount * 400n / 10000n);
    await drain(false);
    const deficit = await cash(a, 'one-ETH-unfunded-after-real-win');
    assert.equal((await read<readonly number[]>(a.balancer, 'getActiveShapes'))[4], 0);
    assert.ok(deficit.operating < E);
    assert.ok(await read<bigint>(a.balancer, 'requiredReserve') > E);
    assert.equal(await read<bigint>(a.balancer, 'target'), target);
    assert.equal(run.journal.spent.deposits, deposits);
    await sent(a, 'claimSurplus', [deficit.credit, a.creator]);
    assert.equal(await run.pub.getBalance({ address: a.balancer }), deficit.operating, 'credited earnings claim leaves operating cash unchanged');
    const v2 = await run.create(r.deployer, 'KeeperPolicyV2');
    const oldHash = await read<Hex>(a.balancer, 'settingsHash'), allowance = await read<bigint>(a.balancer, 'keeperAllowance');
    const [maintenance, shortfall] = await run.read<readonly [
        bigint,
        bigint
    ]>(a.balancer, poolBalancerAbi, 'policyFunding', [v2]);
    assert.equal(shortfall, 0n);
    assert.ok(maintenance < E);
    await sent(a, 'proposeKeeperPolicy', [v2]);
    await run.jump();
    await run.send(r.keeper, a.balancer, poolBalancerAbi, 'activateKeeperPolicy');
    eqPrepared(await read<Address>(a.balancer, 'keeperPolicy'), v2);
    assert.equal(await read<bigint>(a.balancer, 'keeperAllowance'), allowance);
    assert.notEqual(await read<Hex>(a.balancer, 'settingsHash'), oldHash);
    assert.equal((await read<readonly number[]>(a.balancer, 'getActiveShapes'))[4], 0);
    note('replacement-policy-without-settings-while-underfunded', { v2, maintenance, shortfall, inventoryReserve: await read<bigint>(a.balancer, 'requiredReserve') });
    const paidBefore = run.keeper.state.stats.mined;
    const underfundedSale = (await request(a, 1, 'V2-underfunded-sale'))[0];
    await deliver(a, underfundedSale, 0);
    await drain(false);
    assert.ok(run.keeper.state.stats.mined > paidBefore, 'production Keeper executed the different formula without settings');
    await sent(b, 'setCreatorRevenueBps', [10000]);
    await sent(b, 'setPaidUpkeepEnabled', [false]);
    const free = await read<bigint>(b.balancer, 'withdrawableSurplus');
    await sent(b, 'claimSurplus', [free, b.creator]);
    assert.equal(await run.pub.getBalance({ address: b.balancer }), 0n);
    const unpaid = (await request(b, 1, 'credit-only-unpaid'))[0];
    await deliver(b, unpaid, 0, false);
    const pack = (await request(b, 1, 'real-pack-delivery'))[0];
    await deliver(b, pack, 9, false);
    const packAcq = await poolRead<any[]>(b.pool, 'acquisitions', [BigInt(pack.id)]);
    assert.equal(Number(packAcq[4]), 2);
    const packListing = await poolRead<any[]>(b.pool, 'listings', [packAcq[3]]);
    assert.equal(await run.read<bigint>(packListing[0], parseAbi(['function valueOf(uint256) view returns(uint256)']), 'valueOf', [packListing[3]]), 2n * E / 100n, 'the actual delivered Pack retains 0.02 ETH backing');
    const owner = await poolRead<bigint>(b.pool, 'ownerProceeds');
    assert.ok(owner > 0n);
    await sent(b, 'collectProceeds');
    const credit = await read<bigint>(b.balancer, 'creatorCredit');
    assert.equal(credit, owner);
    await sent(b, 'performUpkeepUnpaid');
    assert.equal(await run.pub.getBalance({ address: b.balancer }), credit);
    assert.equal(await read<bigint>(b.balancer, 'creatorCredit'), credit);
    await sent(b, 'claimSurplus', [credit, b.creator]);
    assert.equal(await run.pub.getBalance({ address: b.balancer }), 0n);
    note('zero-operating-unpaid-credit-protection', { actualOwnerProceeds: owner, claimedCredit: credit, operating: 0 });
    const expiry = (await request(b, 1, 'real-expiry-refund'))[0];
    // Close with an actual purchase pending, then allocate late owner proceeds under the stored rate.
    const late = (await request(a, 1, 'late-after-close'))[0];
    await sent(a, 'close');
    await deliver(a, late, 0, false);
    const lateOwner = await poolRead<bigint>(a.pool, 'ownerProceeds');
    const lateCredit = await read<bigint>(a.balancer, 'creatorCredit');
    assert.ok(lateOwner > 0n, 'real proceeds settled after closing');
    await sent(a, 'collectProceeds');
    assert.equal(await read<bigint>(a.balancer, 'creatorCredit'), lateCredit + lateOwner * 400n / 10000n);
    await sent(a, 'performUpkeepUnpaid');
    note('closed-late-settlement', { actualOwnerProceeds: lateOwner, creditAdded: lateOwner * 400n / 10000n });
    const timeout = await run.read<bigint>(b.pool, more, 'selectionTimeoutBlocks');
    await run.mine(Number(timeout) + 1);
    run.beginCloseout();
    for (const x of run.journal.pools) {
        if (await read<boolean>(x.balancer, 'enabled'))
            await sent(x, 'close');
        for (let n = 0; n < 8 && !await reconciled(x); n++)
            await sent(x, 'performUpkeepUnpaid');
        assert.ok(await reconciled(x));
        if (x === b) {
            assert.equal(Number((await poolRead<any[]>(b.pool, 'acquisitions', [BigInt(expiry.id)]))[4]), 3, 'actual purchase expired without a fabricated word');
            assert.ok(await run.read<bigint>(b.pool, more, 'acquisitionRefundCredit', [r.buyer]) >= BigInt(expiry.feeWei));
        }
        const ids = await read<bigint[]>(x.balancer, 'getActiveIds'), prizes: bigint[] = [];
        for (const id of ids) {
            const it = await read<any[]>(x.balancer, 'items', [id]);
            if (Number(it[0]) === 1) {
                const listed = await poolRead<any[]>(x.pool, 'listings', [id]);
                await sent(x, 'withdrawCurated', [id, x.creator]);
                eqPrepared(await run.read<Address>(listed[0], erc721Abi, 'ownerOf', [listed[3]]), x.creator);
                note('unsold-curated-return', { collection: listed[0], tokenId: listed[3], owner: x.creator });
            } else
                prizes.push(id);
        }
        for (let i = 0; i < prizes.length; i += 20)
            await sent(x, 'unlistShapes', [prizes.slice(i, i + 20)]);
        const all = await read<bigint>(x.balancer, 'withdrawableSurplus');
        if (all)
            await sent(x, 'claimSurplus', [all, x.creator]);
        const refund = await run.read<bigint>(x.pool, more, 'acquisitionRefundCredit', [r.buyer]);
        if (refund)
            await run.send(r.buyer, x.pool, more, 'withdrawAcquisitionRefund', [], 0n, 'purchaser-refund');
        await sent(x, 'retire');
        assert.equal(await run.pub.getBalance({ address: x.balancer }), 0n);
        assert.equal(await read<bigint>(x.balancer, 'creatorCredit'), 0n);
        assert.equal(await poolRead<bigint>(x.pool, 'ownerProceeds'), 0n);
        assert.equal((await read<bigint[]>(x.balancer, 'getActiveIds')).length, 0);
        assert.equal(await run.read<bigint>(x.pool, more, 'acquisitionRefundCreditTotal'), 0n);
        await cash(x, 'complete-closeout');
    }
    await verifyOutcomes();
    eqPrepared(await run.read<Address>(largeListing[0], erc721Abi, 'ownerOf', [largeListing[3]]), r.buyer);
    assert.equal(await run.read<bigint>(largeListing[0], parseAbi(['function backingOf(uint256) view returns(uint256)']), 'backingOf', [largeListing[3]]), E);
    for (const x of run.journal.pools) {
        const logs = await run.pub.getLogs({ address: x.balancer, fromBlock: BigInt(p.forkBlock), toBlock: 'latest' });
        let collected = 0n, mintCost = 0n, redeemed = 0n, claims = 0n, payments = 0n, credit = 0n, credited = 0n, rate = 0n;
        for (const log of logs) {
            const t = log.topics[0];
            if (t === keccak256(toHex('CreatorRevenueChanged(uint16,uint16)'))) {
                const value = decodeEventLog({ abi: poolBalancerAbi, data: log.data, topics: log.topics, eventName: 'CreatorRevenueChanged' });
                rate = BigInt(value.args.newBps);
            }
            else if (t === keccak256(toHex('ProceedsCollected(uint256)'))) {
                const value = decodeEventLog({ abi: poolBalancerAbi, data: log.data, topics: log.topics, eventName: 'ProceedsCollected' });
                collected += value.args.amount;
                const added = value.args.amount * rate / 10000n;
                credit += added;
                credited += added;
            }
            else if (t === keccak256(toHex('SurplusClaimed(address,uint256)'))) {
                const value = decodeEventLog({ abi: poolBalancerAbi, data: log.data, topics: log.topics, eventName: 'SurplusClaimed' });
                claims += value.args.amount;
                credit = credit > value.args.amount ? credit - value.args.amount : 0n;
            }
            else if (t === keccak256(toHex('ShapesMinted(uint8,uint256,uint256,uint256)'))) {
                const value = decodeEventLog({ abi: poolBalancerAbi, data: log.data, topics: log.topics, eventName: 'ShapesMinted' });
                mintCost += value.args.cost;
            }
            else if (t === keccak256(toHex('ShapesUnlisted(uint256,uint256)'))) {
                const value = decodeEventLog({ abi: poolBalancerAbi, data: log.data, topics: log.topics, eventName: 'ShapesUnlisted' });
                redeemed += value.args.ethRedeemed;
            }
            else if (t === keccak256(toHex('KeeperPaid(address,uint256,uint256)'))) {
                const value = decodeEventLog({ abi: poolBalancerAbi, data: log.data, topics: log.topics, eventName: 'KeeperPaid' });
                payments += value.args.amount;
            }
        }
        const index = x === a ? 0 : 1, deposit = BigInt(p.scenario.initialDeposits[index]);
        assert.equal(deposit + collected + redeemed, claims + mintCost + payments, 'actual Balancer cash closes to the wei');
        assert.equal(credit, 0n);
        assert.equal(await read<bigint>(x.balancer, 'creatorCredit'), credit);
        note('full-cash-and-credit-cycle', { balancer: x.balancer, initialCapital: deposit, actualOwnerProceeds: collected, creatorCreditAccrued: credited, creatorWithdrawals: claims, actualMintAndBackingCost: mintCost, redeemedBacking: redeemed, actualKeeperPayments: payments, remainingCash: 0, remainingCredit: credit });
    }
    let rewards = 0n;
    for (const x of run.journal.pools) {
        const logs = await run.pub.getLogs({ address: x.balancer, event: parseAbiItem('event KeeperPaid(address indexed keeper,uint256 amount,uint256 gasUsed)'), args: { keeper: r.keeper }, fromBlock: BigInt(p.forkBlock), toBlock: 'latest' });
        for (const log of logs)
            rewards += log.args.amount!;
    }
    const gas = run.journal.receipts.filter((v: any) => v.actor.toLowerCase() === r.keeper.toLowerCase()).reduce((n: bigint, v: any) => n + BigInt(v.gasWei), 0n);
    assert.equal(await run.pub.getBalance({ address: r.keeper }), BigInt(p.funding.keeper) + rewards - gas);
    note('final-actual-accounting', { draws: run.journal.draws.length, keeperRewards: rewards, keeperAllGas: gas, totalGas: run.gas(), deposits: run.journal.spent.deposits, syntheticNftMarketValue: 'unmeasured; no creator net-profit claim', limitations: ['controlled Keeper ticks, not CLI timing', 'controlled real-coordinator callbacks, not live randomness', 'unlocked synthetic actors, not extension-wallet signatures'] });
}
function eqPrepared(a: string, b: string) { assert.equal(a.toLowerCase(), b.toLowerCase()); }
