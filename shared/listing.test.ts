import { describe, expect, it } from 'vitest';
import { SETUP_LISTING_MAX_BASEFEE, setupListingLimit, setupListingWaits } from './listing';

const gwei = (x: number) => BigInt(Math.round(x * 1e9));

describe('first listing waits for low gas', () => {
  it('waits only while stocking and only above the limit', () => {
    expect(setupListingWaits(2, gwei(1.01))).toBe(true);
    expect(setupListingWaits(2, gwei(1))).toBe(false);
    expect(setupListingWaits(0, gwei(50))).toBe(false); // an open pool's restocking is not held back
  });
  it('uses the lower of the keeper limit and the gas price ceiling', () => {
    expect(setupListingLimit(gwei(5))).toBe(SETUP_LISTING_MAX_BASEFEE);
    expect(setupListingLimit(gwei(0.5))).toBe(gwei(0.5));
    expect(setupListingLimit(undefined)).toBe(SETUP_LISTING_MAX_BASEFEE);
  });
});
