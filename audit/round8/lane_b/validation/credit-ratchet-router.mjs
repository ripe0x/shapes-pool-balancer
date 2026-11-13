// Retained local Anvil fork only. Tests a keeper-funded listing fee after that listing is unlisted.
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, decodeEventLog, http, keccak256, parseEther, parseGwei, toHex } from 'viem';
const pub = createPublicClient({ transport: http('http://127.0.0.1:18547') });
const accounts = await pub.request({ method: 'eth_accounts' });
const creator = '0x46EFbAedc92067E6d60E84ED6395099723252496', player = '0x00000000000000000000000000000000c0dec0de', outsiderKeeper = '0x00000000000000000000000000000000c0dec0df';
const coordinator = '0xD7f86b4b8Cae7D942340FF628F82735b7a20893a';
const service = '0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d';
const serviceAbi = [{ type: 'function', name: 'rawFulfillRandomWords', stateMutability: 'nonpayable', inputs: [{ name: 'requestId', type: 'uint256' }, { name: 'words', type: 'uint256[]' }], outputs: [] }];
const balancer = '0xFE4bF8dfA7c64866a75F141d771eA2d73452ac17';
const pool = '0xc0CE6B85bB0bc02c1b072d291af3ad47c0c670a0';
const abi = (name) => JSON.parse(readFileSync(`audit/round8/lane_b/out/${name}.json`, 'utf8')).abi;
const bAbi = abi('PoolBalancer.sol/PoolBalancer'), pAbi = abi('External.sol/IFWAPool');
const wallet = (account) => createWalletClient({ transport: http('http://127.0.0.1:18547'), account, chain: null });
const read = (address, contractAbi, functionName, args = [], extra = {}) => pub.readContract({ address, abi: contractAbi, functionName, args, ...extra });
async function tx(w, address, contractAbi, functionName, args, options = {}) {
  const hash = await w.writeContract({ address, abi: contractAbi, functionName, args, gas: 5_000_000n,
    maxFeePerGas: options.maxFeePerGas ?? parseGwei('1.05'), maxPriorityFeePerGas: parseGwei('0.05'),
    ...(options.value === undefined ? {} : { value: options.value }) });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`local transaction failed: ${hash}`);
  return receipt;
}
async function setBase(x) { await pub.request({ method: 'anvil_setNextBlockBaseFeePerGas', params: [toHex(parseGwei(x))] }); }
function paid(receipt) {
  for (const log of receipt.logs) try {
    const e = decodeEventLog({ abi: bAbi, topics: log.topics, data: log.data });
    if (e.eventName === 'KeeperPaid') return { amount: e.args.amount, measured: e.args.gasUsed };
  } catch { /* other real event */ }
  return { amount: 0n, measured: 0n };
}
async function buyAndSettle(label) {
  await setBase('1');
  const [fee, vrf, total] = await read(pool, pAbi, 'quoteAcquisitionPrice', [1n], { gasPrice: parseGwei('1.05') });
  const version = await read(pool, pAbi, 'inventoryVersion'); // pre-read before payer sends
  const deadline = (await pub.getBlock()).timestamp + 86400n;
  const purchase = await tx(wallet(player), pool, pAbi, 'acquire', [player, fee, 0n, 10000n, version, deadline], { value: total });
  const seq = await read(pool, pAbi, 'lastIssuedSequence');
  const requestId = await read(pool, pAbi, 'requestIdAtSequence', [seq]);
  const word = BigInt(keccak256(toHex(`lane-b-real-vrf-delivery-${label}`)));
  await tx(wallet(coordinator), service, serviceAbi, 'rawFulfillRandomWords', [requestId, [word]]);
  await tx(wallet(creator), pool, pAbi, 'processAcquisitions', [5n]);
  const acq = await read(pool, pAbi, 'acquisitions', [requestId]);
  return { purchase: purchase.transactionHash, payer: player, paid: String(total), fee: String(fee), vrf: String(vrf), listingId: String(acq[3]), status: String(acq[4]) };
}
if ((await pub.getChainId()) !== 31337) throw new Error('not local fork');
const snapshot = await pub.request({ method: 'evm_snapshot', params: [] });
try {
  for (const actor of [player, outsiderKeeper]) {
    if (await pub.getBytecode({ address: actor })) throw new Error(`actor ${actor} has code`);
    await pub.request({ method: 'anvil_impersonateAccount', params: [actor] });
    await pub.request({ method: 'anvil_setBalance', params: [actor, toHex(parseEther('100'))] });
  }
  await pub.request({ method: 'anvil_impersonateAccount', params: [coordinator] });
  await pub.request({ method: 'anvil_impersonateAccount', params: [creator] });
  const first = await buyAndSettle('fee-source');
  const beforeIds = await read(balancer, bAbi, 'getActiveIds');
  await setBase('4.9');
  const fundingReceipt = await tx(wallet(outsiderKeeper), balancer, bAbi, 'performUpkeep', [], { maxFeePerGas: parseGwei('4.95') });
  const afterIds = await read(balancer, bAbi, 'getActiveIds');
  const beforeSet = new Set(beforeIds.map(String));
  const newIds = afterIds.filter((x) => !beforeSet.has(String(x)));
  if (newIds.length !== 1) throw new Error(`new listing count ${newIds.length}`);
  const feeListing = newIds[0];
  const credit = await read(balancer, bAbi, 'keeperCredit');
  if (credit === 0n) throw new Error('no unused credit to test');
  const second = await buyAndSettle('unrelated-draw');
  if (second.listingId === String(feeListing)) throw new Error('funding listing was drawn; retry word');
  await tx(wallet(creator), balancer, bAbi, 'close', []);
  await tx(wallet(creator), balancer, bAbi, 'unlistShapes', [[feeListing]]);
  const creditAfterUnlist = await read(balancer, bAbi, 'keeperCredit');
  const liquidBefore = await pub.getBalance({ address: balancer });
  await setBase('1');
  const keeperBefore = await pub.getBalance({ address: outsiderKeeper });
  const spendingReceipt = await tx(wallet(outsiderKeeper), balancer, bAbi, 'performUpkeep', []);
  const keeperAfter = await pub.getBalance({ address: outsiderKeeper });
  const firstPay = paid(fundingReceipt), secondPay = paid(spendingReceipt);
  const cost = spendingReceipt.gasUsed * spendingReceipt.effectiveGasPrice;
  if (keeperAfter - keeperBefore !== secondPay.amount - cost) throw new Error('EOA keeper wallet delta mismatch');
  console.log(JSON.stringify({ chainId: 31337, forkBlock: 26382349, creator, player, outsiderKeeper,
    callbackRoute: 'coordinator -> VRF service -> FWA pool', first, funding: { txHash: fundingReceipt.transactionHash, feeListing: String(feeListing), listingStillActiveBeforeUnlist: true, reward: String(firstPay.amount), measuredGas: String(firstPay.measured), creditAfterFunding: String(credit) },
    second, closeAndUnlist: { creditAfterUnlist: String(creditAfterUnlist), balanceBeforeReconcile: String(liquidBefore), feeListingUnlistedWithoutWinning: true },
    spend: { txHash: spendingReceipt.transactionHash, billedGas: String(spendingReceipt.gasUsed), effectiveGasPrice: String(spendingReceipt.effectiveGasPrice), reward: String(secondPay.amount), measuredGas: String(secondPay.measured), billedCost: String(cost), keeperNet: String(secondPay.amount - cost), observedKeeperWalletDelta: String(keeperAfter - keeperBefore), creditAfter: String(await read(balancer, bAbi, 'keeperCredit')) } }, null, 2));
} finally {
  await pub.request({ method: 'evm_revert', params: [snapshot] });
}
