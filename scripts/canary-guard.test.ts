import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPublicClient, createTestClient, createWalletClient, getAddress, http, type Address, type Hex, type PublicClient } from 'viem';
import { CanaryGuard, commitments, evaluate, keeperInFlight, loadPlan, reservedAfter, type CanaryPlan } from './canary-guard';
import { matchPlan, scriptConstants, verify } from './verify-deployment';
import { Keeper } from '../keeper/keeper';

const plan = (over: Partial<CanaryPlan> = {}): CanaryPlan => ({
  rpcUrl: 'http://127.0.0.1:1', chainId: 31337, budgetWei: '50000000000000000',
  accounts: { deployer: { address: '0x000000000000000000000000000000000000d001', startNonce: 0 } },
  actions: [
    { id: 'deploy', account: 'deployer', gasLimit: '21223646', maxFeePerGas: '1500000000' },
    { id: 'keeper-run', account: 'keeper', gasLimit: '0', maxFeePerGas: '0' },
    { id: 'close', account: 'deployer', gasLimit: '100000', maxFeePerGas: '2000000000' },
    { id: 'retire', account: 'deployer', gasLimit: '70000', maxFeePerGas: '2000000000' },
  ],
  ...over,
});
const K = '0x00000000000000000000000000000000000ce3e5' as Address;

describe('canary budget arithmetic', () => {
  it('reserves every planned action after the current one at its maximum', () => {
    expect(reservedAfter(plan(), 'keeper-run')).toBe(100_000n * 2_000_000_000n + 70_000n * 2_000_000_000n);
    expect(reservedAfter(plan(), 'retire')).toBe(0n);
    expect(() => reservedAfter(plan(), 'nope')).toThrow('unknown action');
  });

  it('counts gross spend: received keeper compensation never offsets it', () => {
    // The guard only adds; there is no input through which a reward could reduce spent wei.
    const c = evaluate(plan(), 'keeper-run', 49_000_000_000_000_000n, [], { account: K, gas: 1n, maxFeePerGas: 1n });
    expect(c.totalWei).toBe(49_000_000_000_000_000n + 1n + 340_000_000_000_000n);
    expect(c.ok).toBe(true);
    expect(evaluate(plan(), 'keeper-run', 49_700_000_000_000_000n, [], { account: K, gas: 1n, maxFeePerGas: 1n }).ok).toBe(false);
  });

  it('charges a fee replacement once, at the larger of the old and new maximums', () => {
    const inFlight = [{ account: K, nonce: 7, gas: 4_000_000n, maxFeePerGas: 1_000_000_000n }, { account: K, nonce: 8, gas: 4_000_000n, maxFeePerGas: 1_000_000_000n }];
    const bump = commitments(inFlight, { account: K, nonce: 7, gas: 4_000_000n, maxFeePerGas: 1_250_000_001n });
    expect(bump).toEqual({ inFlightWei: 4_000_000_000_000_000n, nextWei: 4_000_000n * 1_250_000_001n });
    const smaller = commitments(inFlight, { account: K, nonce: 7, gas: 1_000_000n, maxFeePerGas: 1_250_000_001n });
    expect(smaller.nextWei).toBe(4_000_000_000_000_000n);
  });

  it("reads the keeper's pending and evicted sends from its state", () => {
    const state = { pending: { a: { nonce: 3, gas: '4000000', maxFeePerGas: '1000' } }, accounting: { 2: { pending: { nonce: 2, gas: '5000000', maxFeePerGas: '900' } } } };
    expect(keeperInFlight(state, K)).toEqual([{ account: K, nonce: 3, gas: 4_000_000n, maxFeePerGas: 1000n }, { account: K, nonce: 2, gas: 5_000_000n, maxFeePerGas: 900n }]);
  });

  it('refuses a send when the budget cannot be read', async () => {
    const logs: string[] = [];
    const hook = new CanaryGuard(plan()).keeperHook(K, 'keeper-run', (m) => logs.push(m));
    expect(await hook({ gas: 1n, maxFeePerGas: 1n, nonce: 0 }, [])).toBe(false);
    expect(logs).toEqual(['canary budget: unreadable, refusing send']);
  });

  it('rejects a plan without addresses or with duplicate actions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'canary-plan-'));
    const f = join(dir, 'p.json');
    writeFileSync(f, JSON.stringify(plan({ accounts: { deployer: { address: '<owner-chosen>', startNonce: null } } })));
    expect(() => loadPlan(f)).toThrow('has no address');
    writeFileSync(f, JSON.stringify(plan({ actions: [plan().actions[0], plan().actions[0]] })));
    expect(() => loadPlan(f)).toThrow('uniquely named');
  });
});

