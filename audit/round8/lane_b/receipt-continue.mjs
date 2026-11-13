// Receipt continuation for the lane-owned Anvil fork after a zero-gas eth_call quote caused one reverted purchase.
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, decodeEventLog, http, keccak256, parseGwei, toHex } from 'viem';

const rpc = 'http://127.0.0.1:18547';
const transport = http(rpc);
const pub = createPublicClient({ transport });
const accounts = await pub.request({ method: 'eth_accounts' });
const keeper = accounts[0];
const player = accounts[1];
const coordinator = '0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d';
const balancer = '0xFE4bF8dfA7c64866a75F141d771eA2d73452ac17';
const pool = '0xc0CE6B85bB0bc02c1b072d291af3ad47c0c670a0';
const abi = (name) => JSON.parse(readFileSync(`audit/round8/lane_b/out/${name}.json`, 'utf8')).abi;
const bAbi = abi('PoolBalancer.sol/PoolBalancer');
const pAbi = abi('External.sol/IFWAPool');
const wallet = (account) => createWalletClient({ transport, account, chain: null });
const writeOpts = { gas: 5_000_000n, maxFeePerGas: parseGwei('1.05'), maxPriorityFeePerGas: parseGwei('0.05') };
const read = (address, contractAbi, functionName, args = [], extra = {}) => pub.readContract({ address, abi: contractAbi, functionName, args, ...extra });
async function tx(w, address, contractAbi, functionName, args, value) {
  await pub.request({ method: 'anvil_setNextBlockBaseFeePerGas', params: [toHex(parseGwei('1'))] });
  const hash = await w.writeContract({ address, abi: contractAbi, functionName, args, ...writeOpts,
    ...(value === undefined ? {} : { value }) });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`local fork transaction reverted: ${hash}`);
  return r;
}

if ((await pub.getChainId()) !== 31337) throw new Error('not local fork');
if (await read(balancer, bAbi, 'creatorWork')) throw new Error('opening stockup not complete');
if ((await read(pool, pAbi, 'lastIssuedSequence')) !== 0n) throw new Error('pool already has an issued draw');
const [fee, vrf, total] = await read(pool, pAbi, 'quoteAcquisitionPrice', [1n], { gasPrice: parseGwei('1.05') });
const inventoryVersion = await read(pool, pAbi, 'inventoryVersion');
const deadline = (await pub.getBlock()).timestamp + 86400n;
await tx(wallet(player), pool, pAbi, 'acquire', [player, fee, 0n, 10000n, inventoryVersion, deadline], total);
const requestId = await read(pool, pAbi, 'requestIdAtSequence', [1n]);
await pub.request({ method: 'anvil_impersonateAccount', params: [coordinator] });
const word = BigInt(keccak256(toHex('lane-b-real-vrf-delivery')));
await tx(wallet(coordinator), pool, pAbi, 'rawFulfillRandomWords', [requestId, [word]]);
await tx(wallet(keeper), pool, pAbi, 'processAcquisitions', [5n]);
const acq = await read(pool, pAbi, 'acquisitions', [requestId]);
const item = await read(balancer, bAbi, 'items', [acq[3]]);
if (acq[4] !== 2 || item[0] !== 2 || item[1] !== 0) throw new Error(`draw status/kind/denom ${acq[4]}/${item[0]}/${item[1]}`);
const feeCreditBefore = await read(balancer, bAbi, 'keeperCredit');
const restockFee = await read(balancer, bAbi, 'restockFee');
const receipt = await tx(wallet(keeper), balancer, bAbi, 'performUpkeep', []);
let reward = 0n;
let measured = 0n;
for (const log of receipt.logs) {
  try {
    const event = decodeEventLog({ abi: bAbi, data: log.data, topics: log.topics });
    if (event.eventName === 'KeeperPaid') {
      reward = event.args.amount;
      measured = event.args.gasUsed;
    }
  } catch { /* other integration event */ }
}
const cost = receipt.gasUsed * receipt.effectiveGasPrice;
console.log(JSON.stringify({
  chainId: await pub.getChainId(), forkBlock: 26382349, balancer, pool,
  playerQuote: { fee: String(fee), vrf: String(vrf), total: String(total) },
  drawn: { listingId: String(acq[3]), status: String(acq[4]), kind: String(item[0]), denom: String(item[1]) },
  keeper: {
    txHash: receipt.transactionHash, blockNumber: String(receipt.blockNumber),
    gasLimit: String(writeOpts.gas), gasUsedBilled: String(receipt.gasUsed),
    effectiveGasPrice: String(receipt.effectiveGasPrice), measuredGas: String(measured),
    reward: String(reward), billedCost: String(cost), net: String(reward - cost),
    feeCreditBefore: String(feeCreditBefore), restockFee: String(restockFee),
    feeCreditAfter: String(await read(balancer, bAbi, 'keeperCredit')),
  },
}, null, 2));
