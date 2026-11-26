import assert from 'node:assert/strict';
import { createPublicClient, createWalletClient, encodeFunctionData, getAddress, http, keccak256, toHex, parseAbi, parseEther, formatEther, type Abi, type Address } from 'viem';
import { foundry } from 'viem/chains';
import { balancerFactoryAbi, fwaPoolAbi, poolBalancerAbi } from '../shared/abi';
import { unpackPlan } from '../shared/planner';

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
const SERVICE = getAddress('0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d');
const COORDINATOR = getAddress('0xD7f86b4b8Cae7D942340FF628F82735b7a20893a');
const serviceAbi = parseAbi(['function coordinator() view returns(address)', 'function requestPool(uint256) view returns(address)', 'function requestStatus(uint256) view returns(uint8)', 'function rawFulfillRandomWords(uint256,uint256[])']);
const commitmentAbi = parseAbi(['function s_requestCommitments(uint256) view returns(bytes32)']);
const nftAbi = parseAbi(['function ownerOf(uint256) view returns(address)']);
const json = (v: unknown) => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x, 2);

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) {
    console.log('LOCAL_FACTORY=0x... npx tsx scripts/local-draws.ts --balancer 0x... --buyer 0x000000000000000000000000000000000001e008 --count 5 --max-spend-eth 0.1 [--execute] [--timeout-refund | --allow-simulated-randomness]');
    console.log('Preview is read-only. Draws remain pending without genuine VRF. Timeout mode mines local blocks and claims actual refunds; it awards no NFT winners and retains the real VRF fee.');
    return;
  }
  const opts = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; ++i) {
    const key = argv[i];
    assert.ok(!opts.has(key) && !flags.has(key), `duplicate ${key}`);
    if (['--execute', '--timeout-refund', '--allow-simulated-randomness'].includes(key)) flags.add(key);
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
  const simulated = flags.has('--allow-simulated-randomness');
  assert.ok(!(timeout && simulated), 'choose timeout refunds or simulated NFT delivery');
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
    assert.equal(await read<boolean>(factory, balancerFactoryAbi, 'isBalancer', [balancer]), true, 'factory must recognize this pool');
  }
  await identity();
  const pool = getAddress(await read<Address>(balancer, poolBalancerAbi, 'pool'));
  assert.ok((await pub.getCode({ address: pool }))?.length! > 2, 'FWA pool code missing');
  assert.equal(getAddress(await read<Address>(pool, poolAbi, 'owner')), balancer);
  assert.equal(await read<bigint>(pool, poolAbi, 'unsettledAcquisitionCount'), 0n, 'existing pending draws must be handled first');
  let spend = 0n;
  let gasSpent = 0n;
  async function send(address: Address, abi: Abi, functionName: string, args: readonly unknown[], value = 0n, from = buyer) {
    await identity();
    assert.ok(from === buyer ? address === pool || address === balancer
      : simulated && from === COORDINATOR && address === SERVICE && functionName === 'rawFulfillRandomWords' && value === 0n, 'unexpected write target or signer');
    const block = await pub.getBlock();
    const maxFeePerGas = (block.baseFeePerGas ?? 0n) * 2n + 1_000_000_000n;
    const simulation = await pub.simulateContract({ address, abi, functionName, args, account: from, value, maxFeePerGas, maxPriorityFeePerGas: 1_000_000_000n });
    const estimated = (await pub.estimateContractGas({ address, abi, functionName, args, account: from, value, maxFeePerGas, maxPriorityFeePerGas: 1_000_000_000n })) * (simulated ? 13n : 12n) / 10n;
    // The service catches delivery failure: a low estimate can cover storing the word but starve NFT delivery.
    const gas = from === COORDINATOR && estimated < 5_000_000n ? 5_000_000n : estimated;
    assert.ok(gasSpent + gas * maxFeePerGas <= GAS_BUDGET, '1 test ETH aggregate gas budget exceeded');
    assert.ok(await pub.getBalance({ address: from }) >= value + gas * maxFeePerGas, 'signer needs separately approved funding');
    console.log(json({ mode: execute ? 'execute' : 'preview', buyer, from, target: address, functionName, args, valueWei: value, gasLimit: gas, maxFeePerGas }));
    if (!execute) return simulation.result;
    const hash = await wallet.writeContract({ ...simulation.request, account: from, gas });
    const receipt = await pub.waitForTransactionReceipt({ hash, pollingInterval: 100 });
    assert.equal(receipt.status, 'success', `transaction failed: ${hash}`);
    assert.equal(receipt.from.toLowerCase(), from.toLowerCase());
    gasSpent += receipt.gasUsed * receipt.effectiveGasPrice;
    console.log(json({ hash, block: receipt.blockNumber, gasWei: receipt.gasUsed * receipt.effectiveGasPrice }));
    return simulation.result;
  }
  console.log(json({ rpc: RPC, factory, balancer, pool, buyer, count, maxForwardSpendWei: maxSpend, gasCapWei: GAS_BUDGET, timeoutRefund: timeout }));
  console.log(simulated ? 'LOCAL SIMULATED RANDOMNESS: actual NFT delivery and production-keeper restocking; no authentic VRF proof claim.' : 'No fresh genuine VRF is available on this historical fork. Timeout refunds retain VRF fees and award no NFT winners.');
  let unlockedCoordinator = false;
  if (simulated) {
    assert.equal(await read<bigint>(balancer, poolBalancerAbi, 'profitAccountingVersion'), 2n, 'use this mode with the current v2 implementation');
    assert.equal(getAddress(await read<Address>(SERVICE, serviceAbi, 'coordinator')), COORDINATOR);
    const health = await (await fetch('http://127.0.0.1:8787/health')).json() as { ok?: boolean; policies?: Record<string, unknown> };
    assert.ok(health.ok, 'local production keeper must be healthy');
    assert.ok(Object.keys(health.policies ?? {}).some(b => b.toLowerCase() === balancer.toLowerCase()), 'keeper has not discovered this pool yet; retry after its next tick');
    if (execute) {
      const accounts = await pub.request({ method: 'eth_accounts' as never }) as Address[];
      if (!accounts.some(a => a.toLowerCase() === COORDINATOR.toLowerCase())) {
        await pub.request({ method: 'anvil_impersonateAccount' as never, params: [COORDINATOR] as never }); unlockedCoordinator = true;
      }
    }
  }
  try {
  for (let done = 0; done < count;) {
    assert.equal(Number(await read<number>(balancer, poolBalancerAbi, 'admissionStatus')), 0, 'pool does not admit purchases; inspect UI admission status');
    const n = simulated ? 1 : Math.min(5, count - done);
    const block = await pub.getBlock();
    const quoteGasPrice = (block.baseFeePerGas ?? 0n) * 2n + 1_000_000_000n;
    const [fee, vrf, total] = await read<readonly [bigint, bigint, bigint]>(pool, poolAbi, 'quoteAcquisitionPrice', [BigInt(n)], quoteGasPrice);
    assert.ok(total > 0n && total === BigInt(n) * (fee + vrf));
    assert.ok(spend + total <= maxSpend, 'forward spend cap would be exceeded; refunds do not reset this cap');
    const version = await read<bigint>(pool, poolAbi, 'inventoryVersion');
    const wall = BigInt(Math.floor(Date.now() / 1000));
    const args = [buyer, BigInt(n), fee, 0n, 10_000n, version, (block.timestamp > wall ? block.timestamp : wall) + 600n] as const;
    await send(pool, poolAbi, 'acquireBatch', args, total);
    spend += total;
    done += n;
    if (!execute) {
      console.log(json({ firstBatchQuoteETH: formatEther(total), firstBatch: n, requestedTotal: count, calldata: encodeFunctionData({ abi: poolAbi, functionName: 'acquireBatch', args }), note: 'Only the first batch can be simulated read-only; later batches need actual updated admission and prices. No sends or mining performed.' }));
      return;
    }
    assert.equal(await read<bigint>(pool, poolAbi, 'unsettledAcquisitionCount'), BigInt(n), 'actual pending count mismatch');
    if (simulated) {
      const sequence = await read<bigint>(pool, poolAbi, 'lastIssuedSequence');
      const id = await read<bigint>(pool, poolAbi, 'requestIdAtSequence', [sequence]);
      assert.equal(getAddress(await read<Address>(SERVICE, serviceAbi, 'requestPool', [id])), pool);
      assert.equal(Number(await read(SERVICE, serviceAbi, 'requestStatus', [id])), 1);
      const commitment = await read<string>(COORDINATOR, commitmentAbi, 's_requestCommitments', [id]);
      assert.notEqual(commitment, `0x${'00'.repeat(32)}`);
      await send(SERVICE, serviceAbi, 'rawFulfillRandomWords', [id, [BigInt(keccak256(toHex(id, { size: 32 })))]], 0n, COORDINATOR);
      assert.equal(await read(COORDINATOR, commitmentAbi, 's_requestCommitments', [id]), commitment, 'synthetic callback must not claim authentic proof consumption');
      let settled = false, fullyRestocked = false;
      for (let tick = 0; tick < 200; tick++) {
        if (await read<bigint>(pool, poolAbi, 'unsettledAcquisitionCount') === 0n
          && await read<bigint>(balancer, poolBalancerAbi, 'reconciledSequence') === sequence
          && await read<bigint>(pool, poolAbi, 'ownerProceeds') === 0n) {
          const target = unpackPlan(await read<bigint>(balancer, poolBalancerAbi, 'target'));
          const have = await read<readonly number[]>(balancer, poolBalancerAbi, 'getActiveShapes');
          fullyRestocked = target.every((n, i) => Number(have[i]) >= n);
          const operating = await pub.getBalance({ address: balancer }) - await read<bigint>(balancer, poolBalancerAbi, 'creatorCredit');
          if (fullyRestocked || operating < await read<bigint>(balancer, poolBalancerAbi, 'requiredReserve')) { settled = true; break; }
        }
        await identity(); await pub.request({ method: 'anvil_mine' as never, params: ['0x1'] as never });
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      assert.ok(settled, 'keeper did not settle/reconcile this draw; inspect its health before retrying');
      const acquisition = await read<readonly any[]>(pool, poolAbi, 'acquisitions', [id]);
      assert.ok([2, 3, 4].includes(Number(acquisition[4])), 'draw did not reach a settled outcome');
      if (Number(acquisition[4]) === 2) {
        const listing = await read<readonly any[]>(pool, poolAbi, 'listings', [acquisition[3]]);
        assert.equal(getAddress(await read<Address>(listing[0], nftAbi, 'ownerOf', [listing[3]])), buyer, 'actual winner must own the NFT');
        console.log(json({ completedDraws: done, nftWin: true, fullyRestocked, collection: listing[0], tokenId: listing[3], spendETH: formatEther(spend) }));
      } else console.log(json({ completedDraws: done, nftWin: false, refundStatus: acquisition[4] }));
      continue;
    }
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
  } finally {
    if (unlockedCoordinator) await pub.request({ method: 'anvil_stopImpersonatingAccount' as never, params: [COORDINATOR] as never });
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
