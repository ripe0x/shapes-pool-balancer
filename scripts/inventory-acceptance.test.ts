import { expect, it } from 'vitest';
import { join } from 'node:path';
import { ARTIFACTS, INVENTORY_CAPS, INVENTORY_FUNDING, INVENTORY_SCENARIO, MAINNET, ROLES, ROOT,
  forgeArguments, inventoryPermit, json, validateCurrentBounds } from './current-local-rehearsal';

const factory = '0x000000000000000000000000000000000000f001' as const;
const balancer = '0x000000000000000000000000000000000000b001' as const;
const demo = '0x000000000000000000000000000000000000d001' as const;
const weth = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as const;
const plan = () => {
  const p = { schema: 'inventory-local-acceptance-v1', repositoryRoot: ROOT, revision: '1'.repeat(40), chainId: 31337,
    rpc: 'http://127.0.0.1:18786', upstream: MAINNET, roles: ROLES, funding: JSON.parse(json(INVENTORY_FUNDING)),
    caps: JSON.parse(json(INVENTORY_CAPS)), scenario: INVENTORY_SCENARIO, maxFeePerGas: '20000000000',
    maxPriorityFeePerGas: '50000000', perTransactionGas: '16777216',
    evidenceDirectory: join(ROOT, 'docs/receipts/current-rehearsal/inventory-test'),
    planFile: join(ROOT, 'docs/receipts/current-rehearsal/inventory-test/bounded-plan.json'),
    artifacts: Object.fromEntries(ARTIFACTS.map(p => [p, 'test-input-only'])), reuseDependencies: true,
    deployment: ['PoolInventory', 'PoolBalancer', 'BalancerFactory'].map(name => ({ name, gasLimit: '1000000' })),
    forgeArguments: [] as string[] };
  p.forgeArguments = forgeArguments(p); return p;
};

it('inventory acceptance forbids real networks, draws, larger caps and extra oracle permissions', () => {
  validateCurrentBounds(plan());
  for (const edit of [(p: any) => p.chainId = 1, (p: any) => p.rpc = MAINNET,
    (p: any) => p.caps.draws = 1, (p: any) => p.caps.gas = '2000000000000000000',
    (p: any) => p.scenario = { ...p.scenario, oracle: 'impersonated coordinator' },
    (p: any) => p.scenario = { ...p.scenario, uiWritesSupported: true }]) {
    const p = plan(); edit(p); expect(() => validateCurrentBounds(p)).toThrow();
  }
});

it('inventory acceptance confines WETH and native withdrawal to its named synthetic owner', () => {
  const run = { plan: plan(), factory, journal: { receipts: [], spent: { deposits: '0' }, pools: [{ demo, balancer }] } };
  const permit = (actor: `0x${string}`, to: `0x${string}`, fn: string, args: unknown[], value = 0n) => inventoryPermit(run, actor, to, fn, args, value);
  expect(() => permit(ROLES.policyAdmin, weth, 'deposit', [], 100_000_000_000_000_000n)).not.toThrow();
  expect(() => permit(ROLES.policyAdmin, balancer, 'recoverERC20', [weth, 100_000_000_000_000_000n])).not.toThrow();
  expect(() => permit(ROLES.creatorA, balancer, 'recoverERC20', [weth, 100_000_000_000_000_000n])).toThrow();
  expect(() => permit(ROLES.policyAdmin, balancer, 'claimSurplus', [1n, ROLES.creatorA])).toThrow();
  expect(() => permit(ROLES.policyAdmin, balancer, 'recoverERC20', [demo, 1n])).toThrow();
  expect(() => permit(ROLES.policyAdmin, factory, 'setCreationPaused', [false])).toThrow();
  expect(() => permit(ROLES.policyAdmin, weth, 'approve', [balancer, 1n])).toThrow();
  expect(() => permit(ROLES.policyAdmin, demo, 'mint', [ROLES.creatorA, 1n])).toThrow();
});

it('inventory acceptance stages legacy discovery data needed by its guarded wrapper', async () => {
  const { manifest } = await import('./current-local-rehearsal');
  expect(manifest().some(input => input.path === 'deployments/1.legacy.json')).toBe(true);
});

it('inventory acceptance rejects historical timing, fee and negative-transaction methods before any RPC', async () => {
  const { CurrentRehearsal } = await import('./current-local-rehearsal');
  const state = { plan: plan(), journal: { mutations: [] } };
  await expect(CurrentRehearsal.prototype.mine.call(state as never, 1)).rejects.toThrow();
  await expect(CurrentRehearsal.prototype.basefee.call(state as never, 0n)).rejects.toThrow('no synthetic fee changes');
  await expect(CurrentRehearsal.prototype.creationReceiptProbe.call(state as never, ROLES.policyAdmin, [], 0n)).rejects.toThrow('no negative receipt probe');
});
