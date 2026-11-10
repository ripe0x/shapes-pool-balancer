// Launch rehearsal on a local mainnet fork: the production deploy script, two pools, the real keeper service
// (`npm run keeper`, run as its own process exactly as in production), and a driver that only buys draws on FWA,
// delivers randomness, moves basefee through spikes and makes occasional creator edits. Nobody calls upkeep by
// hand. Measures how often a buyer finds a pool open, how long pools take to reopen after a batch, behaviour
// around the 5 gwei cap, and the keeper's profit and loss. Run: npm run rehearsal [-- --rounds 150]
import assert from 'node:assert/strict';
import { execSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, createTestClient, createWalletClient, http, keccak256, parseAbi, toHex, type Address } from 'viem';
import { fwaPoolAbi, poolBalancerAbi } from '../shared/abi';

const PORT = Number(process.env.REHEARSAL_PORT ?? 18547);
const HEALTH = PORT + 300;
const RPC = `http://127.0.0.1:${PORT}`;
const FORK_BLOCK = 26382349n;
const DEPLOYER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const CREATORS = ['0x70997970C51812dc3A010C7d01b50e0d17dc79C8', '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'] as const;
const KEEPER = '0x90F79bf6EB2c4f870365E785982E1f101E93b906' as Address;
const VRF_SERVICE = '0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d' as const;
const serviceAbi = parseAbi(['function coordinator() view returns (address)', 'function rawFulfillRandomWords(uint256 requestId, uint256[] randomWords)']);
const GWEI = 10n ** 9n;

