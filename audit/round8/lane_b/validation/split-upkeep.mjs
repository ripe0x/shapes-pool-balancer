// Snapshot-branch comparison on retained local fork. Actual coordinator delivers through real service.
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, decodeEventLog, http, keccak256, parseEther, parseGwei, toHex } from 'viem';
const pub = createPublicClient({ transport: http('http://127.0.0.1:18547') });
const player = '0x00000000000000000000000000000000c0dec0de';
const keeper = '0x00000000000000000000000000000000c0dec0df';
const coordinator = '0xD7f86b4b8Cae7D942340FF628F82735b7a20893a';
const service = '0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d';
const balancer = '0xFE4bF8dfA7c64866a75F141d771eA2d73452ac17';
const pool = '0xc0CE6B85bB0bc02c1b072d291af3ad47c0c670a0';
const abi = (name) => JSON.parse(readFileSync(`audit/round8/lane_b/out/${name}.json`, 'utf8')).abi;
const bAbi = abi('PoolBalancer.sol/PoolBalancer'), pAbi = abi('External.sol/IFWAPool');
const sAbi = [{ type: 'function', name: 'rawFulfillRandomWords', stateMutability: 'nonpayable', inputs: [{ name: 'requestId', type: 'uint256' }, { name: 'words', type: 'uint256[]' }], outputs: [] }];
const read = (address, a, functionName, args = [], extra = {}) => pub.readContract({ address, abi: a, functionName, args, ...extra });
const wallet = (account) => createWalletClient({ transport: http('http://127.0.0.1:18547'), account, chain: null });
async function tx(account, address, a, functionName, args, value) {
  await pub.request({ method: 'anvil_setNextBlockBaseFeePerGas', params: [toHex(parseGwei('1'))] });
  const hash = await wallet(account).writeContract({ address, abi: a, functionName, args, gas: 8_000_000n,
    maxFeePerGas: parseGwei('1.05'), maxPriorityFeePerGas: parseGwei('0.05'), ...(value === undefined ? {} : { value }) });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${functionName} reverted ${hash}`);
  return receipt;
}
function keeperEvent(receipt) {
  for (const log of receipt.logs) try {
    const e = decodeEventLog({ abi: bAbi, topics: log.topics, data: log.data });
    if (e.eventName === 'KeeperPaid') return { reward: e.args.amount, measuredGas: e.args.gasUsed };
  } catch { /* other real event */ }
  return { reward: 0n, measuredGas: 0n };
}
async function purchaseAndDeliver(count, seed) {
  const [fee, vrf, total] = await read(pool, pAbi, 'quoteAcquisitionPrice', [BigInt(count)], { gasPrice: parseGwei('1.05') });
  const version = await read(pool, pAbi, 'inventoryVersion');
  const deadline = (await pub.getBlock()).timestamp + 86400n;
  const before = await pub.getBalance({ address: player });
  const args = count === 1 ? [player, fee, 0n, 10000n, version, deadline] : [player, BigInt(count), fee, 0n, 10000n, version, deadline];
  const receipt = await tx(player, pool, pAbi, count === 1 ? 'acquire' : 'acquireBatch', args, total);
  const after = await pub.getBalance({ address: player });
  const last = await read(pool, pAbi, 'lastIssuedSequence');
  const ids = [];
  for (let seq = last - BigInt(count) + 1n; seq <= last; seq++) ids.push(await read(pool, pAbi, 'requestIdAtSequence', [seq]));
  const selected = [];
  for (let i = 0; i < ids.length; i++) {
    let hit = false;
    for (let candidate = 1; candidate <= 100; candidate++) {
      const attempt = await pub.request({ method: 'evm_snapshot', params: [] });
      const word = BigInt(keccak256(toHex(`lane-b-split-cheap-${ids[i]}-${candidate}`)));
      await tx(coordinator, service, sAbi, 'rawFulfillRandomWords', [ids[i], [word]]);
      await tx(player, pool, pAbi, 'processAcquisitions', [5n]);
      const a = await read(pool, pAbi, 'acquisitions', [ids[i]]);
      if (a[4] !== 2) throw new Error(`draw not delivered: ${ids[i]}`);
      const item = await read(balancer, bAbi, 'items', [a[3]]);
      if (item[0] === 2 && item[1] === 0) {
        selected.push({ listingId: String(a[3]), kind: String(item[0]), denom: String(item[1]), candidate });
        hit = true;
        break;
      }
      await pub.request({ method: 'evm_revert', params: [attempt] });
    }
    if (!hit) throw new Error(`cheap Shape not selected within 100 candidate words for ${ids[i]}`);
  }
  return { purchaseTx: receipt.transactionHash, total: String(total), fee: String(fee), vrf: String(vrf), payerDeltaIncludingPurchaseGas: String(before - after), selected };
}
async function upkeep() {
  const before = await pub.getBalance({ address: keeper });
  const receipt = await tx(keeper, balancer, bAbi, 'performUpkeep', []);
  const after = await pub.getBalance({ address: keeper });
  const { reward, measuredGas } = keeperEvent(receipt);
  const billedCost = receipt.gasUsed * receipt.effectiveGasPrice;
  if (after - before !== reward - billedCost) throw new Error('keeper wallet mismatch');
  return { txHash: receipt.transactionHash, billedGas: String(receipt.gasUsed), measuredGas: String(measuredGas), effectiveGasPrice: String(receipt.effectiveGasPrice), reward: String(reward), billedCost: String(billedCost), walletGain: String(after - before), creditAfter: String(await read(balancer, bAbi, 'keeperCredit')) };
}
if ((await pub.getChainId()) !== 31337) throw new Error('not local fork');
const outer = await pub.request({ method: 'evm_snapshot', params: [] });
try {
  for (const actor of [player, keeper]) {
    if (await pub.getBytecode({ address: actor })) throw new Error(`actor has code: ${actor}`);
    await pub.request({ method: 'anvil_impersonateAccount', params: [actor] });
    await pub.request({ method: 'anvil_setBalance', params: [actor, toHex(parseEther('100'))] });
  }
  await pub.request({ method: 'anvil_impersonateAccount', params: [coordinator] });
  const starting = { credit: String(await read(balancer, bAbi, 'keeperCredit')), sequence: String(await read(pool, pAbi, 'lastIssuedSequence')), active: String(await read(pool, pAbi, 'activeListingCount')) };
  const branch = await pub.request({ method: 'evm_snapshot', params: [] });
  const batchPurchase = await purchaseAndDeliver(4, 'same');
  const batchUpkeep = await upkeep();
  const batch = { purchase: batchPurchase, upkeep: batchUpkeep, reconciled: String(await read(balancer, bAbi, 'reconciledSequence')) };
  await pub.request({ method: 'evm_revert', params: [branch] });
  const sequential = [];
  for (let i = 0; i < 4; i++) {
    const purchase = await purchaseAndDeliver(1, `same-${i}`);
    const paid = await upkeep();
    sequential.push({ purchase, upkeep: paid });
  }
  const sum = (key) => sequential.reduce((a, x) => a + BigInt(x.upkeep[key]), 0n);
  console.log(JSON.stringify({ chainId: 31337, forkBlock: 26382349, route: 'coordinator -> service -> FWA pool', player, keeper, balancer, pool,
    starting, batch, sequential, totals: { reward: String(sum('reward')), billedCost: String(sum('billedCost')), walletGain: String(sum('walletGain')), billedGas: String(sum('billedGas')), measuredGas: String(sum('measuredGas')), finalCredit: String(await read(balancer, bAbi, 'keeperCredit')), reconciled: String(await read(balancer, bAbi, 'reconciledSequence')) } }, null, 2));
} finally {
  await pub.request({ method: 'evm_revert', params: [outer] });
}
