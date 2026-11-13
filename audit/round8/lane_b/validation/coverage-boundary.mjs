// Local Anvil fork only: real FWA purchase-count boundary with code-free funded wallet; snapshots restored.
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, parseEther, parseGwei, toHex } from 'viem';
const transport = http('http://127.0.0.1:18547');
const pub = createPublicClient({ transport });
const player = '0x00000000000000000000000000000000c0dec0de';
const pool = '0xc0CE6B85bB0bc02c1b072d291af3ad47c0c670a0';
const router = '0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d';
const pAbi = JSON.parse(readFileSync('audit/round8/lane_b/out/External.sol/IFWAPool.json', 'utf8')).abi;
const read = (functionName, args = [], extra = {}) => pub.readContract({ address: pool, abi: pAbi, functionName, args, ...extra });
const wallet = createWalletClient({ transport, account: player, chain: null });
const baseGwei = process.argv[2] ?? '1';
const effectiveGwei = String(Number(baseGwei) + 0.05);
function routerCall(trace) {
  if (trace.to?.toLowerCase() === router.toLowerCase() && trace.input?.startsWith('0x688189d3'))
    return { input: trace.input, output: trace.output, error: trace.error, gasUsed: trace.gasUsed };
  for (const call of trace.calls ?? []) { const result = routerCall(call); if (result) return result; }
}
if ((await pub.getChainId()) !== 31337) throw new Error('not retained local fork');
const outer = await pub.request({ method: 'evm_snapshot', params: [] });
try {
  if (await pub.getBytecode({ address: player })) throw new Error('payer has code');
  await pub.request({ method: 'anvil_impersonateAccount', params: [player] });
  await pub.request({ method: 'anvil_setBalance', params: [player, toHex(parseEther('100'))] });
  const baseline = { sequence: String(await read('lastIssuedSequence')), unsettled: String(await read('unsettledAcquisitionCount')), routerEth: String(await pub.getBalance({ address: router })) };
  const results = [];
  for (let n = 1; n <= 5; n++) {
    const snapshot = await pub.request({ method: 'evm_snapshot', params: [] });
    try {
      await pub.request({ method: 'anvil_setNextBlockBaseFeePerGas', params: [toHex(parseGwei(baseGwei))] });
      const [fee, vrf, total] = await read('quoteAcquisitionPrice', [BigInt(n)], { gasPrice: parseGwei(effectiveGwei) });
      const version = await read('inventoryVersion');
      const deadline = (await pub.getBlock()).timestamp + 86400n;
      const hash = await wallet.writeContract({ address: pool, abi: pAbi, functionName: 'acquireBatch',
        args: [player, BigInt(n), fee, 0n, 10000n, version, deadline], value: total,
        gas: 8_000_000n, maxFeePerGas: parseGwei(effectiveGwei), maxPriorityFeePerGas: parseGwei('0.05') });
      const receipt = await pub.waitForTransactionReceipt({ hash });
      const result = { count: n, quote: { fee: String(fee), vrf: String(vrf), total: String(total) },
        txHash: hash, status: receipt.status, gasUsed: String(receipt.gasUsed), effectiveGasPrice: String(receipt.effectiveGasPrice),
        sequenceAfter: String(await read('lastIssuedSequence')), unsettledAfter: String(await read('unsettledAcquisitionCount')) };
      if (receipt.status !== 'success') {
        const trace = await pub.request({ method: 'debug_traceTransaction', params: [hash, { tracer: 'callTracer' }] });
        result.revertSelector = trace.output;
        result.routerCall = routerCall(trace);
      }
      results.push(result);
    } finally {
      await pub.request({ method: 'evm_revert', params: [snapshot] });
    }
  }
  console.log(JSON.stringify({ chainId: 31337, forkBlock: 26382349, baseGwei, effectiveGwei, pool, router, player, baseline, results }, null, 2));
} finally {
  await pub.request({ method: 'evm_revert', params: [outer] });
}
