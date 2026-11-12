// Four real FWA draws on retained local fork, then one code-free EOA keeper call; snapshot-restored.
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, decodeEventLog, http, keccak256, parseEther, parseGwei, toHex } from 'viem';
const transport = http('http://127.0.0.1:18547');
const pub = createPublicClient({ transport });
const player = '0x00000000000000000000000000000000c0dec0de';
const keeper = '0x00000000000000000000000000000000c0dec0df';
const coordinator = '0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d';
const balancer = '0xFE4bF8dfA7c64866a75F141d771eA2d73452ac17';
const pool = '0xc0CE6B85bB0bc02c1b072d291af3ad47c0c670a0';
const abi = (name) => JSON.parse(readFileSync(`audit/round8/lane_b/out/${name}.json`, 'utf8')).abi;
const bAbi = abi('PoolBalancer.sol/PoolBalancer'), pAbi = abi('External.sol/IFWAPool');
const wallet = (account) => createWalletClient({ transport, account, chain: null });
const read = (address, a, functionName, args = [], extra = {}) => pub.readContract({ address, abi: a, functionName, args, ...extra });
async function tx(account, address, a, functionName, args, options = {}) {
  await pub.request({ method: 'anvil_setNextBlockBaseFeePerGas', params: [toHex(parseGwei('1'))] });
  const hash = await wallet(account).writeContract({ address, abi: a, functionName, args, gas: 8_000_000n,
    maxFeePerGas: parseGwei('1.05'), maxPriorityFeePerGas: parseGwei('0.05'),
    ...(options.value === undefined ? {} : { value: options.value }) });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    const trace = await pub.request({ method: 'debug_traceTransaction', params: [hash, { tracer: 'callTracer' }] });
    console.error(JSON.stringify({ failedFunction: functionName, txHash: hash, trace }, null, 2));
    throw new Error(`local fork tx reverted: ${hash}`);
  }
  return receipt;
}
if ((await pub.getChainId()) !== 31337) throw new Error('not local fork');
const snapshot = await pub.request({ method: 'evm_snapshot', params: [] });
try {
  for (const actor of [player, keeper]) {
    if (await pub.getBytecode({ address: actor })) throw new Error(`actor has code: ${actor}`);
    await pub.request({ method: 'anvil_impersonateAccount', params: [actor] });
    await pub.request({ method: 'anvil_setBalance', params: [actor, toHex(parseEther('100'))] });
  }
  await pub.request({ method: 'anvil_impersonateAccount', params: [coordinator] });
  const [fee, vrf, total] = await read(pool, pAbi, 'quoteAcquisitionPrice', [4n], { gasPrice: parseGwei('1.05') });
  const version = await read(pool, pAbi, 'inventoryVersion');
  const deadline = (await pub.getBlock()).timestamp + 86400n;
  const purchase = await tx(player, pool, pAbi, 'acquireBatch', [player, 4n, fee, 0n, 10000n, version, deadline], { value: total });
  const busy = await read(balancer, bAbi, 'admissionStatus');
  const inFlightReserve = await read(balancer, bAbi, 'requiredReserve');
  const last = await read(pool, pAbi, 'lastIssuedSequence');
  const ids = [];
  for (let seq = last - 3n; seq <= last; seq++) ids.push(await read(pool, pAbi, 'requestIdAtSequence', [seq]));
  const acquisitions = [];
  for (let i = 0; i < ids.length; i++) {
    const word = BigInt(keccak256(toHex(`lane-b-five-${i}`)));
    await tx(coordinator, pool, pAbi, 'rawFulfillRandomWords', [ids[i], [word]]);
    await tx(keeper, pool, pAbi, 'processAcquisitions', [4n]);
    const a = await read(pool, pAbi, 'acquisitions', [ids[i]]);
    acquisitions.push({ requestId: String(ids[i]), listingId: String(a[3]), status: String(a[4]) });
  }
  const creditBefore = await read(balancer, bAbi, 'keeperCredit');
  const keeperBefore = await pub.getBalance({ address: keeper });
  const upkeep = await tx(keeper, balancer, bAbi, 'performUpkeep', []);
  const keeperAfter = await pub.getBalance({ address: keeper });
  let reward = 0n, measured = 0n;
  for (const log of upkeep.logs) try {
    const e = decodeEventLog({ abi: bAbi, topics: log.topics, data: log.data });
    if (e.eventName === 'KeeperPaid') { reward = e.args.amount; measured = e.args.gasUsed; }
  } catch { /* integration event */ }
  const billed = upkeep.gasUsed * upkeep.effectiveGasPrice;
  if (keeperAfter - keeperBefore !== reward - billed) throw new Error('keeper wallet delta mismatch');
  console.log(JSON.stringify({ chainId: 31337, forkBlock: 26382349, player, keeper,
    quote: { fee: String(fee), vrf: String(vrf), total: String(total) }, purchaseTx: purchase.transactionHash,
    admissionStatusWhileFourInFlight: String(busy), inFlightReserve: String(inFlightReserve), acquisitions,
    upkeep: { txHash: upkeep.transactionHash, gasLimit: '8000000', billedGas: String(upkeep.gasUsed), effectiveGasPrice: String(upkeep.effectiveGasPrice), measuredGas: String(measured), reward: String(reward), billedCost: String(billed), walletGain: String(keeperAfter - keeperBefore), creditBefore: String(creditBefore), creditAfter: String(await read(balancer, bAbi, 'keeperCredit')), reconciledSequence: String(await read(balancer, bAbi, 'reconciledSequence')) } }, null, 2));
} finally {
  await pub.request({ method: 'evm_revert', params: [snapshot] });
}
