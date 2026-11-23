import { describe, expect, it } from 'vitest';
import fixture from '../test/fixtures/reserve-capital.json';
import { DENOMS, MAX_KEEPER_REWARD, SHAPES_IN, requiredReserveAt } from './planner';
import { capitalComparisons, REPRESENTATIVE_BOARDS } from '../sim/fund';

interface QuoteRow {
  kind: 'board' | 'closed' | 'paid-disabled'; name?: string; target: number[]; have?: number[];
  baseFee: string; gasPrice?: string; mintFee: string; maxReward: string;
  opening?: string; stocked?: string; backing?: string; shapeUnits?: string; forkBlock?: number;
  enabled?: boolean; owed?: number; required?: string;
}
const rows = Object.values(fixture) as QuoteRow[];
const boardRows = rows.filter((r) => r.kind === 'board');
const comparisons = capitalComparisons();

describe('capital matrix parity with actual KeeperPolicyCalls.reserve quotes', () => {
  it('contains all eight independently named boards and five actual execution fee contexts', () => {
    expect(boardRows).toHaveLength(40);
    const names = new Set(boardRows.map((r) => r.name));
    expect(names.size).toBe(8);
    for (const name of names) {
      expect(boardRows.filter((r) => r.name === name).map((r) => BigInt(r.baseFee)).sort((a, b) => Number(a - b)))
        .toEqual([150_000_000n, 500_000_000n, 1_000_000_000n, 3_000_000_000n, 5_000_000_000n]);
    }
  });

  for (const row of boardRows) {
    it(`${row.name}, ${Number(row.baseFee) / 1e9} gwei: opening, stocked, inventory and report`, () => {
      const mintFee = BigInt(row.mintFee), maximum = BigInt(row.maxReward), baseFee = BigInt(row.baseFee);
      expect(row.forkBlock).toBe(26_382_349);
      expect(maximum).toBe(MAX_KEEPER_REWARD);
      expect(mintFee).toBe(1_000_000_000_000_000n);
      expect(BigInt(row.gasPrice!)).toBe(baseFee === 5_000_000_000n ? baseFee : baseFee + 50_000_000n);
      expect(row.target).toEqual(REPRESENTATIVE_BOARDS.find((b) => b.name === row.name)!.target);
      const none = DENOMS.map(() => 0);
      expect(requiredReserveAt(row.target, none, mintFee, 0, maximum, baseFee)).toBe(BigInt(row.opening!));
      expect(requiredReserveAt(row.target, row.target, mintFee, 0, maximum, baseFee)).toBe(BigInt(row.stocked!));
      const backing = row.target.reduce((a, n, d) => a + BigInt(n) * DENOMS[d], 0n);
      const units = row.target.reduce((a, n, d) => a + BigInt(n * SHAPES_IN[d]), 0n);
      expect(backing).toBe(BigInt(row.backing!));
      expect(units).toBe(BigInt(row.shapeUnits!));
      expect(BigInt(row.opening!)).toBeGreaterThanOrEqual(backing + units * mintFee);
      const report = comparisons.find((r) => r.name === row.name && Math.round(r.baseFeeGwei * 1e9) === Number(baseFee));
      expect(report, 'same explicitly specified report board').toBeDefined();
      expect(report!.afterWei).toBe(row.opening);
      expect(report!.stockedWei).toBe(row.stocked);
      expect(report!.backingWei).toBe(row.backing);
      expect(report!.mintFeesWei).toBe((units * mintFee).toString());
    });
  }

  it('matches closed actual obligations and disabled-paid missing inventory without fee-income offsets', () => {
    const edges = rows.filter((r) => r.kind !== 'board');
    expect(edges).toHaveLength(2);
    for (const row of edges) {
      const need = requiredReserveAt(row.target, row.have!, BigInt(row.mintFee), row.owed!,
        BigInt(row.maxReward), BigInt(row.baseFee), row.enabled);
      expect(need).toBe(BigInt(row.required!));
      expect(need).toBe(row.kind === 'closed' ? 2_471_000_000_000_000n : 33_000_000_000_000_000n);
    }
  });
});