describe('deployment verification inputs', () => {
  it('takes its constants from Deploy.s.sol', () => {
    expect(scriptConstants(readFileSync('script/Deploy.s.sol', 'utf8'))).toEqual({
      fwaFactory: '0x8919814D825a5Af238cC04DE06b1C18c9eaA477C', fwaImpl: '0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7',
      shapes: '0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0', ens: '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e', packsName: 'Pool Prize Packs', packsSymbol: 'PRIZEPACK',
    });
  });
});

// Real transactions on the existing local mainnet fork (chain 31337), reverted afterwards. Opt in: LOCAL_FORK_RPC=http://127.0.0.1:8545
const RPC = process.env.LOCAL_FORK_RPC;
const URL_ = RPC ?? "http://127.0.0.1:8545"; // clients are built even when the suite is skipped
describe.skipIf(!RPC)('on a local mainnet fork', () => {
  const pub = createPublicClient({ transport: http(URL_, { timeout: 120_000 }) }) as PublicClient;
  const test = createTestClient({ mode: 'anvil', transport: http(URL_, { timeout: 120_000 }) });
  const wallet = createWalletClient({ transport: http(URL_, { timeout: 120_000 }) });
  const [deployer, packsAdmin, keeperAdmin, policyAdmin, creator, keeper] = ['d001', 'd002', 'd003', 'd004', 'd005', 'd006']
    .map(s => getAddress(`0x00000000000000000000000000000000000c${s.padStart(4, '0')}`)) as Address[];
  const dir = mkdtempSync(join(tmpdir(), 'canary-fork-'));
  let snapshot: Hex;
  const forge = (args: string[], env: Record<string, string> = {}) =>
    execFileSync('forge', args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 }).toString();
  const roles = { deployer, packsAdmin, keeperAdmin, policyAdmin };
  const deployEnv = { PACKS_ADMIN: packsAdmin, KEEPER_ADMIN: keeperAdmin, POLICY_ADMIN: policyAdmin };
  let factory: Address;

  beforeAll(async () => {
    snapshot = await test.snapshot();
    for (const a of [deployer, creator, keeper]) { await test.setBalance({ address: a, value: 10n ** 19n }); await test.impersonateAccount({ address: a }); }
  }, 600_000);
  afterAll(async () => { await test.setAutomine(true); if (snapshot) await test.revert({ id: snapshot }); });

  it('verifies a real broadcast against the reviewed dry run, and rejects anything else', async () => {
    forge(['script', 'script/Deploy.s.sol', '--rpc-url', RPC!, '--sender', deployer], deployEnv);
    const reviewed = join(dir, 'reviewed-dry-run.json');
    copyFileSync('broadcast/Deploy.s.sol/31337/dry-run/run-latest.json', reviewed);
    forge(['script', 'script/Deploy.s.sol', '--rpc-url', RPC!, '--unlocked', '--sender', deployer, '--broadcast', '--slow'], deployEnv);
    const sent = join(dir, 'broadcast.json');
    copyFileSync('broadcast/Deploy.s.sol/31337/run-latest.json', sent);
    const source = readFileSync('script/Deploy.s.sol', 'utf8');

    const ok = await verify(pub, reviewed, sent, roles, source);
    expect(ok.bad).toEqual([]);
    const r = ok.record!;
    factory = r.balancerFactory;
    expect(Object.keys(r.transactions)).toEqual(['KeeperPolicyCalls', 'PoolPage', 'PoolInventory', 'ShapePackRenderer', 'ShapePacks', 'PoolBalancer', 'KeeperPolicyV1', 'BalancerFactory']);
    const factoryReceipt = await pub.getTransactionReceipt({ hash: r.transactions.BalancerFactory.hash });
    expect(r.factoryDeploymentBlock).toBe(factoryReceipt.blockNumber.toString());
    const simulated = JSON.parse(readFileSync('deployments/31337.json', 'utf8'));
    expect(BigInt(simulated.block)).toBeLessThan(factoryReceipt.blockNumber); // the script's own block is the simulation block

    expect((await verify(pub, reviewed, reviewed, roles, source)).bad.some(b => b.includes('no transaction hash'))).toBe(true);
    expect((await verify(pub, reviewed, sent, { ...roles, keeperAdmin: packsAdmin }, source)).bad).toEqual([`factory.keeperAdmin = ${keeperAdmin}, expected ${packsAdmin}`]);
    const tampered = JSON.parse(readFileSync(reviewed, 'utf8'));
    tampered.transactions[5].transaction.input = tampered.transactions[5].transaction.input.slice(0, -2) + '00';
    const t = join(dir, 'tampered.json');
    writeFileSync(t, JSON.stringify(tampered));
    expect(matchPlan(tampered.transactions, JSON.parse(readFileSync(sent, 'utf8')).transactions)).toEqual(['PoolBalancer: calldata differs from the reviewed dry run']);
  }, 900_000);

  it('sums gross gas from canonical receipts, including reverted transactions, and fails closed on unknown pending sends', async () => {
    const p = plan({ rpcUrl: RPC!, accounts: { creator: { address: creator, startNonce: await pub.getTransactionCount({ address: creator }) } } });
    const guard = new CanaryGuard(p, pub);
    const before = await guard.spent();
    expect(before).toBe(0n);
    const h1 = await wallet.sendTransaction({ account: creator, to: keeper, value: 1n, chain: null });
    // Shapes.mintBatch without payment reverts but is included and paid for.
    const h2 = await wallet.sendTransaction({ account: creator, to: '0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0', data: '0xaba5ede1000000000000000000000000000000000000000000000000002386f26fc100000000000000000000000000000000000000000000000000000000000000000001', gas: 300_000n, chain: null });
    const r = await Promise.all([h1, h2].map(hash => pub.waitForTransactionReceipt({ hash })));
    expect(r[1].status).toBe('reverted');
    expect(await guard.spent()).toBe(r.reduce((s, x) => s + x.gasUsed * x.effectiveGasPrice, 0n));

    await test.setAutomine(false);
    const h3 = await wallet.sendTransaction({ account: creator, to: keeper, value: 1n, chain: null });
    await expect(guard.check('keeper-run', { account: keeper, gas: 1n, maxFeePerGas: 1n })).rejects.toThrow('unaccounted pending transaction');
    await test.mine({ blocks: 1 });
    await test.setAutomine(true);
    await pub.waitForTransactionReceipt({ hash: h3 });
    expect((await guard.check('keeper-run', { account: keeper, gas: 1n, maxFeePerGas: 1n })).ok).toBe(true);
  }, 300_000);

  it('withholds a real paid upkeep that would breach the budget and sends it when it fits', async () => {
    expect(factory).toBeDefined();
    forge(['script', 'script/DevSetup.s.sol', '--tc', 'DevSetup', '--rpc-url', RPC!, '--unlocked', '--sender', creator, '--broadcast'], { FACTORY: factory });
    const fromBlock = await pub.getBlockNumber() - 50n;
    const start = await pub.getTransactionCount({ address: keeper });
    const budget = (wei: bigint): CanaryPlan => plan({ rpcUrl: RPC!, budgetWei: wei.toString(), accounts: { keeper: { address: keeper, startNonce: start } } });
    const keeperWith = (p: CanaryPlan, name: string) => new Keeper({
      rpcUrl: RPC!, factory, fromBlock, stateFile: join(dir, `${name}.json`), account: keeper, maxGasPriceGwei: 50, log: () => {},
      beforeSend: new CanaryGuard(p, pub).keeperHook(keeper),
    });
    const tight = keeperWith(budget(340_000_000_000_000n + 1n), 'tight'); // covers only the reserved closeout
    await tight.tick();
    expect(tight.state.stats.sent).toBe(0);
    expect(await pub.getTransactionCount({ address: keeper, blockTag: 'pending' })).toBe(start);

    const roomy = keeperWith(budget(10n ** 17n), 'roomy');
    await roomy.tick();
    expect(roomy.state.stats.sent).toBe(1);
    const hash = Object.values(roomy.state.pending)[0].hashes[0];
    const receipt = await pub.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe('success');
    const spent = await new CanaryGuard(budget(10n ** 17n), pub).spent();
    expect(spent).toBe(receipt.gasUsed * receipt.effectiveGasPrice);
    expect(spent).toBeGreaterThan(0n);
  }, 900_000);
});
