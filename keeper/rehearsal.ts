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
import {
  createPublicClient, createTestClient, createWalletClient, http, keccak256, parseAbi, parseAbiItem, toHex, type Address,
} from 'viem';
import { erc721Abi, fwaPoolAbi, poolBalancerAbi } from '../shared/abi';

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

/** Word that makes FWA select `lid`: cumulative weight of active listings in lower slots (FWA's segment tree order). */
async function wordFor(b: Address, pool: Address, lid: bigint) {
  const ids = await read<bigint[]>(b, poolBalancerAbi, 'getActiveIds');
  const target = await read<readonly unknown[]>(pool, fwaPoolAbi, 'listings', [lid]);
  let acc = 0n;
  for (const id of ids) {
    const l = await read<readonly unknown[]>(pool, fwaPoolAbi, 'listings', [id]);
    if (Number(l[7]) === 1 && (l[6] as bigint) < (target[6] as bigint)) acc += l[4] as bigint;
  }
  return acc;
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
  if (await read<bigint>(pool, fwaPoolAbi, 'unsettledAcquisitionCount')) {
    await send({ address: pool, abi: fwaPoolAbi, functionName: 'processAcquisitions', args: [5n], account: DEPLOYER });
  }
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
    sh(`forge script script/Deploy.s.sol --rpc-url ${RPC} --unlocked --sender ${DEPLOYER} --broadcast`);
    const factory = JSON.parse(readFileSync('deployments/31337.json', 'utf8')).balancerFactory as Address;
    const balancers: Address[] = [];
    const demo: Address[] = [];
    for (const c of CREATORS) {
      const out = sh(`forge script script/DevSetup.s.sol --tc DevSetup --rpc-url ${RPC} --unlocked --sender ${c} --broadcast`, { FACTORY: factory });
      balancers.push(out.match(/Balancer (0x[0-9a-fA-F]{40})/)![1] as Address);
      demo.push(out.match(/DemoNFT (0x[0-9a-fA-F]{40})/)![1] as Address);
    }
    // Pool B gets a fallback plan: losing a curated NFT breaks plan A's 0.80% odds floor (switch to plan B); restoring
    // curated value pushes plan B over the 0.028 ETH ceiling (switch back to plan A).
    const [bA, bB] = balancers;
    await test.impersonateAccount({ address: CREATORS[1] });
    const planA = 5n | (3n << 16n) | (2n << 32n);
    const planB = 2n | (1n << 16n) | (1n << 32n);
    await send({ address: bB, abi: poolBalancerAbi, functionName: 'configure', args: [{ maxDrawPrice: 28n * 10n ** 15n, minCuratedOddsBps: 80, markupBps: 1500 }, [planA, planB]], account: CREATORS[1] });

    // Keeper account: fresh, funded once by the harness; this funding precedes the reconciliation window.
    await test.impersonateAccount({ address: KEEPER });
    await test.setBalance({ address: KEEPER, value: 10n ** 18n });
    await setBasefee(0.08);
    const kb0 = await pub.getBalance({ address: KEEPER });
    const startBlock = await pub.getBlockNumber();

    const dir = mkdtempSync(join(tmpdir(), 'rehearsal-'));
    const startKeeper = () => {
      const k = spawn('npx', ['tsx', 'keeper/keeper.ts'], {
        env: { ...process.env, RPC_URL: RPC, FACTORY: factory, FROM_BLOCK: FORK_BLOCK.toString(), KEEPER_ADDRESS: KEEPER, STATE_FILE: join(dir, 'state.json'), POLL_MS: '800', HEALTH_PORT: String(HEALTH) },
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
        if ((await status(b)) === 0) return Date.now() - t0;
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
      purchaseCausedSwitches: 0, creatorCausedSwitches: 0, creatorEdits: 0, creatorRanUpkeep: 0, creatorRestocks: 0, restarts: 0,
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
      await send({ address: balancers[i], abi: poolBalancerAbi, functionName: 'listCurated', args: [demo[i], id, 25n * 10n ** 16n], account: CREATORS[i] });
      stats.creatorRestocks++;
    };
    const keepStocked = async () => {
      for (let i = 0; i < balancers.length; i++) {
        const st = await status(balancers[i]);
        if ((st === 0 || st === 4) && (await curatedCount(balancers[i])) < 2) {
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

      // Purchase-caused fallback switch on pool B (normal gas), then the creator restores curated value.
      if ((round % 50 === 12 || round % 50 === 44) && (await status(bB)) === 0) {
        const pool = await read<Address>(bB, poolBalancerAbi, 'pool');
        const ids = await read<bigint[]>(bB, poolBalancerAbi, 'getActiveIds');
        let curated: bigint | undefined;
        for (const id of ids) if (Number((await read<readonly unknown[]>(bB, poolBalancerAbi, 'items', [id]))[0]) === 1) { curated = id; break; }
        assert.ok(curated, 'pool B has a curated listing');
        await buyAndSettle(bB, 1, `0x${(0xc0de0000 + round).toString(16).padStart(40, '0')}` as Address, [await wordFor(bB, pool, curated!)]);
        await mustOpen(bB, 'pool B reopened on its fallback plan after a curated draw');
        assert.equal(Number(await read<number>(bB, poolBalancerAbi, 'activePlan')), 1, 'purchase-caused switch to plan B');
        stats.purchaseCausedSwitches++;
        // Creator lists a replacement curated NFT: restores odds and pushes plan B over the ceiling.
        const id = nextDemoId++;
        await test.impersonateAccount({ address: CREATORS[1] });
        await send({ address: demo[1], abi: demoAbi, functionName: 'mint', args: [CREATORS[1], id], account: CREATORS[1] });
        await send({ address: demo[1], abi: erc721Abi, functionName: 'approve', args: [bB, id], account: CREATORS[1] });
        await send({ address: bB, abi: poolBalancerAbi, functionName: 'listCurated', args: [demo[1], id, 25n * 10n ** 16n], account: CREATORS[1] });
        await mustOpen(bB, 'pool B reopened on plan A after the creator relisted');
        assert.equal(Number(await read<number>(bB, poolBalancerAbi, 'activePlan')), 0, 'creator-caused switch back to plan A');
        stats.creatorCausedSwitches++;
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

      // Creator edit on pool A: unpaid re-checkpoint, covered by the keeper's loss allowance.
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
        // The unpaid re-checkpoint is within the keeper's loss allowance only at normal gas; above it the keeper
        // waits and the creator runs upkeep (the documented fallback).
        if (period === 'normal') await mustOpen(bA, 'reopened after a creator edit without the creator running upkeep');
        else if ((await waitOpen(bA, 8_000, true)) < 0) {
          await send({ address: bA, abi: poolBalancerAbi, functionName: 'performUpkeep', account: CREATORS[0] });
          stats.creatorRanUpkeep++;
          await mustOpen(bA, 'reopened after the creator ran upkeep', 60_000, true);
        }
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
    const sent = new Map<string, number>();
    const gaps: number[] = [];
    for (const line of keeperLog) {
      try {
        const e = JSON.parse(line);
        if (String(e.msg).startsWith('sent ') && e.gasEstimate) sent.set(e.hash, Number(e.gasEstimate));
        if (e.msg === 'mined' && sent.has(e.hash)) gaps.push(sent.get(e.hash)! - Number(e.gasUsed));
      } catch {}
    }
    gaps.sort((a, b) => a - b);
    console.log(JSON.stringify({ estimateMinusBilled: { n: gaps.length, min: gaps[0], median: gaps[Math.floor(gaps.length / 2)], max: gaps.at(-1) } }));
    const recon = { balanceDelta: (kb1 - kb0).toString(), rewards: rewards.toString(), rewardEvents, gasPaid: gasPaid.toString(), keeperTxs, valueIn: valueIn.toString(), valueOut: valueOut.toString() };
    console.log(JSON.stringify(recon));
    assert.equal(kb1 - kb0, rewards - gasPaid + valueIn - valueOut, 'keeper balance reconciles to the wei');

    const sorted = [...stats.reopenMs].sort((a, b) => a - b);
    const summary = {
      rounds: ROUNDS, arrivals: stats.arrivals, foundOpenPct: +(100 * stats.foundOpen / Math.max(1, stats.arrivals)).toFixed(1),
      batches: stats.batches, draws: stats.draws, batchesByPeriod: stats.byPeriod,
      reopenMs: { median: sorted[Math.floor(sorted.length / 2)], p90: sorted[Math.floor(sorted.length * 0.9)], max: sorted.at(-1) },
      aboveCap: { keeperWaited: stats.aboveCapWaited, keeperSent: stats.aboveCapSent, resumedWithoutIntervention: stats.resumedAfterSpike },
      fallback: { purchaseCaused: stats.purchaseCausedSwitches, creatorCaused: stats.creatorCausedSwitches },
      creatorEdits: stats.creatorEdits, creatorRanUpkeep: stats.creatorRanUpkeep, creatorRestocks: stats.creatorRestocks, keeperRestarts: stats.restarts,
      keeper: { netWei: (kb1 - kb0).toString(), sent: health.stats.sent, mined: health.stats.mined, reverted: health.stats.reverted, replaced: health.stats.replaced, skippedUnprofitable: health.stats.skippedUnprofitable, errors: health.errors },
      healthOk: health.ok,
    };
    console.log(JSON.stringify(summary, null, 2));
    assert.equal(health.ok, true, 'keeper health');
    assert.deepEqual(health.errors, {}, 'no pool errors');
    assert.equal(health.stats.reverted, 0, 'no reverted keeper transactions since the last restart');
    assert.equal(stats.aboveCapSent, 0, 'keeper never serviced above the cap');
    if (ROUNDS >= 50) assert.ok(stats.byPeriod.above > 0 && stats.byPeriod.near > 0 && stats.byPeriod.below > 0, 'all gas periods exercised');
    if (ROUNDS >= 25) assert.ok(stats.purchaseCausedSwitches > 0 && stats.creatorCausedSwitches > 0, 'fallback plans exercised');
    assert.ok(kb1 > kb0, 'keeper earned more than it spent');
    console.log('REHEARSAL PASSED');
  } finally {
    keeper?.kill();
    anvil.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
