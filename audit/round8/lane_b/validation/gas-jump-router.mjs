// Fresh official factory clone on retained Anvil fork: list Shape at 0.05 gwei, draw/restock at 4.9 gwei.
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, decodeEventLog, http, keccak256, parseEther, parseGwei, toHex } from 'viem';
const transport = http('http://127.0.0.1:18547');
const pub = createPublicClient({ transport });
const firstBalancer = '0xFE4bF8dfA7c64866a75F141d771eA2d73452ac17';
const bayc = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D';
const router = '0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d';
const coordinator = '0xD7f86b4b8Cae7D942340FF628F82735b7a20893a';
const serviceAbi = [{ type: 'function', name: 'rawFulfillRandomWords', stateMutability: 'nonpayable', inputs: [{ name: 'requestId', type: 'uint256' }, { name: 'words', type: 'uint256[]' }], outputs: [] }];
const player = '0x00000000000000000000000000000000c0dec0de';
const keeper = '0x00000000000000000000000000000000c0dec0df';
const abi = (name) => JSON.parse(readFileSync(`audit/round8/lane_b/out/${name}.json`, 'utf8')).abi;
const bAbi = abi('PoolBalancer.sol/PoolBalancer'), fAbi = abi('BalancerFactory.sol/BalancerFactory'), pAbi = abi('External.sol/IFWAPool'), nftAbi = abi('External.sol/IERC721Min');
const wallet = (account) => createWalletClient({ transport, account, chain: null });
const read = (address, a, functionName, args = [], extra = {}) => pub.readContract({ address, abi: a, functionName, args, ...extra });
async function tx(account, address, a, functionName, args, base, value) {
  await pub.request({ method: 'anvil_setNextBlockBaseFeePerGas', params: [toHex(parseGwei(base))] });
  const gasPrice = parseGwei(String(Number(base) + 0.05));
  const hash = await wallet(account).writeContract({ address, abi: a, functionName, args, gas: 8_000_000n,
    maxFeePerGas: gasPrice, maxPriorityFeePerGas: parseGwei('0.05'), ...(value === undefined ? {} : { value }) });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${functionName} reverted ${hash}`);
  return receipt;
}
if ((await pub.getChainId()) !== 31337) throw new Error('not retained local fork');
const snapshot = await pub.request({ method: 'evm_snapshot', params: [] });
try {
  const creator = await read(bayc, nftAbi, 'ownerOf', [2n]);
  if (await pub.getBytecode({ address: creator })) throw new Error('BAYC #2 owner has code');
  for (const actor of [creator, player, keeper]) {
    if (actor !== creator && await pub.getBytecode({ address: actor })) throw new Error(`actor has code: ${actor}`);
    await pub.request({ method: 'anvil_impersonateAccount', params: [actor] });
    await pub.request({ method: 'anvil_setBalance', params: [actor, toHex(parseEther('100'))] });
  }
  await pub.request({ method: 'anvil_impersonateAccount', params: [coordinator] });
  const factory = await read(firstBalancer, bAbi, 'factory');
  const salt = toHex(532n, { size: 32 });
  const balancer = await read(factory, fAbi, 'predictBalancer', [creator, salt]);
  await tx(creator, factory, fAbi, 'createBalancer', [salt], '0.05', parseEther('1'));
  const pool = await read(balancer, bAbi, 'pool');
  await tx(creator, balancer, bAbi, 'configure', [1500, 1n], '0.05');
  await tx(creator, bayc, nftAbi, 'approve', [balancer, 2n], '0.05');
  await tx(creator, balancer, bAbi, 'listCurated', [bayc, 2n, parseEther('0.3')], '0.05');
  await tx(creator, balancer, bAbi, 'open', [], '0.05');
  const oldRestockFee = await read(balancer, bAbi, 'restockFee');
  const opening = await tx(keeper, balancer, bAbi, 'performUpkeep', [], '0.05');
  if (await read(balancer, bAbi, 'creatorWork')) throw new Error('opening incomplete');
  const idsBefore = await read(balancer, bAbi, 'getActiveIds');
  let oldPrice = 0n;
  for (const id of idsBefore) {
    const item = await read(balancer, bAbi, 'items', [id]);
    if (item[0] === 2) oldPrice = item[4];
  }
  if (oldPrice === 0n) throw new Error('old Shape missing');
  const [fee, vrf, total] = await read(pool, pAbi, 'quoteAcquisitionPrice', [1n], { gasPrice: parseGwei('4.95') });
  const version = await read(pool, pAbi, 'inventoryVersion');
  const deadline = (await pub.getBlock()).timestamp + 86400n;
  const buy = await tx(player, pool, pAbi, 'acquire', [player, fee, 0n, 10000n, version, deadline], '4.9', total);
  const seq = await read(pool, pAbi, 'lastIssuedSequence');
  const requestId = await read(pool, pAbi, 'requestIdAtSequence', [seq]);
  const word = BigInt(keccak256(toHex('lane-b-real-vrf-delivery')));
  await tx(coordinator, router, serviceAbi, 'rawFulfillRandomWords', [requestId, [word]], '4.9');
  await tx(keeper, pool, pAbi, 'processAcquisitions', [5n], '4.9');
  const a = await read(pool, pAbi, 'acquisitions', [requestId]);
  const drawn = await read(balancer, bAbi, 'items', [a[3]]);
  if (a[4] !== 2 || drawn[0] !== 2 || drawn[1] !== 0) throw new Error(`did not draw old Shape: ${a[4]}/${drawn[0]}/${drawn[1]}`);
  const creditBefore = await read(balancer, bAbi, 'keeperCredit');
  const keeperBefore = await pub.getBalance({ address: keeper });
  const newRestockFee = await read(balancer, bAbi, 'restockFee');
  const upkeep = await tx(keeper, balancer, bAbi, 'performUpkeep', [], '4.9');
  const keeperAfter = await pub.getBalance({ address: keeper });
  let reward = 0n, measured = 0n;
  for (const log of upkeep.logs) try {
    const e = decodeEventLog({ abi: bAbi, data: log.data, topics: log.topics });
    if (e.eventName === 'KeeperPaid') { reward = e.args.amount; measured = e.args.gasUsed; }
  } catch { /* other event */ }
  const billedCost = upkeep.gasUsed * upkeep.effectiveGasPrice;
  if (keeperAfter - keeperBefore !== reward - billedCost) throw new Error('keeper wallet delta mismatch');
  const idsAfter = await read(balancer, bAbi, 'getActiveIds');
  const beforeSet = new Set(idsBefore.map(String));
  const newIds = idsAfter.filter((x) => !beforeSet.has(String(x)));
  if (newIds.length !== 1) throw new Error(`new listing count ${newIds.length}`);
  const newItem = await read(balancer, bAbi, 'items', [newIds[0]]);
  console.log(JSON.stringify({ chainId: 31337, forkBlock: 26382349, callbackRoute: 'coordinator -> VRF service -> FWA pool', creator, player, keeper, factory, balancer, pool,
    opening: { txHash: opening.transactionHash, oldRestockFee: String(oldRestockFee), oldListedPrice: String(oldPrice), keeperCredit: String(creditBefore) },
    draw: { txHash: buy.transactionHash, quoteFee: String(fee), vrf: String(vrf), total: String(total), listingId: String(a[3]), status: String(a[4]) },
    replacement: { txHash: upkeep.transactionHash, newRestockFee: String(newRestockFee), newListedPrice: String(newItem[4]), creditBefore: String(creditBefore), creditAfter: String(await read(balancer, bAbi, 'keeperCredit')), measuredGas: String(measured), billedGas: String(upkeep.gasUsed), effectiveGasPrice: String(upkeep.effectiveGasPrice), reward: String(reward), billedCost: String(billedCost), keeperWalletDelta: String(keeperAfter - keeperBefore) } }, null, 2));
} finally {
  await pub.request({ method: 'evm_revert', params: [snapshot] });
}
