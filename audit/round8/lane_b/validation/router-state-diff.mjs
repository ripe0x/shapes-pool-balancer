// Compare router storage touched by a real purchase with a direct pool callback sent from router address.
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, keccak256, parseEther, parseGwei, toHex } from 'viem';
const transport = http('http://127.0.0.1:18547'), pub = createPublicClient({ transport });
const player = '0x00000000000000000000000000000000c0dec0de';
const pool = '0xc0CE6B85bB0bc02c1b072d291af3ad47c0c670a0';
const router = '0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d';
const abi = JSON.parse(readFileSync('audit/round8/lane_b/out/External.sol/IFWAPool.json', 'utf8')).abi;
const wallet = (account) => createWalletClient({ transport, account, chain: null });
const read = (functionName, args = [], extra = {}) => pub.readContract({ address: pool, abi, functionName, args, ...extra });
async function tx(account, functionName, args, value) {
  await pub.request({ method: 'anvil_setNextBlockBaseFeePerGas', params: [toHex(parseGwei('1'))] });
  const hash = await wallet(account).writeContract({ address: pool, abi, functionName, args,
    gas: 8_000_000n, maxFeePerGas: parseGwei('1.05'), maxPriorityFeePerGas: parseGwei('0.05'),
    ...(value === undefined ? {} : { value }) });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${functionName} reverted ${hash}`);
  return receipt;
}
async function routerDiff(hash) {
  const trace = await pub.request({ method: 'debug_traceTransaction', params: [hash, { tracer: 'prestateTracer', tracerConfig: { diffMode: true } }] });
  const pick = (side) => Object.entries(trace[side] ?? {}).find(([address]) => address.toLowerCase() === router.toLowerCase())?.[1] ?? null;
  return { pre: pick('pre'), post: pick('post'), traceKeys: Object.keys(trace) };
}
if ((await pub.getChainId()) !== 31337) throw new Error('not retained local fork');
const snapshot = await pub.request({ method: 'evm_snapshot', params: [] });
try {
  if (await pub.getBytecode({ address: player })) throw new Error('payer has code');
  await pub.request({ method: 'anvil_impersonateAccount', params: [player] });
  await pub.request({ method: 'anvil_setBalance', params: [player, toHex(parseEther('100'))] });
  await pub.request({ method: 'anvil_impersonateAccount', params: [router] });
  const [fee,,total] = await read('quoteAcquisitionPrice', [1n], { gasPrice: parseGwei('1.05') });
  const version = await read('inventoryVersion');
  const deadline = (await pub.getBlock()).timestamp + 86400n;
  const purchase = await tx(player, 'acquire', [player, fee, 0n, 10000n, version, deadline], total);
  const seq = await read('lastIssuedSequence');
  const requestId = await read('requestIdAtSequence', [seq]);
  const purchaseRouterDiff = await routerDiff(purchase.transactionHash);
  const callback = await tx(router, 'rawFulfillRandomWords', [requestId, [BigInt(keccak256(toHex('lane-b-real-vrf-delivery')))]]);
  const callbackRouterDiff = await routerDiff(callback.transactionHash);
  console.log(JSON.stringify({ chainId: 31337, forkBlock: 26382349, pool, router, purchaseTx: purchase.transactionHash,
    callbackTx: callback.transactionHash, purchaseRouterDiff, callbackRouterDiff }, null, 2));
} finally {
  await pub.request({ method: 'evm_revert', params: [snapshot] });
}
