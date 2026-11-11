import type { Address, PublicClient } from 'viem';

type Client = Pick<PublicClient, 'simulateContract' | 'estimateContractGas' | 'chain'>;
type Params = Record<string, unknown> & { gas?: bigint };

/** Gas limit headroom over the node's estimate. Gas use can rise between estimation and inclusion (Shapes mint gas
 *  varies with each block's seed; an FWA listing sent with an exact estimate was seen to fail inside a nested call).
 *  The margin is a limit only: the sender is charged for gas used, and keepers are reimbursed for measured gas. */
export const GAS_MARGIN_NUM = 13n;
export const GAS_MARGIN_DEN = 10n;

/** Simulate the exact call (so reverts surface by name), then set its gas limit to the estimate for the same account,
 *  contract, calldata and value plus 30%. A gas limit already supplied is kept as is. Throws on either failure.
 *  The result names the simulated account and chain, so the wallet refuses to send it if either changed meanwhile. */
export async function prepareWrite<P extends Params>(
  client: Client,
  account: Address | undefined,
  params: P,
): Promise<P & { gas: bigint; account: Address | undefined; chainId: number | undefined }> {
  const call = { ...params, account } as never;
  await client.simulateContract(call);
  const gas = params.gas ?? ((await client.estimateContractGas(call)) * GAS_MARGIN_NUM) / GAS_MARGIN_DEN;
  return { ...params, account, chainId: client.chain?.id, gas };
}
