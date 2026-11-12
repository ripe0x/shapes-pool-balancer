// Fresh Balanced pool, five real FWA draws and coordinator-to-service deliveries; snapshot-restored.
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, decodeEventLog, http, keccak256, parseEther, parseGwei, toHex } from 'viem';
const transport = http(process.env.LANE_B_RPC ?? 'http://127.0.0.1:18548');
const pub = createPublicClient({ transport });
const player = '0x00000000000000000000000000000000c0dec0de';
const keeper = '0x00000000000000000000000000000000c0dec0df';
const coordinator = '0xD7f86b4b8Cae7D942340FF628F82735b7a20893a';
const service = '0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d';
const serviceAbi = [{ type: 'function', name: 'rawFulfillRandomWords', stateMutability: 'nonpayable', inputs: [{ name: 'requestId', type: 'uint256' }, { name: 'words', type: 'uint256[]' }], outputs: [] }];
const fwaFactory = '0x8919814D825a5Af238cC04DE06b1C18c9eaA477C';
const fwaImpl = '0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7';
const fwaHash = '0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02';
const shapes = '0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0';
const ens = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';
const bayc = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D';
let balancer, pool;
const abi = (name) => JSON.parse(readFileSync(`audit/round8/lane_b/out/${name}.json`, 'utf8')).abi;
const artifact = (name) => JSON.parse(readFileSync(`audit/round8/lane_b/out/${name}.sol/${name}.json`, 'utf8'));
const bAbi = abi('PoolBalancer.sol/PoolBalancer'), pAbi = abi('External.sol/IFWAPool'), fAbi = abi('BalancerFactory.sol/BalancerFactory'), nftAbi = abi('External.sol/IERC721Min');
const wallet = (account) => createWalletClient({ transport, account, chain: null });
const read = (address, a, functionName, args = [], extra = {}) => pub.readContract({ address, abi: a, functionName, args, ...extra });
async function tx(account, address, a, functionName, args, options = {}) {
  await pub.request({ method: 'anvil_setNextBlockBaseFeePerGas', params: [toHex(parseGwei('1'))] });
  const hash = await wallet(account).writeContract({ address, abi: a, functionName, args, gas: 8_000_000n,
    maxFeePerGas: options.maxFeePerGas ?? parseGwei('1.05'), maxPriorityFeePerGas: options.maxPriorityFeePerGas ?? parseGwei('0.05'),
    ...(options.value === undefined ? {} : { value: options.value }) });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    const trace = await pub.request({ method: 'debug_traceTransaction', params: [hash, { tracer: 'callTracer' }] });
    console.error(JSON.stringify({ failedFunction: functionName, txHash: hash, trace }, null, 2));
    throw new Error(`local fork tx reverted: ${hash}`);
  }
  return receipt;
}
async function deploy(account, art, args) {
  await pub.request({ method: 'anvil_setNextBlockBaseFeePerGas', params: [toHex(parseGwei('1'))] });
  const hash = await wallet(account).deployContract({ abi: art.abi, bytecode: art.bytecode.object, args, gas: 10_000_000n,
    maxFeePerGas: parseGwei('1.05'), maxPriorityFeePerGas: parseGwei('0.05') });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`local deploy reverted: ${hash}`);
  return receipt.contractAddress;
}
if ((await pub.getChainId()) !== 31337) throw new Error('not local fork');
const snapshot = await pub.request({ method: 'evm_snapshot', params: [] });
try {
  const creator = await read(bayc, nftAbi, 'ownerOf', [2n]);
  for (const actor of [creator, player, keeper]) {
    if (await pub.getBytecode({ address: actor })) throw new Error(`actor has code: ${actor}`);
    await pub.request({ method: 'anvil_impersonateAccount', params: [actor] });
    await pub.request({ method: 'anvil_setBalance', params: [actor, toHex(parseEther('100'))] });
  }
  if (!(await pub.getBytecode({ address: coordinator }))) throw new Error('real coordinator absent');
  await pub.request({ method: 'anvil_impersonateAccount', params: [coordinator] });
  const renderer = await deploy(keeper, artifact('ShapePackRenderer'), [shapes]);
  const packs = await deploy(keeper, artifact('ShapePacks'), [shapes, renderer, creator, 'Pool Prize Packs', 'PRIZEPACK', 2n]);
  const page = await deploy(keeper, artifact('PoolPage'), []);
  const balancerArt = artifact('PoolBalancer');
  const link = balancerArt.bytecode.linkReferences['src/PoolPage.sol'].PoolPage[0];
  const code = balancerArt.bytecode.object;
  const start = 2 + 2 * link.start;
  const linkedCode = `${code.slice(0, start)}${page.slice(2)}${code.slice(start + 2 * link.length)}`;
  const implementation = await deploy(keeper, { ...balancerArt, bytecode: { object: linkedCode } }, [fwaFactory, fwaImpl, fwaHash, shapes, packs, ens]);
  const factory = await deploy(keeper, artifact('BalancerFactory'), [implementation, creator]);
  const salt = toHex(533n, { size: 32 });
  balancer = await read(factory, fAbi, 'predictBalancer', [creator, salt]);
  await tx(creator, factory, fAbi, 'createBalancer', [salt], { value: parseEther('4') });
  pool = await read(balancer, bAbi, 'pool');
  const plan = 20n | (10n << 16n) | (2n << 32n) | (1n << 48n) | (7n << 144n);
  await tx(creator, balancer, bAbi, 'configure', [1500, plan]);
  await tx(creator, bayc, nftAbi, 'approve', [balancer, 2n]);
  await tx(creator, balancer, bAbi, 'listCurated', [bayc, 2n, parseEther('0.3')]);
  await tx(creator, balancer, bAbi, 'open', []);
  for (let i = 0; i < 20 && await read(balancer, bAbi, 'creatorWork'); i++) await tx(keeper, balancer, bAbi, 'performUpkeep', []);
  if (await read(balancer, bAbi, 'creatorWork')) throw new Error('opening incomplete');
  const [fee, vrf, total] = await read(pool, pAbi, 'quoteAcquisitionPrice', [5n], { gasPrice: parseGwei('1.05') });
  const version = await read(pool, pAbi, 'inventoryVersion');
  const deadline = (await pub.getBlock()).timestamp + 86400n;
  const purchase = await tx(player, pool, pAbi, 'acquireBatch', [player, 5n, fee, 0n, 10000n, version, deadline], { value: total });
  const busy = await read(balancer, bAbi, 'admissionStatus');
  const inFlightReserve = await read(balancer, bAbi, 'requiredReserve');
  const last = await read(pool, pAbi, 'lastIssuedSequence');
  const ids = [];
  for (let seq = last - 4n; seq <= last; seq++) ids.push(await read(pool, pAbi, 'requestIdAtSequence', [seq]));
  const acquisitions = [];
  for (let i = 0; i < ids.length; i++) {
    const word = BigInt(keccak256(toHex(`lane-b-five-${i}`)));
    await tx(coordinator, service, serviceAbi, 'rawFulfillRandomWords', [ids[i], [word]]);
    await tx(player, pool, pAbi, 'processAcquisitions', [5n]);
    const a = await read(pool, pAbi, 'acquisitions', [ids[i]]);
    acquisitions.push({ requestId: String(ids[i]), listingId: String(a[3]), status: String(a[4]) });
  }
  const creditBefore = await read(balancer, bAbi, 'keeperCredit');
  const beforeUpkeep = await pub.request({ method: 'evm_snapshot', params: [] });
  const variants = [];
  for (const bid of ['1.05', '5.05']) {
    if (variants.length) await pub.request({ method: 'evm_revert', params: [beforeUpkeep] });
    const keeperBefore = await pub.getBalance({ address: keeper });
    const upkeep = await tx(keeper, balancer, bAbi, 'performUpkeep', [], { maxFeePerGas: parseGwei(bid), maxPriorityFeePerGas: parseGwei(String(Number(bid) - 1)) });
    const keeperAfter = await pub.getBalance({ address: keeper });
    let reward = 0n, measured = 0n;
    for (const log of upkeep.logs) try {
      const e = decodeEventLog({ abi: bAbi, topics: log.topics, data: log.data });
      if (e.eventName === 'KeeperPaid') { reward = e.args.amount; measured = e.args.gasUsed; }
    } catch { /* integration event */ }
    const billed = upkeep.gasUsed * upkeep.effectiveGasPrice;
    if (keeperAfter - keeperBefore !== reward - billed) throw new Error('keeper wallet delta mismatch');
    variants.push({ bidGwei: bid, txHash: upkeep.transactionHash, gasLimit: '8000000', billedGas: String(upkeep.gasUsed), effectiveGasPrice: String(upkeep.effectiveGasPrice), measuredGas: String(measured), reward: String(reward), billedCost: String(billed), walletGain: String(keeperAfter - keeperBefore), creditAfter: String(await read(balancer, bAbi, 'keeperCredit')), reconciledSequence: String(await read(balancer, bAbi, 'reconciledSequence')) });
  }
  console.log(JSON.stringify({ chainId: 31337, forkBlock: 26382349, creator, factory, balancer, pool, player, keeper,
    quote: { fee: String(fee), vrf: String(vrf), total: String(total) }, purchaseTx: purchase.transactionHash,
    admissionStatusWhileFiveInFlight: String(busy), inFlightReserve: String(inFlightReserve), acquisitions,
    callbackRoute: 'coordinator -> VRF service -> FWA pool', creditBefore: String(creditBefore), variants }, null, 2));
} finally {
  await pub.request({ method: 'evm_revert', params: [snapshot] });
}
