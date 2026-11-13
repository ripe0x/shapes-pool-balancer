// Local fork only. Old creator exits, actual two-step creator transfer, and new creator capital pays old credit.
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, decodeEventLog, http, keccak256, parseEther, parseGwei, toHex } from 'viem';
const transport = http('http://127.0.0.1:18547');
const pub = createPublicClient({ transport });
const deployer = '0x00000000000000000000000000000000c0dec0da';
const player = '0x00000000000000000000000000000000c0dec0de';
const keeper = '0x00000000000000000000000000000000c0dec0df';
const newCreator = '0x00000000000000000000000000000000c0dec0dd';
const coordinator = '0xD7f86b4b8Cae7D942340FF628F82735b7a20893a';
const service = '0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d';
const firstBalancer = '0xFE4bF8dfA7c64866a75F141d771eA2d73452ac17';
const artifact = JSON.parse(readFileSync('audit/round8/lane_b/validation/new_creator/out/HostileCreator.sol/HostileCreator.json', 'utf8'));
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
if ((await pub.getChainId()) !== 31337) throw new Error('not local Anvil fork');
const outer = await pub.request({ method: 'evm_snapshot', params: [] });
try {
  for (const actor of [deployer, player, keeper, newCreator]) {
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
  await tx(deployer, deployed.address, artifact.abi, 'list');
  await tx(deployer, deployed.address, artifact.abi, 'open');
  const opening = await tx(keeper, balancer, bAbi, 'performUpkeep');
  if (await read(balancer, bAbi, 'creatorWork')) throw new Error('opening incomplete');
  const shape = await purchaseSelect(pool, balancer, 2, 2, 'shape');
  const beforeFirstUpkeep = await pub.getBalance({ address: keeper });
  const firstUpkeep = await tx(keeper, balancer, bAbi, 'performUpkeep', [], '4.9');
  const afterFirstUpkeep = await pub.getBalance({ address: keeper });
  const credit = await read(balancer, bAbi, 'keeperCredit');
  if (credit === 0n) throw new Error('restock did not leave keeper credit');
  const active = await read(balancer, bAbi, 'getActiveIds');
  const shapeIds = [];
  for (const id of active) {
    const item = await read(balancer, bAbi, 'items', [id]);
    if (item[0] === 2) shapeIds.push(id);
  }
  if (shapeIds.length !== 1) throw new Error(`expected one replacement Shape, found ${shapeIds.length}`);
  const failed = await purchaseSelect(pool, balancer, 1, 7, 'failed-ghost');
  const listing = await read(pool, pAbi, 'listings', [failed.listingId]);
  if (listing[7] !== 6) throw new Error(`failed listing status ${listing[7]} != 6`);
  if (await read(pool, pAbi, 'ownerProceeds') !== 0n) throw new Error('failed draw unexpectedly credited owner proceeds');

  await tx(deployer, deployed.address, artifact.abi, 'close');
  await tx(deployer, deployed.address, artifact.abi, 'unlist', [shapeIds]);
  const beforeCreatorClaim = await pub.getBalance({ address: balancer });
  const creatorClaim = await tx(deployer, deployed.address, artifact.abi, 'claimAll');
  const afterClaim = await pub.getBalance({ address: balancer });
  if (afterClaim !== 0n) throw new Error(`creator claim left ${afterClaim} wei in Balancer`);
  const creditAfterUnlist = await read(balancer, bAbi, 'keeperCredit');
  if (creditAfterUnlist !== credit) throw new Error('unlisting changed keeper credit');
  const handoff = await tx(deployer, deployed.address, artifact.abi, 'handoff', [newCreator]);
  if ((await read(balancer, bAbi, 'pendingCreator')).toLowerCase() !== newCreator.toLowerCase()) throw new Error('two-step transfer was not pending');
  const newCreatorBeforeAccept = await pub.getBalance({ address: newCreator });
  const accept = await tx(newCreator, balancer, bAbi, 'acceptCreator');
  if ((await read(balancer, bAbi, 'creator')).toLowerCase() !== newCreator.toLowerCase()) throw new Error('new creator did not accept');
  if (await read(balancer, bAbi, 'pendingCreator') !== '0x0000000000000000000000000000000000000000') throw new Error('pending creator not cleared');
  const newCreatorBeforeDeposit = await pub.getBalance({ address: newCreator });
  const donation = parseEther('0.001');
  const donate = await tx(newCreator, balancer, bAbi, 'depositETH', [], '1', donation);
  const beforeReconcile = await pub.getBalance({ address: balancer });
  const keeperBefore = await pub.getBalance({ address: keeper });
  const reconcile = await tx(keeper, balancer, bAbi, 'performUpkeep');
  const keeperAfter = await pub.getBalance({ address: keeper });
  const afterReconcile = await pub.getBalance({ address: balancer });
  const reconcilePay = paid(reconcile);
  if (keeperAfter - keeperBefore !== reconcilePay.reward - cost(reconcile)) throw new Error('keeper wallet delta mismatch');
  if (beforeReconcile - afterReconcile !== reconcilePay.reward) throw new Error('new creator balance drop != keeper reward');
  if (await read(balancer, bAbi, 'reconciledSequence') !== await read(pool, pAbi, 'lastIssuedSequence')) throw new Error('failed draw not reconciled');
  if (await read(pool, pAbi, 'ownerProceeds') !== 0n) throw new Error('failed draw proceeds appeared');
  const claimRemainder = await tx(newCreator, balancer, bAbi, 'claimSurplus', [afterReconcile, newCreator]);
  const newCreatorAfterClaim = await pub.getBalance({ address: newCreator });
  if (await pub.getBalance({ address: balancer }) !== 0n) throw new Error('new creator claim left ETH');
  const newCreatorPrincipalLoss = donation - afterReconcile;
  if (newCreatorPrincipalLoss !== reconcilePay.reward) throw new Error('principal loss did not equal old credit pay');
  const newCreatorRoundTripGas = cost(donate) + cost(claimRemainder);
  if (newCreatorBeforeDeposit - newCreatorAfterClaim !== newCreatorPrincipalLoss + newCreatorRoundTripGas) throw new Error('new creator wallet roundtrip mismatch');
  const newCreatorRoleGas = cost(accept);
  if (newCreatorBeforeAccept - newCreatorAfterClaim !== newCreatorPrincipalLoss + newCreatorRoundTripGas + newCreatorRoleGas) throw new Error('new creator all-in wallet mismatch');

  await pub.request({ method: 'evm_increaseTime', params: [7 * 86400 + 1] });
  await pub.request({ method: 'evm_mine', params: [] });
  const refund = await tx(player, pool, pAbi, 'refundFailedDelivery', [failed.listingId]);
  const withdraw = await tx(player, pool, refundAbi, 'withdrawAcquisitionRefund');
  const playerAfterRefund = await pub.getBalance({ address: player });
  const playerLoss = failed.playerBefore - playerAfterRefund;
  const expectedPlayerLoss = failed.vrf + cost(failed.purchase) + cost(failed.process) + cost(refund) + cost(withdraw);
  if (playerLoss !== expectedPlayerLoss) throw new Error(`refund wallet loss ${playerLoss} != ${expectedPlayerLoss}`);
  const listingAfterRefund = await read(pool, pAbi, 'listings', [failed.listingId]);
  if (listingAfterRefund[7] !== 7) throw new Error('failed listing not refunded');
  console.log(JSON.stringify({ chainId: 31337, forkBlock: 26382349, route: 'actual coordinator -> real VRF service -> real FWA pool',
    externalWallets: { deployer, player, keeper, newCreator }, hostileCollection: deployed.address, balancer, pool,
    setup: { deployTx: deployed.txHash, makePool: receipt(makePool), opening: receipt(opening) },
    shapeFunding: { requestId: String(shape.requestId), candidate: shape.candidate, listingId: String(shape.listingId), purchase: receipt(shape.purchase), callback: receipt(shape.callback), process: receipt(shape.process), upkeep: receipt(firstUpkeep), reward: String(paid(firstUpkeep).reward), measuredGas: String(paid(firstUpkeep).measuredGas), keeperWalletDelta: String(afterFirstUpkeep - beforeFirstUpkeep), creditAfter: String(credit) },
    failedDraw: { requestId: String(failed.requestId), candidate: failed.candidate, listingId: String(failed.listingId), acquisitionStatus: String(failed.status), listingStatusBeforeRefund: String(listing[7]), fee: String(failed.fee), vrf: String(failed.vrf), total: String(failed.total), purchase: receipt(failed.purchase), callback: receipt(failed.callback), process: receipt(failed.process), ownerProceeds: '0' },
    unwindAndNewCapital: { creatorClaim: receipt(creatorClaim), oldCreatorClaimed: String(beforeCreatorClaim), balancerAfterOldClaim: String(afterClaim), creditAfterUnlist: String(creditAfterUnlist), handoff: receipt(handoff), accept: receipt(accept), creatorAfterAccept: await read(balancer, bAbi, 'creator'), newCreatorDeposit: receipt(donate), depositedWei: String(donation), balancerBeforeReconcile: String(beforeReconcile), balancerAfterReconcile: String(afterReconcile), newCreatorClaimRemainder: receipt(claimRemainder), recoveredWei: String(afterReconcile), newCreatorPrincipalLoss: String(newCreatorPrincipalLoss), newCreatorRoundTripGas: String(newCreatorRoundTripGas), newCreatorRoundTripWalletLoss: String(newCreatorBeforeDeposit - newCreatorAfterClaim), newCreatorRoleGas: String(newCreatorRoleGas), newCreatorAllInWalletLoss: String(newCreatorBeforeAccept - newCreatorAfterClaim), balancerAfterNewCreatorClaim: String(await pub.getBalance({ address: balancer })) },
    outsiderReconciliation: { receipt: receipt(reconcile), measuredGas: String(reconcilePay.measuredGas), reward: String(reconcilePay.reward), recipient: reconcilePay.recipient, keeperWalletDelta: String(keeperAfter - keeperBefore), creditAfter: String(await read(balancer, bAbi, 'keeperCredit')) },
    refund: { refund: receipt(refund), withdraw: receipt(withdraw), listingStatusAfterRefund: String(listingAfterRefund[7]), playerLossIncludingGas: String(playerLoss), expectedPlayerLoss: String(expectedPlayerLoss) } }, null, 2));
} finally {
  await pub.request({ method: 'evm_revert', params: [outer] });
}
