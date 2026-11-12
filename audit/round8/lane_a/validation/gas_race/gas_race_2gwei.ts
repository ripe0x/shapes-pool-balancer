// Pinned Tenderly read-only upstream; every transaction broadcasts only to this script's private Anvil child.
// No private keys, protocol state/balance overrides, or direct service-sender callback.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  createPublicClient, createTestClient, createWalletClient, decodeFunctionResult, encodeFunctionData, encodePacked, keccak256,
  http, parseAbi, type Address,
} from 'viem';

const repo = process.cwd();
const project = join(repo, 'audit/round8/lane_a/validation/gas_race/project');
mkdirSync(project, { recursive: true });
mkdirSync(join(project, 'deployments'), { recursive: true });
const port = 18847;
const rpc = `http://127.0.0.1:${port}`;
const deployer = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;
const creator = '0x46EFbAedc92067E6d60E84ED6395099723252496' as Address; // BAYC #1 owner at pin
const buyer = '0x0000000000000000000000000000000000000B0b' as Address;
const keeper = '0x000000000000000000000000000000000000bEEF' as Address;
const coordinator = '0xD7f86b4b8Cae7D942340FF628F82735b7a20893a' as Address;
const service = '0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d' as Address;
const shapes = '0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0' as Address;
const bayc = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D' as Address;
const gasPrice = 2_000_000_000n;
const factoryAbi = parseAbi(['function predictBalancer(address,bytes32) view returns(address)', 'function createBalancer(bytes32) payable returns(address)']);
const balAbi = parseAbi([
  'function pool() view returns(address)', 'function listCurated(address,uint256,uint256) returns(uint256)',
  'function configure(uint16,uint256)', 'function open()', 'function performUpkeep() returns(uint256)',
  'function admissionStatus() view returns(uint8)', 'function getActiveIds() view returns(uint256[])',
  'function items(uint256) view returns(uint8 kind,uint8 denom,uint8 state,uint112 base,uint112 price)',
]);
const erc721Abi = parseAbi(['function ownerOf(uint256) view returns(address)', 'function approve(address,uint256)']);
const poolAbi = parseAbi([
  'function quoteAcquisitionPrice(uint256) view returns(uint256 fee,uint256 vrf,uint256 total)',
  'function acquire(address,uint256,uint256,uint256,uint256,uint256) payable returns(uint256)',
  'function inventoryVersion() view returns(uint256)', 'function requestIdAtSequence(uint64) view returns(uint256)',
  'function lastIssuedSequence() view returns(uint64)',
  'function acquisitions(uint256) view returns(address purchaser,uint256 requestBlock,uint256 priceEscrowed,uint256 listingId,uint8 status,bool tokenPayment)',
  'function processAcquisitions(uint256) returns(uint256)',
]);
const serviceAbi = parseAbi([
  'function coordinator() view returns(address)',
  'function rawFulfillRandomWords(uint256,uint256[])',
]);
const added: string[] = [];
for (const link of ['src', 'script', 'lib', 'foundry.toml']) {
  const path = join(project, link);
  assert(!existsSync(path), `${path} already exists`);
  symlinkSync(join(repo, link), path);
  added.push(path);
}
const anvil = spawn('anvil', [
  '--fork-url', 'https://mainnet.gateway.tenderly.co', '--fork-block-number', '26382349',
  '--chain-id', '31337', '--port', String(port), '--silent',
], { stdio: 'ignore' });
const pub = createPublicClient({ transport: http(rpc) });
const test = createTestClient({ mode: 'anvil', transport: http(rpc) });
const wallet = createWalletClient({ transport: http(rpc) });
const receipt = async (hash: `0x${string}`) => pub.waitForTransactionReceipt({ hash });
const success = async (hash: `0x${string}`) => {
  const r = await receipt(hash);
  assert.equal(r.status, 'success', `transaction ${hash} reverted`);
  return r;
};
const candidateWord = (requestId: bigint, index: bigint) =>
  BigInt(keccak256(encodePacked(['string', 'uint256', 'uint256'], ['gas-race', requestId, index])));
const isCodeFree = async (address: Address) => {
  const code = await pub.getCode({ address });
  assert(!code || code === '0x', `${address} is not code-free`);
};

