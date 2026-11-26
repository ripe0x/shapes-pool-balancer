import { expect, it } from 'vitest';
import { encodePacked, getAddress, keccak256 } from 'viem';
import { acquisitionOutcome, bankrollValues, requestOwnerBase, resumeEvidence, scenarioDeposit, STRESS_CREATION_SALT, STRESS_SCOPE, stressPlan } from './local-stress-campaign';

it('bounds the exact campaign to 18 design/rate pairs and six independent stress regimes', () => {
  const plans = stressPlan(), baseline = plans.filter(p => p.mode === 'baseline');
  expect(plans).toHaveLength(24); expect(new Set(plans.map(p => p.id)).size).toBe(24);
  expect(baseline).toHaveLength(18); expect(plans.length * 120).toBeLessThanOrEqual(3000);
  expect([...new Set(baseline.map(p => p.rate))]).toEqual([10, 240, 86400]);
  for (const p of plans) { expect(p.design.counts).toHaveLength(16); expect(p.design.counts.every(n => Number.isInteger(n) && n >= 0)).toBe(true); }
  const packs = baseline.find(p => p.design.name === 'pack')!;
  expect(packs.design.counts.slice(9, 13)).toEqual([3, 2, 0, 1]);
  expect(plans.filter(p => p.mode !== 'baseline').every(p => p.design.name === 'balanced')).toBe(true);
});

it('pins writes to the isolated child and validates the implementation address at import time', () => {
  expect(STRESS_SCOPE.rpc).toBe('http://127.0.0.1:18555');
  expect(STRESS_SCOPE.upstream).toBe('http://127.0.0.1:18557');
  expect(STRESS_SCOPE.chainId).toBe(31337);
  expect(STRESS_SCOPE.implementation).toBe(getAddress('0xc02d40577880fa2c489fc5461ce3830d4eed7724'));
});

it('separates protected fees and signed bankroll loss, and reinvestment creates no extra earnings', () => {
  expect(bankrollValues(100n, 0n, 0n, 100n)).toEqual({ operating: 100n, signed: 0n, clipped: 0n });
  expect(bankrollValues(80n, 10n, 5n, 100n)).toEqual({ operating: 75n, signed: -15n, clipped: 0n });
  expect(bankrollValues(80n, 10n, 2n, 103n)).toEqual({ operating: 78n, signed: -15n, clipped: 0n });
  expect(bankrollValues(120n, 10n, 5n, 100n)).toEqual({ operating: 115n, signed: 25n, clipped: 25n });
  expect(() => bankrollValues(4n, 10n, 5n, 100n)).toThrow('creator fees exceed cash');
});


it('derives owner proceeds from genuine purchase-block inventory and caps it at the escrowed request price', () => {
  expect(requestOwnerBase(10n, 123n, 20n)).toBe(12n);
  expect(requestOwnerBase(10n, 123n, 11n)).toBe(11n);
  expect(() => requestOwnerBase(0n, 123n, 20n)).toThrow('request inventory weight must be positive');
});

it('distinguishes delivered NFTs, actual expiries and actual selection refunds without accepting unsettled states', () => {
  expect(acquisitionOutcome(2)).toBe('nft');
  expect(acquisitionOutcome(3)).toBe('expired');
  expect(acquisitionOutcome(4)).toBe('refunded');
  for (const status of [0, 1, 5, 6, 7, 8]) expect(() => acquisitionOutcome(status)).toThrow('acquisition not settled');
});


it('uses the already-warm small-design salt for every independently reverted design and rate', () => {
  expect(STRESS_CREATION_SALT).toBe(keccak256(encodePacked(['string'], ['local-stress-v2:small'])));
  expect(new Set(stressPlan().map(p => p.design.name)).size).toBe(6);
});

it('retains completed and paused evidence while preserving failed attempts and their findings for continuation', () => {
  const previous = { schema: 'local-stress-v2', chainId: 31337, randomness: 'simulated', status: 'stopped', startedAt: 'original-clock', budget: { transactions: 99 }, scenarios: [{ id: 'small-10', status: 'complete' }, { id: 'small-240', status: 'paused' }, { id: 'balanced-10', status: 'failed', drawsSettled: 78 }], findings: [{ severity: 'error', scenarioId: 'balanced-10', text: 'meter stopped' }] };
  const resumed = resumeEvidence(previous, '/original/results.json');
  expect(resumed.scenarios.map((s: { id: string }) => s.id)).toEqual(['small-10', 'small-240']);
  expect(resumed.priorAttempts[0].scenarios).toEqual([previous.scenarios[2]]);
  expect(resumed.priorAttempts[0].startedAt).toBe('original-clock');
  expect(resumed.priorAttempts[0].budget).toEqual({ transactions: 99 });
  expect(resumed.findings[0]).toMatchObject({ historical: true, text: 'meter stopped', attemptSource: '/original/results.json' });
  expect(previous.scenarios).toHaveLength(3);
});


it('lowers capital only for the controlled reinvestment regime while retaining its full opening reserve', () => {
  const eth = 10n ** 18n, backing = 460n * eth / 1000n, mint = 11n * eth / 1000n;
  const reserve = 475n * eth / 1000n;
  expect(scenarioDeposit('feeReinvestOnGap', backing, mint, reserve)).toBe(485n * eth / 1000n);
  for (const mode of ['baseline', 'forcedLargest', 'feeWithdrawEvery20', 'gasSpike', 'keeperOutage', 'zeroDemandWinddown'])
    expect(scenarioDeposit(mode, backing, mint, reserve)).toBe(573n * eth / 1000n);
  expect(scenarioDeposit('feeReinvestOnGap', backing, mint, 0n)).toBe(481n * eth / 1000n);
});


it('preserves original historical failure provenance across a second resume after the same scenario succeeds', () => {
  const original = { schema: 'local-stress-v2', chainId: 31337, randomness: 'simulated', status: 'stopped', scenarios: [{ id: 'balanced-10', status: 'failed' }], findings: [{ severity: 'error', scenarioId: 'balanced-10', text: 'original source cap' }] };
  const first = resumeEvidence(original, '/original/results.json');
  const continued = { ...original, ...first, scenarios: [{ id: 'balanced-10', status: 'complete' }] };
  const second = resumeEvidence(continued, '/continuation/results.json');
  expect(second.scenarios).toEqual([{ id: 'balanced-10', status: 'complete' }]);
  expect(second.findings[0]).toMatchObject({ historical: true, attemptSource: '/original/results.json', text: 'original source cap' });
  expect(first.findings[0]).toEqual(second.findings[0]);
});
