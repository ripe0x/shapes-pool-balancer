// Local-fork FWA draw estimate at one bid, then real inclusion after gas-price change.
// Deploys/broadcasts only to an isolated Anvil node; no mainnet transaction or secret.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  createPublicClient, createTestClient, createWalletClient, decodeFunctionResult, encodeFunctionData,
  http, parseAbi, type Address,
} from 'viem';

const repo = process.cwd();
const project = join(repo, 'audit/round8/integration/informed/project');
const port = 18569;
const rpc = `http://127.0.0.1:${port}`;
const deployer = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;
const buyer = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' as Address;
const creator = '0x46EFbAedc92067E6d60E84ED6395099723252496' as Address; // BAYC #1 owner at pinned block
const bayc = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D' as Address;
const factoryAbi = parseAbi(['function predictBalancer(address,bytes32) view returns(address)', 'function createBalancer(bytes32) payable returns(address)']);
const balAbi = parseAbi([
  'function pool() view returns(address)', 'function listCurated(address,uint256,uint256) returns(uint256)',
  'function configure(uint16,uint256)', 'function open()', 'function performUpkeep() returns(uint256)',
  'function admissionStatus() view returns(uint8)',
]);
const erc721Abi = parseAbi(['function approve(address,uint256)']);
const poolAbi = parseAbi([
  'function quoteAcquisitionPrice(uint256) view returns(uint256 fee,uint256 vrf,uint256 total)',
  'function acquire(address,uint256,uint256,uint256,uint256,uint256) payable returns(uint256)',
  'function inventoryVersion() view returns(uint256)',
  'function unsettledAcquisitionCount() view returns(uint256)',
]);
const links = ['src', 'script', 'lib', 'foundry.toml'];
for (const link of links) {
  const path = join(project, link);
  assert(!existsSync(path), `${path} already exists`);
  symlinkSync(join(repo, link), path);
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
  assert.equal(r.status, 'success');
  return r;
};

