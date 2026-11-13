// Local Anvil fork only. Snapshot/revert preserves the retained fork's pre-trial state.
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, decodeEventLog, http, keccak256, parseGwei, toHex } from 'viem';

const rpc = 'http://127.0.0.1:18547';
const transport = http(rpc);
const pub = createPublicClient({ transport });
const accounts = await pub.request({ method: 'eth_accounts' });
const keeper = accounts[0], player = accounts[1];
const coordinator = '0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d';
const balancer = '0xFE4bF8dfA7c64866a75F141d771eA2d73452ac17';
const pool = '0xc0CE6B85bB0bc02c1b072d291af3ad47c0c670a0';
const abi = (name) => JSON.parse(readFileSync(`audit/round8/lane_b/out/${name}.json`, 'utf8')).abi;
const bAbi = abi('PoolBalancer.sol/PoolBalancer'), pAbi = abi('External.sol/IFWAPool');
const wallet = (account) => createWalletClient({ transport, account, chain: null });
const read = (address, contractAbi, functionName, args = [], extra = {}) => pub.readContract({ address, abi: contractAbi, functionName, args, ...extra });
async function tx(w, address, contractAbi, functionName, args, options = {}) {
  const hash = await w.writeContract({ address, abi: contractAbi, functionName, args, gas: options.gas ?? 5_000_000n,
    maxFeePerGas: options.maxFeePerGas ?? parseGwei('1.05'), maxPriorityFeePerGas: options.maxPriorityFeePerGas ?? parseGwei('0.05'),
    ...(options.value === undefined ? {} : { value: options.value }) });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`local fork transaction reverted: ${hash}`);
  return r;
}
if ((await pub.getChainId()) !== 31337) throw new Error('not local fork');
const original = await pub.request({ method: 'evm_snapshot', params: [] });
try {
  await pub.request({ method: 'anvil_setNextBlockBaseFeePerGas', params: [toHex(parseGwei('1'))] });
  const [fee, vrf, total] = await read(pool, pAbi, 'quoteAcquisitionPrice', [1n], { gasPrice: parseGwei('1.05') });
  const version = await read(pool, pAbi, 'inventoryVersion'); // pre-read before player transaction
  const deadline = (await pub.getBlock()).timestamp + 86400n;
  await tx(wallet(player), pool, pAbi, 'acquire', [player, fee, 0n, 10000n, version, deadline], { value: total });
  const seq = await read(pool, pAbi, 'lastIssuedSequence');
  const requestId = await read(pool, pAbi, 'requestIdAtSequence', [seq]);
  await pub.request({ method: 'anvil_impersonateAccount', params: [coordinator] });
  const word = BigInt(keccak256(toHex('lane-b-real-vrf-delivery')));
  await tx(wallet(coordinator), pool, pAbi, 'rawFulfillRandomWords', [requestId, [word]]);
  await tx(wallet(keeper), pool, pAbi, 'processAcquisitions', [5n]);
  const acq = await read(pool, pAbi, 'acquisitions', [requestId]);
  const item = await read(balancer, bAbi, 'items', [acq[3]]);
  if (acq[4] !== 2 || item[0] !== 2 || item[1] !== 0) throw new Error(`draw status/kind/denom ${acq[4]}/${item[0]}/${item[1]}`);
  const setup = { payer: player, purchaser: player, quote: { fee: String(fee), vrf: String(vrf), total: String(total) }, sequence: String(seq), selectedDenom: String(item[1]), creditBefore: String(await read(balancer, bAbi, 'keeperCredit')) };
  const trials = [
    { name: 'base0.05_bid0.10_limit5m', base: '0.05', max: '0.10', priority: '0.05', limit: 5_000_000n },
    { name: 'base0.10_bid0.15_limit5m', base: '0.10', max: '0.15', priority: '0.05', limit: 5_000_000n },
    { name: 'base1_bid1.05_limit5m', base: '1', max: '1.05', priority: '0.05', limit: 5_000_000n },
    { name: 'base1_bid10_limit10m', base: '1', max: '10', priority: '9', limit: 10_000_000n },
    { name: 'base4.9_bid4.95_limit5m', base: '4.9', max: '4.95', priority: '0.05', limit: 5_000_000n },
    { name: 'base5.1_bid5.15_limit5m', base: '5.1', max: '5.15', priority: '0.05', limit: 5_000_000n },
    { name: 'base10_bid10.05_limit5m', base: '10', max: '10.05', priority: '0.05', limit: 5_000_000n },
  ];
  const results = [];
  for (const trial of trials) {
    const snapshot = await pub.request({ method: 'evm_snapshot', params: [] });
    try {
      await pub.request({ method: 'anvil_setNextBlockBaseFeePerGas', params: [toHex(parseGwei(trial.base))] });
      const receipt = await tx(wallet(keeper), balancer, bAbi, 'performUpkeep', [], { gas: trial.limit, maxFeePerGas: parseGwei(trial.max), maxPriorityFeePerGas: parseGwei(trial.priority) });
      let reward = 0n, measured = 0n;
      for (const log of receipt.logs) {
        try {
          const event = decodeEventLog({ abi: bAbi, data: log.data, topics: log.topics });
          if (event.eventName === 'KeeperPaid') { reward = event.args.amount; measured = event.args.gasUsed; }
        } catch { /* another real integration event */ }
      }
      const billed = receipt.gasUsed * receipt.effectiveGasPrice;
      results.push({ name: trial.name, txHash: receipt.transactionHash, blockNumber: String(receipt.blockNumber), gasLimit: String(trial.limit), gasUsed: String(receipt.gasUsed), effectiveGasPrice: String(receipt.effectiveGasPrice), measuredGas: String(measured), reward: String(reward), billedCost: String(billed), net: String(reward - billed), creditAfter: String(await read(balancer, bAbi, 'keeperCredit')), restockFeeAtCall: String(await read(balancer, bAbi, 'restockFee')) });
    } finally {
      await pub.request({ method: 'evm_revert', params: [snapshot] });
    }
  }
  console.log(JSON.stringify({ chainId: 31337, forkBlock: 26382349, balancer, pool, setup, results }, null, 2));
} finally {
  await pub.request({ method: 'evm_revert', params: [original] });
}
