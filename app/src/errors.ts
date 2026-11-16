import { BaseError, ContractFunctionRevertedError, decodeErrorResult, parseAbi } from 'viem';

const FWA_ERRORS = parseAbi(['error WithdrawLocked()']);

const ERRORS: Record<string, string> = {
  NoUpkeepNeeded: 'nothing to do right now',
  WithdrawLocked: 'draws are settling on FWA; try again in a minute',
  InsufficientSurplus: 'amount exceeds claimable surplus',
  ReserveNotFunded: 'deposit the reserve first',
  InvalidConfig: 'the markup must be 10% to 100%, with a saved mix',
  Unauthorized: 'only the creator can do this',
  NotClosed: 'close purchases first',
  InvalidPlan: 'the mix needs at least one prize and no more than this pool allows',
  ShapesNotCurated: 'Shapes cannot be listed as curated NFTs',
  ProtectedAsset: 'this contract does not hold that NFT outside FWA (listed, pending or not owned)',
  InvalidItem: 'not available for this action (check its FWA status)',
  SettingOutOfRange: 'a value is outside its allowed range',
};

export function explain(e: unknown): string {
  if (e instanceof BaseError) {
    const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    let name = reverted?.data?.errorName;
    // FWA's own errors bubble up through the Balancer but are not in its ABI.
    if (!name && reverted?.raw) {
      try {
        name = decodeErrorResult({ abi: FWA_ERRORS, data: reverted.raw }).errorName;
      } catch {} // not one of FWA's either: fall through to the short message
    }
    // Error(string) reverts carry their message as the reason.
    if (name === 'Error' && reverted?.reason) return reverted.reason;
    if (name) return ERRORS[name] ?? name;
    return e.shortMessage;
  }
  return (e as Error).message;
}
