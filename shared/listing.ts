// First stocking (a pool still SETTING_UP) waits for low gas: listing a whole design at a high gas price can spend far
// more than the listing budget priced into the creator's deposit. Our keeper skips such a pool above this basefee, and
// the app tells the creator automatic listing is paused. The factory's gas price ceiling still bounds every keeper.
export const SETTING_UP = 2;
export const SETUP_LISTING_MAX_BASEFEE = 1_000_000_000n; // 1 gwei

/** The basefee above which a pool's first listing waits: the lower of our keeper's limit and the pool's gas ceiling. */
export const setupListingLimit = (gasPriceCeiling?: bigint, max = SETUP_LISTING_MAX_BASEFEE) =>
  gasPriceCeiling !== undefined && gasPriceCeiling < max ? gasPriceCeiling : max;

/** Whether automatic first listing waits at this basefee. */
export const setupListingWaits = (admission: number, baseFee: bigint, limit = SETUP_LISTING_MAX_BASEFEE) =>
  admission === SETTING_UP && baseFee > limit;
