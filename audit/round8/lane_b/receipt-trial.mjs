// Local Anvil fork only. Uses unlocked accounts and the forked real integrations.
import { readFileSync } from 'node:fs';
import {
  createPublicClient, createWalletClient, decodeEventLog, http, keccak256, parseEther, parseGwei, toHex,
} from 'viem';

const rpc = 'http://127.0.0.1:18547';
const transport = http(rpc);
const pub = createPublicClient({ transport });
const creator = '0x46EFbAedc92067E6d60E84ED6395099723252496';
const coordinator = '0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d';
const fwaFactory = '0x8919814D825a5Af238cC04DE06b1C18c9eaA477C';
const fwaImpl = '0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7';
const fwaHash = '0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02';
const shapes = '0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0';
const ens = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';
const bayc = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D';

const artifact = (name) => JSON.parse(readFileSync(`audit/round8/lane_b/out/${name}.sol/${name}.json`, 'utf8'));
const artRenderer = artifact('ShapePackRenderer');
const artPacks = artifact('ShapePacks');
const artPage = artifact('PoolPage');
const artBalancer = artifact('PoolBalancer');
const artFactory = artifact('BalancerFactory');
const artFwa = JSON.parse(readFileSync('audit/round8/lane_b/out/External.sol/IFWAPool.json', 'utf8'));
const artNft = JSON.parse(readFileSync('audit/round8/lane_b/out/External.sol/IERC721Min.json', 'utf8'));
const accounts = await pub.request({ method: 'eth_accounts' });
const keeper = accounts[0];
const player = accounts[1];
const wallet = (account) => createWalletClient({ transport, account, chain: null });
const keeperWallet = wallet(keeper);
const creatorWallet = wallet(creator);
const playerWallet = wallet(player);
const coordinatorWallet = wallet(coordinator);
const sendOpts = { gas: 10_000_000n, maxFeePerGas: parseGwei('1.05'), maxPriorityFeePerGas: parseGwei('0.05') };

async function nextBaseFee(gwei = '1') {
  await pub.request({ method: 'anvil_setNextBlockBaseFeePerGas', params: [toHex(parseGwei(gwei))] });
}
async function wait(hash) {
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`local fork tx reverted ${hash}`);
  return r;
}
async function deploy(w, art, args) {
  await nextBaseFee();
  const r = await wait(await w.deployContract({ abi: art.abi, bytecode: art.bytecode.object, args, ...sendOpts }));
  return r.contractAddress;
}
async function write(w, address, abi, functionName, args, value) {
  await nextBaseFee();
  return wait(await w.writeContract({ address, abi, functionName, args, ...(value === undefined ? {} : { value }), ...sendOpts }));
}
const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });

if ((await pub.getChainId()) !== 31337) throw new Error('not a local fork chain');
await pub.request({ method: 'anvil_impersonateAccount', params: [creator] });
await pub.request({ method: 'anvil_impersonateAccount', params: [coordinator] });
await pub.request({ method: 'anvil_setBalance', params: [creator, toHex(parseEther('10'))] }); // external actor wallet
const renderer = await deploy(keeperWallet, artRenderer, [shapes]);
const packs = await deploy(keeperWallet, artPacks, [shapes, renderer, creator, 'Pool Prize Packs', 'PRIZEPACK', 2n]);
const page = await deploy(keeperWallet, artPage, []);
const link = artBalancer.bytecode.linkReferences['src/PoolPage.sol'].PoolPage[0];
const code = artBalancer.bytecode.object;
const linkStart = 2 + 2 * link.start;
const linkedBytecode = `${code.slice(0, linkStart)}${page.slice(2)}${code.slice(linkStart + 2 * link.length)}`;
const impl = await deploy(keeperWallet, { ...artBalancer, bytecode: { object: linkedBytecode } }, [fwaFactory, fwaImpl, fwaHash, shapes, packs, ens]);
const factory = await deploy(keeperWallet, artFactory, [impl, creator]);
const salt = toHex(1n, { size: 32 });
const balancer = await read(factory, artFactory.abi, 'predictBalancer', [creator, salt]);
await write(creatorWallet, factory, artFactory.abi, 'createBalancer', [salt], parseEther('4'));
const pool = await read(balancer, artBalancer.abi, 'pool');
const plan = 20n | (10n << 16n) | (2n << 32n) | (1n << 48n) | (7n << 144n);
await write(creatorWallet, balancer, artBalancer.abi, 'configure', [1500, plan]);
await write(creatorWallet, bayc, artNft.abi, 'approve', [balancer, 1n]);
await write(creatorWallet, balancer, artBalancer.abi, 'listCurated', [bayc, 1n, parseEther('0.3')]);
await write(creatorWallet, balancer, artBalancer.abi, 'open', []);
let stockup = 0;
while (await read(balancer, artBalancer.abi, 'creatorWork')) {
  if (++stockup > 20) throw new Error('opening stockup exceeded 20 calls');
  await write(keeperWallet, balancer, artBalancer.abi, 'performUpkeep', []);
}
const [fee, vrf, total] = await read(pool, artFwa.abi, 'quoteAcquisitionPrice', [1n]);
const inventoryVersion = await read(pool, artFwa.abi, 'inventoryVersion');
const deadline = (await pub.getBlock()).timestamp + 86400n;
await write(playerWallet, pool, artFwa.abi, 'acquire', [player, fee, 0n, 10000n, inventoryVersion, deadline], total);
const requestId = await read(pool, artFwa.abi, 'requestIdAtSequence', [1n]);
const word = BigInt(keccak256(toHex('lane-b-real-vrf-delivery')));
await write(coordinatorWallet, pool, artFwa.abi, 'rawFulfillRandomWords', [requestId, [word]]);
await write(keeperWallet, pool, artFwa.abi, 'processAcquisitions', [5n]);
const acquisition = await read(pool, artFwa.abi, 'acquisitions', [requestId]);
const lid = acquisition[3];
const item = await read(balancer, artBalancer.abi, 'items', [lid]);
if (acquisition[4] !== 2 || item[0] !== 2 || item[1] !== 0) {
  throw new Error(`did not select a delivered 0.01 Shape: status=${acquisition[4]} kind=${item[0]} denom=${item[1]}`);
}
const creditBefore = await read(balancer, artBalancer.abi, 'keeperCredit');
const restockFee = await read(balancer, artBalancer.abi, 'restockFee');
const upkeepReceipt = await write(keeperWallet, balancer, artBalancer.abi, 'performUpkeep', []);
let reward = 0n;
let measured = 0n;
for (const l of upkeepReceipt.logs) {
  try {
    const ev = decodeEventLog({ abi: artBalancer.abi, data: l.data, topics: l.topics });
    if (ev.eventName === 'KeeperPaid') {
      reward = ev.args.amount;
      measured = ev.args.gasUsed;
    }
  } catch { /* integration event */ }
}
const cost = upkeepReceipt.gasUsed * upkeepReceipt.effectiveGasPrice;
const result = {
  chainId: await pub.getChainId(), forkBlock: '26382349',
  localRpc: rpc, balancer, pool, stockupCalls: stockup,
  playerQuote: { fee: String(fee), vrf: String(vrf), total: String(total) },
  drawn: { listingId: String(lid), kind: String(item[0]), denom: String(item[1]) },
  keeper: {
    txHash: upkeepReceipt.transactionHash,
    blockNumber: String(upkeepReceipt.blockNumber),
    gasUsedBilled: String(upkeepReceipt.gasUsed),
    effectiveGasPrice: String(upkeepReceipt.effectiveGasPrice),
    measuredGas: String(measured),
    reward: String(reward),
    billedCost: String(cost),
    net: String(reward - cost),
    gasLimit: String(sendOpts.gas),
    restockFee: String(restockFee),
    creditBefore: String(creditBefore),
    creditAfter: String(await read(balancer, artBalancer.abi, 'keeperCredit')),
  },
};
console.log(JSON.stringify(result, null, 2));
