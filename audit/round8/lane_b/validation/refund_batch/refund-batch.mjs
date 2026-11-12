// Four real FWA requests against deployable dishonest ERC721s; actual coordinator path, snapshot restored.
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, decodeEventLog, http, keccak256, parseEther, parseGwei, toHex } from 'viem';
const transport = http('http://127.0.0.1:18547');
const pub = createPublicClient({ transport });
const deployer = '0x00000000000000000000000000000000c0dec0da';
const player = '0x00000000000000000000000000000000c0dec0de';
const keeper = '0x00000000000000000000000000000000c0dec0df';
const coordinator = '0xD7f86b4b8Cae7D942340FF628F82735b7a20893a';
const service = '0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d';
const firstBalancer = '0xFE4bF8dfA7c64866a75F141d771eA2d73452ac17';
const artifact = JSON.parse(readFileSync('audit/round8/lane_b/validation/refund_batch/out/MultiHostileCreator.sol/MultiHostileCreator.json', 'utf8'));
const abi = (name) => JSON.parse(readFileSync(`audit/round8/lane_b/out/${name}.json`, 'utf8')).abi;
const bAbi = abi('PoolBalancer.sol/PoolBalancer'), pAbi = abi('External.sol/IFWAPool');
const sAbi = [{ type: 'function', name: 'rawFulfillRandomWords', stateMutability: 'nonpayable', inputs: [{ name: 'requestId', type: 'uint256' }, { name: 'words', type: 'uint256[]' }], outputs: [] }];
const refundAbi = [{ type: 'function', name: 'withdrawAcquisitionRefund', stateMutability: 'nonpayable', inputs: [], outputs: [] }];
const wallet = (account) => createWalletClient({ transport, account, chain: null });
const read = (address, a, functionName, args = [], extra = {}) => pub.readContract({ address, abi: a, functionName, args, ...extra });
async function tx(account, address, a, functionName, args = [], base = '1', value) {
  await pub.request({ method: 'anvil_setNextBlockBaseFeePerGas', params: [toHex(parseGwei(base))] });
  const price = parseGwei(String(Number(base) + 0.05));
  const hash = await wallet(account).writeContract({ address, abi: a, functionName, args, gas: 8_000_000n,
    maxFeePerGas: price, maxPriorityFeePerGas: parseGwei('0.05'), ...(value === undefined ? {} : { value }) });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    const trace = await pub.request({ method: 'debug_traceTransaction', params: [hash, { tracer: 'callTracer' }] });
    console.error(JSON.stringify({ failedFunction: functionName, hash, trace }, null, 2));
    throw new Error(`local fork transaction reverted: ${hash}`);
  }
  return receipt;
}
async function deployHostile() {
  await pub.request({ method: 'anvil_setNextBlockBaseFeePerGas', params: [toHex(parseGwei('1'))] });
  const hash = await wallet(deployer).deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [], gas: 8_000_000n,
    maxFeePerGas: parseGwei('1.05'), maxPriorityFeePerGas: parseGwei('0.05') });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`hostile ERC721 deployment failed: ${hash}`);
  return { address: receipt.contractAddress, txHash: hash };
}
function paid(receipt) {
  for (const log of receipt.logs) try {
    const e = decodeEventLog({ abi: bAbi, topics: log.topics, data: log.data });
    if (e.eventName === 'KeeperPaid') return { reward: e.args.amount, measuredGas: e.args.gasUsed, recipient: e.args.keeper };
  } catch { /* other real event */ }
  return { reward: 0n, measuredGas: 0n, recipient: '' };
}
async function purchaseSelect(pool, balancer, wantedKind, wantedStatus, label, base = '1') {
  const price = parseGwei(String(Number(base) + 0.05));
  const [fee, vrf, total] = await read(pool, pAbi, 'quoteAcquisitionPrice', [1n], { gasPrice: price });
  const version = await read(pool, pAbi, 'inventoryVersion');
  const deadline = (await pub.getBlock()).timestamp + 86400n;
  const before = await pub.getBalance({ address: player });
  const purchase = await tx(player, pool, pAbi, 'acquire', [player, fee, 0n, 10000n, version, deadline], base, total);
  const seq = await read(pool, pAbi, 'lastIssuedSequence');
  const requestId = await read(pool, pAbi, 'requestIdAtSequence', [seq]);
  for (let candidate = 1; candidate <= 100; candidate++) {
    const attempt = await pub.request({ method: 'evm_snapshot', params: [] });
    const word = BigInt(keccak256(toHex(`lane-b-refund-${label}-${requestId}-${candidate}`)));
    const callback = await tx(coordinator, service, sAbi, 'rawFulfillRandomWords', [requestId, [word]], base);
    const process = await tx(player, pool, pAbi, 'processAcquisitions', [5n], base);
    const a = await read(pool, pAbi, 'acquisitions', [requestId]);
    const item = await read(balancer, bAbi, 'items', [a[3]]);
    if (item[0] === wantedKind && a[4] === wantedStatus) return { purchase, callback, process, requestId, listingId: a[3], status: a[4], kind: item[0], candidate, fee, vrf, total, playerBefore: before };
    await pub.request({ method: 'evm_revert', params: [attempt] });
  }
  throw new Error(`wanted ${label} outcome not reached in 100 real service deliveries`);
}
const cost = (r) => r.gasUsed * r.effectiveGasPrice;
const receipt = (r) => ({ txHash: r.transactionHash, status: r.status, billedGas: String(r.gasUsed), effectiveGasPrice: String(r.effectiveGasPrice), billedCost: String(cost(r)) });
async function failedBatch(pool, balancer, n) {
  const [fee, vrf, total] = await read(pool, pAbi, 'quoteAcquisitionPrice', [BigInt(n)], { gasPrice: parseGwei('1.05') });
  const version = await read(pool, pAbi, 'inventoryVersion');
  const deadline = (await pub.getBlock()).timestamp + 86400n;
  const playerBefore = await pub.getBalance({ address: player });
  const purchase = await tx(player, pool, pAbi, 'acquireBatch', [player, BigInt(n), fee, 0n, 10000n, version, deadline], '1', total);
  const last = await read(pool, pAbi, 'lastIssuedSequence');
  const requests = [];
  for (let s = last - BigInt(n) + 1n; s <= last; ++s) requests.push(await read(pool, pAbi, 'requestIdAtSequence', [s]));
  const outcomes = [];
  for (const requestId of requests) {
    let hit = false;
    for (let candidate = 1; candidate <= 400; ++candidate) {
      const attempt = await pub.request({ method: 'evm_snapshot', params: [] });
      const word = BigInt(keccak256(toHex(`lane-b-four-fail-${requestId}-${candidate}`)));
      const callback = await tx(coordinator, service, sAbi, 'rawFulfillRandomWords', [requestId, [word]]);
      const process = await tx(player, pool, pAbi, 'processAcquisitions', [5n]);
      const a = await read(pool, pAbi, 'acquisitions', [requestId]);
      const item = await read(balancer, bAbi, 'items', [a[3]]);
      if (a[4] === 7 && item[0] === 1) {
        const listing = await read(pool, pAbi, 'listings', [a[3]]);
        if (listing[7] !== 6) throw new Error('failed curated listing not pending delivery');
        outcomes.push({ requestId: String(requestId), listingId: String(a[3]), candidate, status: String(a[4]), listingStatus: String(listing[7]), callback: receipt(callback), process: receipt(process) });
        hit = true;
        break;
      }
      await pub.request({ method: 'evm_revert', params: [attempt] });
    }
    if (!hit) throw new Error(`failed curated outcome not reached within 400 words for ${requestId}`);
  }
  return { purchase, outcomes, fee, vrf, total, playerBefore };
}
if ((await pub.getChainId()) !== 31337) throw new Error('not local Anvil fork');
const outer = await pub.request({ method: 'evm_snapshot', params: [] });
try {
  for (const actor of [deployer, player, keeper]) {
    if (await pub.getBytecode({ address: actor })) throw new Error(`external wallet has code: ${actor}`);
    await pub.request({ method: 'anvil_impersonateAccount', params: [actor] });
    await pub.request({ method: 'anvil_setBalance', params: [actor, toHex(parseEther('100'))] });
  }
  if (!(await pub.getBytecode({ address: coordinator }))) throw new Error('actual coordinator absent');
  await pub.request({ method: 'anvil_impersonateAccount', params: [coordinator] });
  const deployed = await deployHostile();
  const factory = await read(firstBalancer, bAbi, 'factory');
  const makePool = await tx(deployer, deployed.address, artifact.abi, 'makePool', [factory], '1', parseEther('1'));
  const balancer = await read(deployed.address, artifact.abi, 'balancer');
  const pool = await read(balancer, bAbi, 'pool');
  await tx(deployer, deployed.address, artifact.abi, 'listMany');
  await tx(deployer, deployed.address, artifact.abi, 'open');
  const opening = [];
  for (let i = 0; i < 20 && await read(balancer, bAbi, 'creatorWork'); ++i) opening.push(await tx(keeper, balancer, bAbi, 'performUpkeep'));
  if (await read(balancer, bAbi, 'creatorWork')) throw new Error('opening incomplete');
  const shape = await purchaseSelect(pool, balancer, 2, 2, 'shape');
  const beforeFirstUpkeep = await pub.getBalance({ address: keeper });
  const firstUpkeep = await tx(keeper, balancer, bAbi, 'performUpkeep', [], '4.9');
  const afterFirstUpkeep = await pub.getBalance({ address: keeper });
  const credit = await read(balancer, bAbi, 'keeperCredit');
  if (credit === 0n) throw new Error('restock did not leave keeper credit');
  const failed = await failedBatch(pool, balancer, 4);
  if (await read(pool, pAbi, 'ownerProceeds') !== 0n) throw new Error('failed draw unexpectedly credited owner proceeds');
  const beforeReconcile = await pub.getBalance({ address: balancer });
  const keeperBefore = await pub.getBalance({ address: keeper });
  const reconcile = await tx(keeper, balancer, bAbi, 'performUpkeep');
  const keeperAfter = await pub.getBalance({ address: keeper });
  const afterReconcile = await pub.getBalance({ address: balancer });
  const reconcilePay = paid(reconcile);
  if (keeperAfter - keeperBefore !== reconcilePay.reward - cost(reconcile)) throw new Error('keeper wallet delta mismatch');
  if (beforeReconcile - afterReconcile !== reconcilePay.reward) throw new Error('Balancer drop != keeper reward');
  if (await read(balancer, bAbi, 'reconciledSequence') !== await read(pool, pAbi, 'lastIssuedSequence')) throw new Error('failed draw not reconciled');
  if (await read(pool, pAbi, 'ownerProceeds') !== 0n) throw new Error('failed draw proceeds appeared');

  await pub.request({ method: 'evm_increaseTime', params: [7 * 86400 + 1] });
  await pub.request({ method: 'evm_mine', params: [] });
  const refunds = [];
  for (const outcome of failed.outcomes) refunds.push(await tx(player, pool, pAbi, 'refundFailedDelivery', [BigInt(outcome.listingId)]));
  const withdraw = await tx(player, pool, refundAbi, 'withdrawAcquisitionRefund');
  const playerAfterRefund = await pub.getBalance({ address: player });
  const playerLoss = failed.playerBefore - playerAfterRefund;
  const processCost = failed.outcomes.reduce((x, o) => x + BigInt(o.process.billedCost), 0n);
  const refundCost = refunds.reduce((x, r) => x + cost(r), 0n);
  const expectedPlayerLoss = 4n * failed.vrf + cost(failed.purchase) + processCost + refundCost + cost(withdraw);
  if (playerLoss !== expectedPlayerLoss) throw new Error(`refund wallet loss ${playerLoss} != ${expectedPlayerLoss}`);
  for (const outcome of failed.outcomes) {
    const listingAfterRefund = await read(pool, pAbi, 'listings', [BigInt(outcome.listingId)]);
    if (listingAfterRefund[7] !== 7) throw new Error('failed listing not refunded');
  }
  console.log(JSON.stringify({ chainId: 31337, forkBlock: 26382349, route: 'actual coordinator -> real VRF service -> real FWA pool',
    externalWallets: { deployer, player, keeper }, hostileCollection: deployed.address, balancer, pool,
    setup: { deployTx: deployed.txHash, makePool: receipt(makePool), opening: opening.map(receipt) },
    shapeFunding: { requestId: String(shape.requestId), candidate: shape.candidate, listingId: String(shape.listingId), purchase: receipt(shape.purchase), callback: receipt(shape.callback), process: receipt(shape.process), upkeep: receipt(firstUpkeep), reward: String(paid(firstUpkeep).reward), measuredGas: String(paid(firstUpkeep).measuredGas), keeperWalletDelta: String(afterFirstUpkeep - beforeFirstUpkeep), creditAfter: String(credit) },
    failedBatch: { outcomes: failed.outcomes, feePerDraw: String(failed.fee), vrfPerDraw: String(failed.vrf), total: String(failed.total), purchase: receipt(failed.purchase), ownerProceeds: '0' },
    outsiderReconciliation: { receipt: receipt(reconcile), measuredGas: String(reconcilePay.measuredGas), reward: String(reconcilePay.reward), recipient: reconcilePay.recipient, keeperWalletDelta: String(keeperAfter - keeperBefore), creditBefore: String(credit), creditAfter: String(await read(balancer, bAbi, 'keeperCredit')), balancerBefore: String(beforeReconcile), balancerAfter: String(afterReconcile) },
    refund: { refunds: refunds.map(receipt), withdraw: receipt(withdraw), playerLossIncludingGas: String(playerLoss), expectedPlayerLoss: String(expectedPlayerLoss), processCost: String(processCost), refundCost: String(refundCost) } }, null, 2));
} finally {
  await pub.request({ method: 'evm_revert', params: [outer] });
}