const pub = createPublicClient({ transport: http(RPC) });
const test = createTestClient({ mode: 'anvil', transport: http(RPC) });
const wallet = createWalletClient({ transport: http(RPC) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd: string, env: Record<string, string> = {}) =>
  execSync(cmd, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

let seed = 7n;
const rand = () => { seed = BigInt(keccak256(toHex(seed))) ; return Number(seed % 1_000_000n) / 1_000_000; };

async function status(b: Address) {
  return Number(await pub.readContract({ address: b, abi: poolBalancerAbi, functionName: 'admissionStatus' }));
}

/** Basefee schedule (gwei) by round: mostly mainnet-median, with spikes below and above the 5 gwei cap. */
function basefeeFor(round: number) {
  if (round % 50 >= 20 && round % 50 < 24) return 3; // spike under the cap: keeper should keep servicing
  if (round % 50 >= 35 && round % 50 < 39) return 8; // spike over the cap: keeper should wait, then resume
  return 0.08;
}

async function setBasefee(gwei: number) {
  await test.setNextBlockBaseFeePerGas({ baseFeePerGas: BigInt(Math.round(gwei * 1e9)) });
  await test.mine({ blocks: 1 });
}

async function buyAndSettle(b: Address, count: number, buyer: Address, word: bigint) {
  const pool = (await pub.readContract({ address: b, abi: poolBalancerAbi, functionName: 'pool' })) as Address;
  await test.impersonateAccount({ address: buyer });
  await test.setBalance({ address: buyer, value: 10n ** 21n });
  const [, , total] = (await pub.readContract({ address: pool, abi: fwaPoolAbi, functionName: 'quoteAcquisitionPrice', args: [BigInt(count)] })) as readonly [bigint, bigint, bigint];
  const v = (await pub.readContract({ address: pool, abi: fwaPoolAbi, functionName: 'inventoryVersion' })) as bigint;
  const before = Number(await pub.readContract({ address: pool, abi: fwaPoolAbi, functionName: 'lastIssuedSequence' }));
  const now = (await pub.getBlock()).timestamp;
  const h = await wallet.writeContract({ address: pool, abi: fwaPoolAbi, functionName: 'acquireBatch', args: [buyer, BigInt(count), 0n, 0n, 10_000n, v, now + 600n], value: total * 3n + 10n ** 17n, account: buyer, chain: null, gas: 3_000_000n, maxFeePerGas: 100n * GWEI, maxPriorityFeePerGas: GWEI / 10n });
  assert.equal((await pub.waitForTransactionReceipt({ hash: h })).status, 'success', 'purchase');
  await test.mine({ blocks: 3 });
  const coord = (await pub.readContract({ address: VRF_SERVICE, abi: serviceAbi, functionName: 'coordinator' })) as Address;
  await test.impersonateAccount({ address: coord });
  await test.setBalance({ address: coord, value: 10n ** 18n });
  for (let s = before + 1; s <= before + count; s++) {
    const id = await pub.readContract({ address: pool, abi: fwaPoolAbi, functionName: 'requestIdAtSequence', args: [BigInt(s)] });
    const fh = await wallet.writeContract({ address: VRF_SERVICE, abi: serviceAbi, functionName: 'rawFulfillRandomWords', args: [id as bigint, [BigInt(keccak256(toHex(word * 1000n + BigInt(s))))]], account: coord, chain: null, gas: 5_000_000n, maxFeePerGas: 100n * GWEI, maxPriorityFeePerGas: 0n });
    await pub.waitForTransactionReceipt({ hash: fh });
  }
  if (await pub.readContract({ address: pool, abi: fwaPoolAbi, functionName: 'unsettledAcquisitionCount' })) {
    const ph = await wallet.writeContract({ address: pool, abi: fwaPoolAbi, functionName: 'processAcquisitions', args: [5n], account: DEPLOYER, chain: null, maxFeePerGas: 100n * GWEI, maxPriorityFeePerGas: 0n });
    await pub.waitForTransactionReceipt({ hash: ph });
  }
}

async function main() {
  const roundsArg = process.argv.indexOf('--rounds');
  const ROUNDS = roundsArg > 0 ? Number(process.argv[roundsArg + 1]) : 150;
  const anvil = spawn('anvil', ['--fork-url', 'https://mainnet.gateway.tenderly.co', '--fork-block-number', FORK_BLOCK.toString(), '--port', String(PORT), '--chain-id', '31337', '--silent'], { stdio: 'ignore' });
  let keeper: ReturnType<typeof spawn> | undefined;
  try {
    for (let i = 0; i < 50; i++) { try { await pub.getBlockNumber(); break; } catch { await sleep(200); } }
    sh(`forge script script/Deploy.s.sol --rpc-url ${RPC} --unlocked --sender ${DEPLOYER} --broadcast`);
    const factory = JSON.parse(readFileSync('deployments/31337.json', 'utf8')).balancerFactory as Address;
    const balancers: Address[] = [];
    for (const c of CREATORS) {
      const out = sh(`forge script script/DevSetup.s.sol --tc DevSetup --rpc-url ${RPC} --unlocked --sender ${c} --broadcast`, { FACTORY: factory });
      balancers.push(out.match(/Balancer (0x[0-9a-fA-F]{40})/)![1] as Address);
    }
    await test.setBalance({ address: KEEPER, value: 10n ** 18n });
    await setBasefee(0.08);
    const kb0 = await pub.getBalance({ address: KEEPER });

    // The production keeper entrypoint, as its own process.
    const dir = mkdtempSync(join(tmpdir(), 'rehearsal-'));
    keeper = spawn('npx', ['tsx', 'keeper/keeper.ts'], {
      env: { ...process.env, RPC_URL: RPC, FACTORY: factory, FROM_BLOCK: FORK_BLOCK.toString(), KEEPER_ADDRESS: KEEPER, STATE_FILE: join(dir, 'state.json'), POLL_MS: '800', HEALTH_PORT: String(HEALTH) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const keeperLog: string[] = [];
    keeper.stdout!.on('data', (d) => keeperLog.push(...d.toString().trim().split('\n')));
    keeper.stderr!.on('data', (d) => keeperLog.push(...d.toString().trim().split('\n')));

    const waitOpen = async (b: Address, maxMs: number) => {
      const t0 = Date.now();
      while (Date.now() - t0 < maxMs) {
        if ((await status(b)) === 0) return Date.now() - t0;
        await sleep(200);
      }
      return -1;
    };
    // Initial fill by the keeper alone.
    for (const b of balancers) assert.ok((await waitOpen(b, 90_000)) >= 0, `pool ${b} filled and opened by the keeper`);
    console.log('pools filled and opened by the keeper service');

    const stats = { arrivals: 0, foundOpen: 0, batches: 0, draws: 0, reopenMs: [] as number[], spikeWaits: 0, overCapSends: 0 };
    for (let round = 0; round < ROUNDS; round++) {
      const g = basefeeFor(round);
      await setBasefee(g);
      const b = balancers[Math.floor(rand() * balancers.length)];
      stats.arrivals++;
      if ((await status(b)) !== 0) continue; // buyer turned away
      stats.foundOpen++;
      const count = 1 + Math.floor(rand() * 5);
      await buyAndSettle(b, count, `0x${(0xb0b00000 + round).toString(16).padStart(40, '0')}` as Address, BigInt(round + 1));
      stats.batches++;
      stats.draws += count;
      // Keep the spike level while the keeper decides.
      const t0 = Date.now();
      let reopened = -1;
      while (Date.now() - t0 < 30_000) {
        await setBasefee(g);
        if ((await status(b)) === 0) { reopened = Date.now() - t0; break; }
        await sleep(400);
      }
      if (g > 5) {
        // Over the cap: the keeper must wait (no send), then resume once gas falls.
        if (reopened < 0) stats.spikeWaits++;
        else stats.overCapSends++;
        await setBasefee(0.08);
        reopened = await waitOpen(b, 30_000);
        assert.ok(reopened >= 0, 'pool reopened by the keeper after the spike ended');
      } else {
        assert.ok(reopened >= 0, `pool reopened by the keeper at ${g} gwei`);
      }
      stats.reopenMs.push(reopened);
      // Occasional creator edit: reprice a curated NFT (re-checkpoint is unpaid; the keeper's allowance covers it).
      if (round % 40 === 39) {
        const creator = CREATORS[balancers.indexOf(b)] as Address;
        const ids = (await pub.readContract({ address: b, abi: poolBalancerAbi, functionName: 'getActiveIds' })) as bigint[];
        for (const id of ids) {
          const it = (await pub.readContract({ address: b, abi: poolBalancerAbi, functionName: 'items', args: [id] })) as readonly unknown[];
          if (Number(it[0]) === 1) {
            const h = await wallet.writeContract({ address: b, abi: poolBalancerAbi, functionName: 'updateCuratedPrice', args: [id, (it[3] as bigint) + 10n ** 15n], account: creator, chain: null, maxFeePerGas: 100n * GWEI, maxPriorityFeePerGas: 0n });
            await pub.waitForTransactionReceipt({ hash: h });
            break;
          }
        }
        assert.ok((await waitOpen(b, 30_000)) >= 0, 'reopened after a creator edit without the creator running upkeep');
      }
    }

    const health = await (await fetch(`http://127.0.0.1:${HEALTH}/health`)).json();
    const kb1 = await pub.getBalance({ address: KEEPER });
    const sorted = [...stats.reopenMs].sort((a, b) => a - b);
    const summary = {
      rounds: ROUNDS, arrivals: stats.arrivals, foundOpenPct: +(100 * stats.foundOpen / stats.arrivals).toFixed(1),
      batches: stats.batches, draws: stats.draws,
      reopenMs: { median: sorted[Math.floor(sorted.length / 2)], p90: sorted[Math.floor(sorted.length * 0.9)], max: sorted.at(-1) },
      overCapBatches: { keeperWaited: stats.spikeWaits, keeperSent: stats.overCapSends },
      keeper: { netWei: (kb1 - kb0).toString(), spentWei: health.stats.spentWei, earnedWei: health.stats.earnedWei, sent: health.stats.sent, reverted: health.stats.reverted, skippedUnprofitable: health.stats.skippedUnprofitable, errors: health.errors },
      healthOk: health.ok,
    };
    console.log(JSON.stringify(summary, null, 2));
    assert.equal(health.ok, true, 'keeper health');
    assert.deepEqual(health.errors, {}, 'no pool errors');
    assert.equal(stats.overCapSends, 0, 'keeper never sent above the cap');
    assert.ok(kb1 >= kb0, 'keeper did not lose money overall');
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
