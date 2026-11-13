// A real EOA wallet acts as buyer, permissionless processor/keeper, and winning Shape redeemer on local Anvil.
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, decodeEventLog, http, keccak256, parseEther, parseGwei, toHex } from 'viem';
const transport = http('http://127.0.0.1:18547');
const pub = createPublicClient({ transport });
const accounts = await pub.request({ method: 'eth_accounts' });
const actor = '0x00000000000000000000000000000000c0dec0de', coordinator = '0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d';
const balancer = '0xFE4bF8dfA7c64866a75F141d771eA2d73452ac17';
const pool = '0xc0CE6B85bB0bc02c1b072d291af3ad47c0c670a0';
const shapes = '0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0';
const abi = (name) => JSON.parse(readFileSync(`audit/round8/lane_b/out/${name}.json`, 'utf8')).abi;
const bAbi = abi('PoolBalancer.sol/PoolBalancer'), pAbi = abi('External.sol/IFWAPool'), sAbi = abi('External.sol/IShapes');
const wallet = (account) => createWalletClient({ transport, account, chain: null });
const read = (address, a, functionName, args = [], extra = {}) => pub.readContract({ address, abi: a, functionName, args, ...extra });
async function tx(account, address, a, functionName, args, options = {}) {
  await pub.request({ method: 'anvil_setNextBlockBaseFeePerGas', params: [toHex(parseGwei('1'))] });
  const hash = await wallet(account).writeContract({ address, abi: a, functionName, args, gas: 5_000_000n,
    maxFeePerGas: parseGwei('1.05'), maxPriorityFeePerGas: parseGwei('0.05'),
    ...(options.value === undefined ? {} : { value: options.value }) });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`local transaction reverted: ${hash}`);
  return receipt;
}
if ((await pub.getChainId()) !== 31337) throw new Error('not local fork');
const snapshot = await pub.request({ method: 'evm_snapshot', params: [] });
try {
  if (await pub.getBytecode({ address: actor })) throw new Error('actor has code');
  await pub.request({ method: 'anvil_impersonateAccount', params: [actor] });
  await pub.request({ method: 'anvil_setBalance', params: [actor, toHex(parseEther('100'))] });
  await pub.request({ method: 'anvil_impersonateAccount', params: [coordinator] });
  const start = await pub.getBalance({ address: actor });
  const [fee, vrf, total] = await read(pool, pAbi, 'quoteAcquisitionPrice', [1n], { gasPrice: parseGwei('1.05') });
  const version = await read(pool, pAbi, 'inventoryVersion');
  const deadline = (await pub.getBlock()).timestamp + 86400n;
  const buy = await tx(actor, pool, pAbi, 'acquire', [actor, fee, 0n, 10000n, version, deadline], { value: total });
  const afterBuy = await pub.request({ method: 'eth_getBalance', params: [actor, 'latest'] });
  const seq = await read(pool, pAbi, 'lastIssuedSequence');
  const requestId = await read(pool, pAbi, 'requestIdAtSequence', [seq]);
  const word = BigInt(keccak256(toHex('lane-b-real-vrf-delivery')));
  await tx(coordinator, pool, pAbi, 'rawFulfillRandomWords', [requestId, [word]]);
  const process = await tx(actor, pool, pAbi, 'processAcquisitions', [5n]);
  const afterProcess = await pub.request({ method: 'eth_getBalance', params: [actor, 'latest'] });
  const acq = await read(pool, pAbi, 'acquisitions', [requestId]);
  const item = await read(balancer, bAbi, 'items', [acq[3]]);
  if (acq[4] !== 2 || item[0] !== 2 || item[1] !== 0) throw new Error(`unexpected draw ${acq[4]}/${item[0]}/${item[1]}`);
  const listing = await read(pool, pAbi, 'listings', [acq[3]]);
  const wonTokenId = listing[3];
  if ((await read(shapes, sAbi, 'ownerOf', [wonTokenId])).toLowerCase() !== actor.toLowerCase()) throw new Error('actor did not receive Shape');
  const backing = await read(shapes, sAbi, 'backingOf', [wonTokenId]);
  const upkeep = await tx(actor, balancer, bAbi, 'performUpkeep', []);
  let reward = 0n, measured = 0n, keeperRecipient = '';
  for (const log of upkeep.logs) try {
    const e = decodeEventLog({ abi: bAbi, topics: log.topics, data: log.data });
    if (e.eventName === 'KeeperPaid') { reward = e.args.amount; measured = e.args.gasUsed; keeperRecipient = e.args.keeper; }
  } catch { /* other event */ }
  const afterUpkeep = await pub.request({ method: 'eth_getBalance', params: [actor, 'latest'] });
  const redeem = await tx(actor, shapes, sAbi, 'redeemBatch', [[wonTokenId]]);
  const afterRedeem = await pub.request({ method: 'eth_getBalance', params: [actor, 'latest'] });
  const end = await pub.getBalance({ address: actor });
  const receipts = [buy, process, upkeep, redeem].map((r) => ({ txHash: r.transactionHash, from: r.from, gasUsed: String(r.gasUsed), effectiveGasPrice: String(r.effectiveGasPrice), gasCost: String(r.gasUsed * r.effectiveGasPrice) }));
  const gasCost = [buy, process, upkeep, redeem].reduce((a, r) => a + r.gasUsed * r.effectiveGasPrice, 0n);
  const expectedLoss = total - backing - reward + gasCost;
  if (start - end !== expectedLoss) throw new Error(`EOA wallet delta mismatch ${start - end} vs ${expectedLoss}`);
  console.log(JSON.stringify({ chainId: 31337, forkBlock: 26382349, actor, payer: actor, purchaser: actor, selectedDenom: String(item[1]),
    fee: String(fee), vrf: String(vrf), playerTotal: String(total), backingRedeemed: String(backing), keeperReward: String(reward), keeperRecipient, measuredKeeperGas: String(measured),
    receipts, actorGasCost: String(gasCost), expectedActorLoss: String(expectedLoss), observedActorLoss: String(start - end), actorStart: String(start), actorEnd: String(end),
    rawBalances: { afterBuy, afterProcess, afterUpkeep, afterRedeem },
    sourceOfRandomWord: 'coordinator-delivered test word; not under player control on mainnet' }, null, 2));
} finally {
  await pub.request({ method: 'evm_revert', params: [snapshot] });
}
