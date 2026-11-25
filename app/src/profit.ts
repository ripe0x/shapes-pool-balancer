import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, parseAbi, type Address, type PublicClient } from 'viem';

export const profitAbi = parseAbi([
  'function profitAccountingVersion() pure returns (uint256)',
  'function operatingCapital() view returns (uint256)',
  'function bankrollProfit() view returns (uint256)',
  'function creatorFeeTopUpAvailable() view returns (uint256)',
  'function creatorFeeUpdatePending() view returns (bool)',
  'function reinvestCreatorFees(uint256 maximumAmount)',
]);

/** Accounting follows the fixed clone, independently of the factory's current implementation. */
export async function readProfitVersion(pub: Pick<PublicClient, 'readContract'>, balancer: Address, blockNumber: bigint) {
  try {
    return await pub.readContract({ address: balancer, abi: profitAbi, functionName: 'profitAccountingVersion', blockNumber });
  } catch (error) {
    const unavailable = error instanceof BaseError
      ? error.walk(cause => cause instanceof ContractFunctionRevertedError || cause instanceof ContractFunctionZeroDataError)
      : undefined;
    if (unavailable instanceof ContractFunctionRevertedError || unavailable instanceof ContractFunctionZeroDataError) return 0n;
    throw error;
  }
}

export const operatingCash = (balance: bigint, credit: bigint, profitAccounting: boolean, creatorFeeAccounting = false) => profitAccounting && !creatorFeeAccounting ? balance : balance - credit;

export function withdrawalBreakdown(credit: bigint, surplus: bigint | undefined, profitAccounting: boolean, creatorFeeAccounting = false) {
  const total = surplus ?? (profitAccounting ? 0n : credit);
  const earnings = (profitAccounting || creatorFeeAccounting) && total < credit ? total : credit;
  return { total, earnings, capital: surplus === undefined ? undefined : total - earnings };
}