try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { await pub.getBlockNumber(); ready = true; break; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  assert(ready, 'local fork did not start');
  execFileSync('forge', [
    'script', 'script/Deploy.s.sol:Deploy', '--root', project, '--out', 'out', '--cache-path', 'cache',
    '--rpc-url', rpc, '--unlocked', '--sender', deployer, '--broadcast', '-vv',
  ], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PACKS_ADMIN: deployer, KEEPER_ADMIN: deployer } });
  const { balancerFactory: factory } = JSON.parse(readFileSync(join(project, 'deployments/31337.json'), 'utf8')) as { balancerFactory: Address };
  await test.impersonateAccount({ address: creator });
  await test.setBalance({ address: creator, value: 5n * 10n ** 18n }); // external EOA wallet setup
  const salt = `0x${'1'.repeat(64)}` as const;
  const bal = await pub.readContract({ address: factory, abi: factoryAbi, functionName: 'predictBalancer', args: [creator, salt] });
  await success(await wallet.writeContract({ address: factory, abi: factoryAbi, functionName: 'createBalancer', args: [salt], account: creator, chain: null, value: 1n * 10n ** 18n }));
  const pool = await pub.readContract({ address: bal, abi: balAbi, functionName: 'pool' });
  await success(await wallet.writeContract({ address: bayc, abi: erc721Abi, functionName: 'approve', args: [bal, 1n], account: creator, chain: null }));
  await success(await wallet.writeContract({ address: bal, abi: balAbi, functionName: 'listCurated', args: [bayc, 1n, 20_000_000_000_000_000n], account: creator, chain: null }));
  await success(await wallet.writeContract({ address: bal, abi: balAbi, functionName: 'configure', args: [1000, 5n], account: creator, chain: null }));
  await success(await wallet.writeContract({ address: bal, abi: balAbi, functionName: 'open', account: creator, chain: null }));
  await success(await wallet.writeContract({ address: bal, abi: balAbi, functionName: 'performUpkeep', account: deployer, chain: null, gas: 5_000_000n }));
  assert.equal(await pub.readContract({ address: bal, abi: balAbi, functionName: 'admissionStatus' }), 0);

  const quote = async (gasPrice: bigint) => {
    const data = encodeFunctionData({ abi: poolAbi, functionName: 'quoteAcquisitionPrice', args: [1n] });
    const r = await pub.call({ to: pool, data, gasPrice });
    return decodeFunctionResult({ abi: poolAbi, functionName: 'quoteAcquisitionPrice', data: r.data! });
  };
  const [oldFee, oldVrf, oldTotal] = await quote(1_000_000_000n);
  const version = await pub.readContract({ address: pool, abi: poolAbi, functionName: 'inventoryVersion' });
  const deadline = (await pub.getBlock()).timestamp + 3600n;
  const args = [buyer, oldFee, 0n, 10_000n, version, deadline] as const;
  const estimated = await pub.estimateContractGas({ address: pool, abi: poolAbi, functionName: 'acquire', args, account: buyer, value: oldTotal, gasPrice: 1_000_000_000n });

  await test.setNextBlockBaseFeePerGas({ baseFeePerGas: 2_000_000_000n });
  await test.mine({ blocks: 1 });
  const [freshFee, freshVrf, freshTotal] = await quote(3_000_000_000n);
  assert.equal(freshFee, oldFee);
  assert(freshTotal > oldTotal);
  let simulationError = '';
  try {
    await pub.simulateContract({ address: pool, abi: poolAbi, functionName: 'acquire', args, account: buyer, value: oldTotal, gasPrice: 3_000_000_000n });
  } catch (e) { simulationError = String((e as Error).message).split('\n').slice(0, 8).join(' | '); }
  assert(simulationError, 'higher-bid simulation should revert');
  const before = await pub.getBalance({ address: buyer });
  const hash = await wallet.writeContract({ address: pool, abi: poolAbi, functionName: 'acquire', args, account: buyer, chain: null, value: oldTotal, gasPrice: 3_000_000_000n, gas: estimated * 13n / 10n });
  const failed = await receipt(hash);
  assert.equal(failed.status, 'reverted');
  const after = await pub.getBalance({ address: buyer });
  assert.equal(before - after, failed.gasUsed * failed.effectiveGasPrice); // principal refunded; gas paid
  assert.equal(await pub.readContract({ address: pool, abi: poolAbi, functionName: 'inventoryVersion' }), version);
  assert.equal(await pub.readContract({ address: pool, abi: poolAbi, functionName: 'unsettledAcquisitionCount' }), 0n);

  const [retryFee, retryVrf, retryTotal] = await quote(3_000_000_000n);
  const retryArgs = [buyer, retryFee, 0n, 10_000n, version, deadline] as const;
  const retryEstimate = await pub.estimateContractGas({ address: pool, abi: poolAbi, functionName: 'acquire', args: retryArgs, account: buyer, value: retryTotal, gasPrice: 3_000_000_000n });
  const retryHash = await wallet.writeContract({ address: pool, abi: poolAbi, functionName: 'acquire', args: retryArgs, account: buyer, chain: null, value: retryTotal, gasPrice: 3_000_000_000n, gas: retryEstimate * 13n / 10n });
  const accepted = await success(retryHash);
  console.log(JSON.stringify({
    forkBlock: 26382349, version: version.toString(), oldFee: oldFee.toString(), oldVrf: oldVrf.toString(), oldTotal: oldTotal.toString(),
    freshFee: freshFee.toString(), freshVrf: freshVrf.toString(), freshTotal: freshTotal.toString(), simulationError,
    estimated: estimated.toString(), failedGasUsed: failed.gasUsed.toString(), failedGasPrice: failed.effectiveGasPrice.toString(),
    failedValueRefunded: before - after === failed.gasUsed * failed.effectiveGasPrice,
    retryVrf: retryVrf.toString(), retryTotal: retryTotal.toString(), retryEstimate: retryEstimate.toString(),
    retryGasUsed: accepted.gasUsed.toString(), retryStatus: accepted.status,
  }));
} finally {
  anvil.kill('SIGTERM'); // only the private child process started above
  for (const link of links) unlinkSync(join(project, link));
}