try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try { await pub.getBlockNumber(); ready = true; break; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  assert(ready, 'private Anvil fork did not start');
  console.error('private fork ready');
  await isCodeFree(creator);
  await isCodeFree(buyer);
  await isCodeFree(keeper);
  assert.equal(await pub.readContract({ address: bayc, abi: erc721Abi, functionName: 'ownerOf', args: [1n] }), creator);
  assert.equal(await pub.readContract({ address: service, abi: serviceAbi, functionName: 'coordinator' }), coordinator);
  await test.impersonateAccount({ address: creator });
  await test.impersonateAccount({ address: buyer });
  await test.impersonateAccount({ address: keeper });
  await test.impersonateAccount({ address: coordinator }); // sole permitted protocol-identity exception
  await test.setBalance({ address: creator, value: 5n * 10n ** 18n });
  await test.setBalance({ address: buyer, value: 1n * 10n ** 18n });
  await test.setBalance({ address: keeper, value: 1n * 10n ** 18n });
  // Coordinator already holds real ETH at the pinned block; its balance is not changed.
  const coordinatorInitialBalance = await pub.getBalance({ address: coordinator });
  assert(coordinatorInitialBalance > 1n * 10n ** 18n);

  execFileSync('forge', [
    'script', 'script/Deploy.s.sol:Deploy', '--root', project, '--out', 'out', '--cache-path', 'cache',
    '--rpc-url', rpc, '--unlocked', '--sender', deployer, '--broadcast', '-vv',
  ], {
    cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PACKS_ADMIN: deployer, KEEPER_ADMIN: deployer },
  });
  console.error('local production deploy script completed');
  const { balancerFactory: factory } = JSON.parse(readFileSync(join(project, 'deployments/31337.json'), 'utf8')) as { balancerFactory: Address };
  const salt = `0x${'3'.repeat(64)}` as const;
  const bal = await pub.readContract({ address: factory, abi: factoryAbi, functionName: 'predictBalancer', args: [creator, salt] });
  await success(await wallet.writeContract({ address: factory, abi: factoryAbi, functionName: 'createBalancer', args: [salt], account: creator, chain: null, value: 2n * 10n ** 18n, gasPrice }));
  const pool = await pub.readContract({ address: bal, abi: balAbi, functionName: 'pool' });
  await success(await wallet.writeContract({ address: bayc, abi: erc721Abi, functionName: 'approve', args: [bal, 1n], account: creator, chain: null, gasPrice }));
  await success(await wallet.writeContract({ address: bal, abi: balAbi, functionName: 'listCurated', args: [bayc, 1n, 20_000_000_000_000_000n], account: creator, chain: null, gasPrice }));
  await success(await wallet.writeContract({ address: bal, abi: balAbi, functionName: 'configure', args: [0, 4n], account: creator, chain: null, gasPrice }));
  await success(await wallet.writeContract({ address: bal, abi: balAbi, functionName: 'open', account: creator, chain: null, gasPrice }));
  await success(await wallet.writeContract({ address: bal, abi: balAbi, functionName: 'performUpkeep', account: keeper, chain: null, gas: 5_000_000n, gasPrice }));
  assert.equal(await pub.readContract({ address: bal, abi: balAbi, functionName: 'admissionStatus' }), 0);
  assert.equal((await pub.readContract({ address: bal, abi: balAbi, functionName: 'getActiveIds' })).length, 5);
  console.error('four Shapes and one curated NFT stocked');

  const quote = async () => {
    const data = encodeFunctionData({ abi: poolAbi, functionName: 'quoteAcquisitionPrice', args: [1n] });
    const r = await pub.call({ to: pool, data, gasPrice });
    return decodeFunctionResult({ abi: poolAbi, functionName: 'quoteAcquisitionPrice', data: r.data! });
  };
  const buyOne = async () => {
    const [fee, vrf, total] = await quote();
    const version = await pub.readContract({ address: pool, abi: poolAbi, functionName: 'inventoryVersion' });
    const deadline = (await pub.getBlock()).timestamp + 3600n;
    const r = await success(await wallet.writeContract({
      address: pool, abi: poolAbi, functionName: 'acquire',
      args: [buyer, fee, 0n, 10_000n, version, deadline],
      account: buyer, chain: null, value: total, gasPrice,
    }));
    return { fee, vrf, total, txHash: r.transactionHash };
  };
  const firstBuy = await buyOne();
  assert.equal(await pub.readContract({ address: bal, abi: balAbi, functionName: 'admissionStatus' }), 0, 'second buy should remain admitted');
  const secondBuy = await buyOne();
  assert.equal(await pub.readContract({ address: pool, abi: poolAbi, functionName: 'lastIssuedSequence' }), 2n);
  const requestA = await pub.readContract({ address: pool, abi: poolAbi, functionName: 'requestIdAtSequence', args: [1] });
  const requestB = await pub.readContract({ address: pool, abi: poolAbi, functionName: 'requestIdAtSequence', args: [2] });
  await test.mine({ blocks: 1 });

  const chosen = async (requestId: bigint) => pub.readContract({ address: pool, abi: poolAbi, functionName: 'acquisitions', args: [requestId] });
  const selectedShape = async (requestId: bigint) => {
    const acq = await chosen(requestId);
    if (acq[4] !== 2 || acq[3] === 0n) return false;
    const item = await pub.readContract({ address: bal, abi: balAbi, functionName: 'items', args: [acq[3]] });
    return item[0] === 2;
  };
  const deliverShape = async (requestId: bigint) => {
    for (let index = 1n; index <= 20n; index++) {
      const word = candidateWord(requestId, index);
      const snap = await test.snapshot();
      try {
        await success(await wallet.writeContract({
          address: service, abi: serviceAbi, functionName: 'rawFulfillRandomWords',
          args: [requestId, [word]], account: coordinator, chain: null, gas: 1_500_000n, gasPrice,
        }));
        await success(await wallet.writeContract({ address: pool, abi: poolAbi, functionName: 'processAcquisitions', args: [5n], account: keeper, chain: null, gas: 1_500_000n, gasPrice }));
        if (await selectedShape(requestId)) return word;
      } catch (e) {
        console.error('candidate word failed', index.toString(), String((e as Error).message).slice(0, 180));
      }
      await test.revert({ id: snap });
    }
    throw new Error(`no Shape outcome for request ${requestId}`);
  };
  const wordA = await deliverShape(requestA);
  assert.equal((await chosen(requestA))[4], 2);
  assert.equal((await chosen(requestB))[4], 1);
  console.error('first Shape draw settled; second request still pending');

  // Find a word for B on the same prestate, but restore it before eth_estimateGas.
  let wordB = 0n;
  for (let index = 1n; index <= 20n; index++) {
    const word = candidateWord(requestB, index);
    const snap = await test.snapshot();
    try {
      await success(await wallet.writeContract({ address: service, abi: serviceAbi, functionName: 'rawFulfillRandomWords', args: [requestB, [word]], account: coordinator, chain: null, gas: 1_500_000n, gasPrice }));
      await success(await wallet.writeContract({ address: pool, abi: poolAbi, functionName: 'processAcquisitions', args: [5n], account: keeper, chain: null, gas: 1_500_000n, gasPrice }));
      if (await selectedShape(requestB)) wordB = word;
    } finally { await test.revert({ id: snap }); }
    if (wordB !== 0n) break;
  }
  assert(wordB !== 0n, 'second Shape outcome unavailable');
  const prestateBlock = await pub.getBlock();
  const estimated = await pub.estimateContractGas({ address: bal, abi: balAbi, functionName: 'performUpkeep', account: keeper, gasPrice });
  const limit30 = estimated * 13n / 10n;
  const prestate = await test.snapshot();
  await test.setNextBlockBaseFeePerGas({ baseFeePerGas: prestateBlock.baseFeePerGas! });
  const baseline = await success(await wallet.writeContract({ address: bal, abi: balAbi, functionName: 'performUpkeep', account: keeper, chain: null, gas: estimated * 2n, gasPrice }));
  await test.revert({ id: prestate });
  console.error('prestate estimate and baseline receipt captured');

  const includeWithLimit = async (gasLimit: bigint) => {
    const snap = await test.snapshot();
    await test.setAutomine(false);
    let cbHash: `0x${string}`;
    let processHash: `0x${string}`;
    let upkeepHash: `0x${string}`;
    try {
      await test.setNextBlockBaseFeePerGas({ baseFeePerGas: prestateBlock.baseFeePerGas! });
      const keeperNonce = await pub.getTransactionCount({ address: keeper, blockTag: 'pending' });
      cbHash = await wallet.writeContract({ address: service, abi: serviceAbi, functionName: 'rawFulfillRandomWords', args: [requestB, [wordB]], account: coordinator, chain: null, gas: 1_500_000n, gasPrice: 3_000_000_000n });
      processHash = await wallet.writeContract({ address: pool, abi: poolAbi, functionName: 'processAcquisitions', args: [5n], account: keeper, chain: null, nonce: keeperNonce, gas: 1_500_000n, gasPrice: 2_500_000_000n });
      upkeepHash = await wallet.writeContract({ address: bal, abi: balAbi, functionName: 'performUpkeep', account: keeper, chain: null, nonce: keeperNonce + 1, gas: gasLimit, gasPrice });
      await test.mine({ blocks: 1 });
    } finally { await test.setAutomine(true); }
    const cb = await receipt(cbHash!);
    const process = await receipt(processHash!);
    const upkeep = await receipt(upkeepHash!);
    assert.equal(cb.status, 'success');
    assert.equal(process.status, 'success');
    assert.equal(cb.blockNumber, process.blockNumber);
    assert.equal(process.blockNumber, upkeep.blockNumber);
    assert(cb.transactionIndex < process.transactionIndex && process.transactionIndex < upkeep.transactionIndex);
    return { snap, cb, process, upkeep };
  };
  const unlimited = await includeWithLimit(estimated * 3n);
  assert.equal(unlimited.upkeep.status, 'success');
  assert.equal((await chosen(requestB))[4], 2);
  const activeAfter = await pub.readContract({ address: bal, abi: balAbi, functionName: 'getActiveIds' });
  assert.equal(activeAfter.length, 5, 'two Shape draws should restock back to target');
  await test.revert({ id: unlimited.snap });

  const limited = await includeWithLimit(limit30);
  const exceeds30 = unlimited.upkeep.gasUsed > limit30;
  if (exceeds30) assert.equal(limited.upkeep.status, 'reverted', '30% limit should fail');
  else assert.equal(limited.upkeep.status, 'success', '30% limit should cover this state');
  const limitedTraceErrors: string[] = [];
  if (limited.upkeep.status === 'reverted') {
    try {
      const trace = await pub.request({
        method: 'debug_traceTransaction',
        params: [limited.upkeep.transactionHash, { tracer: 'callTracer' }],
      } as never) as { error?: string; calls?: unknown[] };
      const walk = (node: { error?: string; calls?: unknown[] }, path: string) => {
        if (node.error) limitedTraceErrors.push(`${path}: ${node.error}`);
        for (const [i, child] of (node.calls ?? []).entries()) walk(child as typeof node, `${path}/${i}`);
      };
      walk(trace, 'upkeep');
    } catch (e) { limitedTraceErrors.push(`trace unavailable: ${String((e as Error).message).slice(0, 180)}`); }
  }
  console.log(JSON.stringify({
    forkBlock: 26382349, prestateBlock: prestateBlock.number.toString(), inclusionBlock: limited.upkeep.blockNumber.toString(),
    prestateBasefee: prestateBlock.baseFeePerGas?.toString(), inclusionBasefee: (await pub.getBlock({ blockNumber: limited.upkeep.blockNumber })).baseFeePerGas?.toString(),
    balancer: bal, pool, requestA: requestA.toString(), requestB: requestB.toString(), wordA: wordA.toString(), wordB: wordB.toString(),
    firstBuy: { fee: firstBuy.fee.toString(), vrf: firstBuy.vrf.toString(), total: firstBuy.total.toString(), txHash: firstBuy.txHash },
    secondBuy: { fee: secondBuy.fee.toString(), vrf: secondBuy.vrf.toString(), total: secondBuy.total.toString(), txHash: secondBuy.txHash },
    estimated: estimated.toString(), baselineBilled: baseline.gasUsed.toString(),
    actualBilled: unlimited.upkeep.gasUsed.toString(), growthOverEstimate: (unlimited.upkeep.gasUsed - estimated).toString(),
    growthOverBaseline: (unlimited.upkeep.gasUsed - baseline.gasUsed).toString(),
    limit30: limit30.toString(), exceeds30, limitedStatus: limited.upkeep.status, limitedGasUsed: limited.upkeep.gasUsed.toString(),
    limitedTraceErrors,
    callbackIndex: limited.cb.transactionIndex, processIndex: limited.process.transactionIndex, upkeepIndex: limited.upkeep.transactionIndex,
    callbackHash: limited.cb.transactionHash, processHash: limited.process.transactionHash, upkeepHash: limited.upkeep.transactionHash,
    activeAfterUnlimited: activeAfter.length, coordinatorBalanceUnmodified: coordinatorInitialBalance.toString(),
  }));
} finally {
  anvil.kill('SIGTERM'); // terminate only this script's private child process
  for (const path of added) unlinkSync(path); // remove only this script's temporary symlinks; preserve cache/output
}
