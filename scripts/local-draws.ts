import assert from 'node:assert/strict';
import { createPublicClient, createWalletClient, encodeFunctionData, getAddress, http, parseAbi, parseEther, formatEther, type Abi, type Address } from 'viem';
import { foundry } from 'viem/chains';
import { fwaPoolAbi, poolBalancerAbi } from '../shared/abi';

const RPC = 'http://127.0.0.1:8545';
const MAINNET = 'https://mainnet.gateway.tenderly.co';
const BUYER = getAddress('0x000000000000000000000000000000000001e008');
const GAS_BUDGET = parseEther('1');
const extra = parseAbi([
  'function selectionTimeoutBlocks() view returns(uint256)',
  'function acquisitionRefundCredit(address) view returns(uint256)',
  'function withdrawAcquisitionRefund() returns(uint256)',
]);
const poolAbi: Abi = [...fwaPoolAbi, ...extra];
const json = (v: unknown) => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x, 2);

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) {
    console.log('LOCAL_FACTORY=0x... npx tsx scripts/local-draws.ts --balancer 0x... --buyer 0x000000000000000000000000000000000001e008 --count 5 --max-spend-eth 0.1 [--execute] [--timeout-refund]');
    console.log('Preview is read-only. Draws remain pending without genuine VRF. Timeout mode mines local blocks and claims actual refunds; it awards no NFT winners and retains the real VRF fee.');
    return;
  }
  const opts = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; ++i) {
    const key = argv[i];
    assert.ok(!opts.has(key) && !flags.has(key), `duplicate ${key}`);
    if (['--execute', '--timeout-refund'].includes(key)) flags.add(key);
    else {
      assert.ok(['--balancer', '--buyer', '--count', '--max-spend-eth'].includes(key), `unknown argument ${key}`);
      assert.ok(argv[i + 1] && !argv[i + 1].startsWith('--'), `missing ${key}`);
      opts.set(key, argv[++i]);
    }
  }
  const balancer = getAddress(opts.get('--balancer') ?? '');
  const buyer = getAddress(opts.get('--buyer') ?? '');
  assert.equal(buyer, BUYER, 'only the separately approved synthetic local buyer is allowed');
  const factory = getAddress(process.env.LOCAL_FACTORY ?? '');
  const count = Number(opts.get('--count'));
  assert.ok(Number.isInteger(count) && count >= 1 && count <= 100, 'count must be 1..100');
  const maxSpend = parseEther(opts.get('--max-spend-eth') ?? '');
  assert.ok(maxSpend > 0n && maxSpend <= parseEther('1'), 'forward purchase spend must be capped at <=1 test ETH');
  const execute = flags.has('--execute');
  const timeout = flags.has('--timeout-refund');
  const pub = createPublicClient({ chain: foundry, transport: http(RPC) });
  const wallet = createWalletClient({ chain: foundry, transport: http(RPC), account: buyer });
  const read = async <T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = [], gasPrice?: bigint) =>
    await pub.readContract({ address, abi, functionName, args, account: buyer, ...(gasPrice === undefined ? {} : { gasPrice }) }) as T;
  async function identity() {
    assert.equal(await pub.getChainId(), 31337);
    const info = await pub.request({ method: 'anvil_nodeInfo' as never }) as any;
    assert.equal(info.forkConfig?.forkUrl, MAINNET);
    assert.equal(String(info.forkConfig?.forkBlockNumber), '26485619');
    assert.ok((await pub.getCode({ address: factory }))?.length! > 2, 'factory code missing');
    assert.ok((await pub.getCode({ address: balancer }))?.length! > 2, 'balancer code missing');
    assert.ok(!await pub.getCode({ address: buyer }) || await pub.getCode({ address: buyer }) === '0x', 'buyer must have no code or EIP-7702 delegation');
    assert.equal(getAddress(await read<Address>(balancer, poolBalancerAbi, 'factory')), factory);
  }
  await identity();
  const pool = getAddress(await read<Address>(balancer, poolBalancerAbi, 'pool'));
  assert.ok((await pub.getCode({ address: pool }))?.length! > 2, 'FWA pool code missing');
  assert.equal(getAddress(await read<Address>(pool, poolAbi, 'owner')), balancer);
  assert.equal(await read<bigint>(pool, poolAbi, 'unsettledAcquisitionCount'), 0n, 'existing pending draws must be handled first');
  let spend = 0n;
  let gasSpent = 0n;
  async function send(address: Address, abi: Abi, functionName: string, args: readonly unknown[], value = 0n) {
    await identity();
    assert.ok(address === pool || address === balancer, 'unexpected write target');
    const block = await pub.getBlock();
    const maxFeePerGas = (block.baseFeePerGas ?? 0n) * 2n + 1_000_000_000n;
    const simulation = await pub.simulateContract({ address, abi, functionName, args, account: buyer, value, maxFeePerGas, maxPriorityFeePerGas: 1_000_000_000n });
    const gas = (await pub.estimateContractGas({ address, abi, functionName, args, account: buyer, value, maxFeePerGas, maxPriorityFeePerGas: 1_000_000_000n })) * 12n / 10n;
    assert.ok(gasSpent + gas * maxFeePerGas <= GAS_BUDGET, '1 test ETH aggregate gas budget exceeded');
    assert.ok(await pub.getBalance({ address: buyer }) >= value + gas * maxFeePerGas, 'buyer needs separately approved funding');
    console.log(json({ mode: execute ? 'execute' : 'preview', buyer, target: address, functionName, args, valueWei: value, gasLimit: gas, maxFeePerGas }));
    if (!execute) return simulation.result;
    const hash = await wallet.writeContract({ ...simulation.request, gas });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success', `transaction failed: ${hash}`);
    gasSpent += receipt.gasUsed * receipt.effectiveGasPrice;
    console.log(json({ hash, block: receipt.blockNumber, gasWei: receipt.gasUsed * receipt.effectiveGasPrice }));
    return simulation.result;
  }
  console.log(json({ rpc: RPC, factory, balancer, pool, buyer, count, maxForwardSpendWei: maxSpend, gasCapWei: GAS_BUDGET, timeoutRefund: timeout }));
  console.log('No fresh genuine VRF is available on this historical fork. Pending draws receive no fabricated randomness. Timeout refunds retain VRF fees and award no NFT winners.');
  for (let done = 0; done < count;) {
    assert.equal(Number(await read<number>(balancer, poolBalancerAbi, 'admissionStatus')), 0, 'pool does not admit purchases; inspect UI admission status');
    const n = Math.min(5, count - done);
    const block = await pub.getBlock();
    const quoteGasPrice = (block.baseFeePerGas ?? 0n) * 2n + 1_000_000_000n;
    const [fee, vrf, total] = await read<readonly [bigint, bigint, bigint]>(pool, poolAbi, 'quoteAcquisitionPrice', [BigInt(n)], quoteGasPrice);
    assert.ok(total > 0n && total === BigInt(n) * (fee + vrf));
    assert.ok(spend + total <= maxSpend, 'forward spend cap would be exceeded; refunds do not reset this cap');
    const version = await read<bigint>(pool, poolAbi, 'inventoryVersion');
    const args = [buyer, BigInt(n), fee, 0n, 10_000n, version, block.timestamp + 600n] as const;
    await send(pool, poolAbi, 'acquireBatch', args, total);
    spend += total;
    done += n;
    if (!execute) {
      console.log(json({ firstBatchQuoteETH: formatEther(total), firstBatch: n, requestedTotal: count, calldata: encodeFunctionData({ abi: poolAbi, functionName: 'acquireBatch', args }), note: 'Only the first batch can be simulated read-only; later batches need actual updated admission and prices. No sends or mining performed.' }));
      return;
    }
    assert.equal(await read<bigint>(pool, poolAbi, 'unsettledAcquisitionCount'), BigInt(n), 'actual pending count mismatch');
    if (!timeout) {
      console.log(json({ submittedDraws: done, remainingRequested: count - done, note: 'Stopped with genuine pending draws. Use --timeout-refund from the start for sequential timeout batches.' }));
      return;
    }
    const wait = await read<bigint>(pool, poolAbi, 'selectionTimeoutBlocks');
    assert.ok(wait > 0n && wait <= 4096n, 'unexpected timeout; refusing unbounded mining');
    console.log(json({ localMutation: 'anvil_mine', blocks: wait + 1n }));
    await identity();
    await pub.request({ method: 'anvil_mine' as never, params: [`0x${(wait + 1n).toString(16)}`] as never });
    await send(pool, poolAbi, 'processAcquisitions', [BigInt(n)]);
    assert.equal(await read<bigint>(pool, poolAbi, 'unsettledAcquisitionCount'), 0n);
    const refund = await read<bigint>(pool, poolAbi, 'acquisitionRefundCredit', [buyer]);
    assert.ok(refund > 0n, 'actual timeout refund missing');
    const before = await pub.getBalance({ address: buyer });
    const gasBefore = gasSpent;
    await send(pool, poolAbi, 'withdrawAcquisitionRefund', []);
    assert.equal(await read<bigint>(pool, poolAbi, 'acquisitionRefundCredit', [buyer]), 0n);
    assert.equal((await pub.getBalance({ address: buyer })) + gasSpent - gasBefore - before, refund, 'buyer received exact refund excluding actual gas');
    await send(balancer, poolBalancerAbi, 'performUpkeepUnpaid', []);
    console.log(json({ completedTimeoutDraws: done, cumulativeForwardWei: spend, refundedWei: refund, gasWei: gasSpent }));
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
