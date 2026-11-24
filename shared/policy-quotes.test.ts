import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { quoteV1, restockFeeAt, type KeeperWork } from './planner';

describe('payment arithmetic parity with the in-library formula on the fork', () => {
  it('matches KeeperPolicyCalls.reward and restock at normal, cap and spike gas, including packs', () => {
    const fixture = JSON.parse(readFileSync('test/fixtures/keeper-policy-quotes.json', 'utf8'));
    const rows = Object.values(fixture).map((r) => typeof r === 'string' ? JSON.parse(r) : r) as Record<string, string | number>[];
    // One formula since R95: the former second (V2) policy's rows are gone.
    expect(rows.length).toBe(5);
    let pack = false;
    for (const row of rows) {
      const b = (key: string) => BigInt(row[key]);
      const work: KeeperWork = {
        measuredGas: b('measuredGas'), gasPrice: b('gasPrice'), baseFee: b('baseFee'),
        reconciledDraws: b('reconciledDraws'), listedShapeUnits: b('listedShapeUnits'),
        listedPrizes: b('listedPrizes'), processedDraws: b('processedDraws'),
      };
      expect(Number(row.version)).toBe(1);
      const d = Number(row.denomination);
      const units = b('shapeUnits');
      expect(quoteV1(work), `${work.baseFee} wei basefee`).toBe(b('reward'));
      expect(units * restockFeeAt(work.baseFee), `size ${d}`).toBe(b('surcharge'));
      pack ||= d >= 9;
    }
    expect(pack).toBe(true);
  });
});
