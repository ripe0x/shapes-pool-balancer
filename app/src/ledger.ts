import type { Address } from 'viem';

export interface CapitalFlow { participant: Address; amount: bigint }
const total = (flows: CapitalFlow[]) => flows.reduce((sum, flow) => sum + flow.amount, 0n);
function byParticipant(flows: CapitalFlow[]) {
  const grouped = new Map<string, CapitalFlow>();
  for (const flow of flows) {
    const key = flow.participant.toLowerCase();
    const previous = grouped.get(key);
    grouped.set(key, { participant: previous?.participant ?? flow.participant, amount: (previous?.amount ?? 0n) + flow.amount });
  }
  return [...grouped.values()];
}

/** Lifetime pool operations exclude contributions, withdrawals, wallet gas and curated NFT valuation. */
export function poolEthLedger(input: { deposits: CapitalFlow[]; withdrawals: CapitalFlow[]; held: bigint;
  sales: bigint; prizesWon: bigint; mintFees: bigint; keeperPay: bigint }) {
  const { sales, prizesWon, mintFees, keeperPay, held } = input;
  const deposited = total(input.deposits), withdrawn = total(input.withdrawals);
  const operatingResult = sales - prizesWon - mintFees - keeperPay;
  return { sales, prizesWon, mintFees, keeperPay, held, deposited, withdrawn, operatingResult,
    depositors: byParticipant(input.deposits), recipients: byParticipant(input.withdrawals),
    // Eventless ETH and incomplete accounting cannot be attributed to an actor from these logs.
    reconciliation: withdrawn + held - deposited - operatingResult };
}

/** Next log range after a cache that covers through `through`: cached logs up to `keepThrough` are kept, and the last
 *  `reorgWindow` blocks are fetched again so a reorganized block's events are replaced, not duplicated. */
export function incrementalRange(through: bigint | undefined, fromBlock: bigint, reorgWindow: bigint) {
  const keepThrough = through === undefined ? fromBlock - 1n : through - reorgWindow;
  return { from: keepThrough + 1n > fromBlock ? keepThrough + 1n : fromBlock, keepThrough };
}
