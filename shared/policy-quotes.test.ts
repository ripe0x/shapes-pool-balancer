import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { quoteV1, restockFeeAt, type KeeperWork } from './planner';
import { V2 } from '../sim/fund';

describe('policy arithmetic parity with deployed-on-fork policy calls', () => {
  it('matches both materially different schedules at normal, cap and spike gas, including packs', () => {
    const fixture = JSON.parse(readFileSync('test/fixtures/keeper-policy-quotes.json', 'utf8'));
    const rows = Object.values(fixture).map((r) => typeof r === 'string' ? JSON.parse(r) : r) as Record<string, string | number>[];
    expect(rows.length).toBeGreaterThanOrEqual(8);
    const versions = new Set<number>();
    let pack = false;
    for (const row of rows) {
      const b = (key: string) => BigInt(row[key]);
      const work: KeeperWork = {
        measuredGas: b('measuredGas'), gasPrice: b('gasPrice'), baseFee: b('baseFee'),
        reconciledDraws: b('reconciledDraws'), listedShapeUnits: b('listedShapeUnits'),
        listedPrizes: b('listedPrizes'), processedDraws: b('processedDraws'),
      };
      const version = Number(row.version);
      const d = Number(row.denomination);
      const units = b('shapeUnits');
      const reward = version === 1 ? quoteV1(work) : V2.reward(work);
      const surcharge = version === 1 ? units * restockFeeAt(work.baseFee) : V2.surcharge(d, work.baseFee);
      expect(reward, `version ${version}, ${work.baseFee} wei basefee`).toBe(b('reward'));
      expect(surcharge, `version ${version}, size ${d}`).toBe(b('surcharge'));
      versions.add(version); pack ||= d >= 9;
    }
    expect(versions).toEqual(new Set([1, 2]));
    expect(pack).toBe(true);
  });
});
