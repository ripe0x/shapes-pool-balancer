import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { BaseError, createPublicClient, createWalletClient, custom, decodeErrorResult, decodeFunctionData, encodeFunctionData, http, isHex, zeroHash, parseAbi, parseEther, UserRejectedRequestError, WaitForTransactionReceiptTimeoutError, type Address, type Hash, type TransactionReceipt } from 'viem';
import { expect, it } from 'vitest';
import { balancerFactoryAbi, poolBalancerAbi } from '../../shared/abi';
import { canRetryCreation, recoverCreation, submitCreation, waitForCreation, type CreationAttempt } from './creation';

const rpc = process.env.CREATION_REPLACEMENT_RPC;
const broadcast = process.env.CREATION_REPLACEMENT_BROADCAST === '1';
const resume = process.env.CREATION_REPLACEMENT_RESUME === '1';
const readback = process.env.CREATION_REPLACEMENT_READBACK === '1';
const directory = resolve('docs/verification/creation-replacement');
const evidencePath = resolve(directory, 'transactions.json');
const creator: Address = '0x00000000000000000000000000000000000ce001';
const factory: Address = '0xCd171B437d9329C2654128645944fbC05C9AA2BF';
const nft: Address = '0x7de7BC53e06f8549c6F89AEE3F59cD605c97c455';
const tokenId = 2026111901n;
const nftAbi = parseAbi(['function mint(address to,uint256 id)', 'function approve(address to,uint256 id)', 'function ownerOf(uint256 id) view returns(address)']);
const context = { chainId: 31337, factory, creator };
const gas = 4_000_000n;
const gasBudget = parseEther('0.1');
const depositBudget = parseEther('0.1');
const fees = { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 50_000_000n };
const replacementFees = { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 100_000_000n };
const json = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? String(v) : v, 2) + '\n';
type EvidenceRecord = { label: string; original?: CreationAttempt; latest?: CreationAttempt; originalHash?: Hash; replacementHash?: Hash; outcome?: string; receipt?: TransactionReceipt; liveRemembered?: CreationAttempt[] };

// This opt-in test broadcasts only to its recorded, isolated child. It cannot silently rerun a partially completed fixture.
it.skipIf(!rpc || !broadcast)('reconciles actual cancelled, repriced and late replacements through live waits and reloads', async () => {
  const node = JSON.parse(readFileSync(resolve(directory, 'node.json'), 'utf8'));
  expect(rpc).toBe('http://127.0.0.1:18795');
  expect(node.rpc).toBe(rpc);
  expect(node.parentRpc).toBe('http://127.0.0.1:18766');
  expect(node.ownedChild).toBe(true);
  expect(existsSync(evidencePath), 'only the explicit three-send continuation accepts existing evidence').toBe(resume);
  const checkpoint = resume ? JSON.parse(readFileSync(evidencePath, 'utf8')) : undefined;
  if (resume) expect(readFileSync(evidencePath, 'utf8')).toBe(readFileSync(resolve(directory, 'interrupted-after-3-sends.json'), 'utf8'));
  const pub = createPublicClient({ transport: http(rpc, { retryCount: 0 }), cacheTime: 0, pollingInterval: 25 });
  const wallet = createWalletClient({ account: creator, transport: http(rpc, { retryCount: 0 }) });
  const mutate = (method: string, params: unknown[]) => pub.transport.request({ method, params } as never);
  expect(await pub.getChainId()).toBe(31337);
  expect(execFileSync('ps', ['-p', String(node.pid), '-o', 'command='], { encoding: 'utf8' }).trim()).toBe(node.args.join(' '));
  const childInfo = await mutate('anvil_nodeInfo', []) as { environment: { chainId: number }; forkConfig: { forkUrl: string; forkBlockNumber: number } };
  expect(childInfo.environment.chainId).toBe(31337);
  expect(childInfo.forkConfig.forkUrl).toBe(node.parentRpc);
  expect(childInfo.forkConfig.forkBlockNumber).toBe(Number(node.parentPinnedBlock));
  const head = await pub.getBlock();
  const initial = resume ? await pub.getBlock({ blockNumber: BigInt(node.parentPinnedBlock) }) : head;
  expect(initial.number).toBe(BigInt(node.parentPinnedBlock));
  expect(initial.hash).toBe(node.parentPinnedHash);
  expect(initial.baseFeePerGas! * 2n + replacementFees.maxPriorityFeePerGas).toBeLessThan(replacementFees.maxFeePerGas);
  expect(await pub.getCode({ address: factory })).toBeTruthy();
  expect(await pub.getCode({ address: creator })).toBeUndefined();
  let initialBalance: bigint;
  let walletSetup;
  let records: EvidenceRecord[] = [];
  let sent = 0, deposited = 0n, gasSpent = 0n;
  if (resume) {
    expect(checkpoint.node).toEqual(node);
    expect(checkpoint.sent).toBe(3);
    expect(checkpoint.records).toHaveLength(3);
    expect(checkpoint.deposited).toBe('25000000000000000');
    expect(checkpoint.initialBalance).toBe('200000000000000000');
    expect(checkpoint.initialBlock).toBe(node.parentPinnedBlock);
    expect(checkpoint.walletSetup).toEqual(JSON.parse(readFileSync(resolve(directory, 'wallet-setup.json'), 'utf8')));
    expect(checkpoint.walletSetup.actor).toBe(creator);
    expect(checkpoint.walletSetup.fundedBalance).toBe('200000000000000000');
    expect(checkpoint.walletSetup.transactions).toBe(0);
    records = checkpoint.records;
    for (const record of records) {
      expect(record.replacementHash).toBeUndefined();
      expect(record.outcome).toBeUndefined();
      expect(record.liveRemembered).toBeUndefined();
    }
    const setupHashes: Hash[] = ['0x49144271825209b129d2081b12c865f4bec886a4daa2de0e1b4ffde5004bc223', '0x0ba803923874b7e98cbbf025ac42af58b20231236b3c190a7c2f75905949cba4'];
    for (const [index, hash] of setupHashes.entries()) {
      const recorded = records[index].receipt!;
      expect(recorded.transactionHash).toBe(hash);
      const receipt = await pub.getTransactionReceipt({ hash });
      expect(receipt.status).toBe('success');
      expect(receipt.blockHash).toBe(recorded.blockHash);
      expect(String(receipt.blockNumber)).toBe(String(recorded.blockNumber));
      expect(String(receipt.gasUsed)).toBe(String(recorded.gasUsed));
      expect(String(receipt.effectiveGasPrice)).toBe(String(recorded.effectiveGasPrice));
      expect((await pub.getBlock({ blockNumber: receipt.blockNumber })).hash).toBe(receipt.blockHash);
      const tx = await pub.getTransaction({ hash });
      expect(tx.nonce).toBe(index);
      expect(tx.from.toLowerCase()).toBe(creator.toLowerCase());
      expect(tx.to?.toLowerCase()).toBe(nft.toLowerCase());
      expect(tx.value).toBe(0n);
      expect(tx.input).toBe(encodeFunctionData({ abi: nftAbi, functionName: index === 0 ? 'mint' : 'approve', args: [index === 0 ? creator : records[2].original!.predicted, tokenId] }));
      gasSpent += receipt.gasUsed * receipt.effectiveGasPrice;
      records[index].receipt = receipt;
    }
    expect(head.number).toBe(26382401n);
    expect(head.hash).toBe(records[1].receipt!.blockHash);
    expect(await pub.getTransactionCount({ address: creator, blockTag: 'latest' })).toBe(2);
    expect(await pub.getTransactionCount({ address: creator, blockTag: 'pending' })).toBe(3);
    expect(String(gasSpent)).toBe(checkpoint.gasSpent);
    initialBalance = BigInt(checkpoint.initialBalance);
    expect(await pub.getBalance({ address: creator })).toBe(initialBalance - gasSpent);
    walletSetup = checkpoint.walletSetup;
    sent = 3; deposited = BigInt(checkpoint.deposited);
    const a = records[2].original!;
    expect(records[2].latest).toEqual(a);
    expect(records[2].receipt).toBeUndefined();
    expect(a.hash).toBe('0x14ae07df20e17dc3b3c6f9c131687518248418f5b2607e031825b3af94c4f255');
    expect(records[2].originalHash).toBe(a.hash);
    expect(a.nonce).toBe(2);
    expect(a.fromBlock).toBe('26382401');
    expect(a.submittedHash).toBe(a.hash);
    expect(await pub.getCode({ address: a.predicted })).toBeUndefined();
    expect(await pub.readContract({ address: factory, abi: balancerFactoryAbi, functionName: 'isBalancer', args: [a.predicted] })).toBe(false);
    expect((await pub.readContract({ address: nft, abi: nftAbi, functionName: 'ownerOf', args: [tokenId] })).toLowerCase()).toBe(creator.toLowerCase());
    expect(await recoverCreation(pub, a, context)).toBe('pending');
  } else {
    expect(await pub.getTransactionCount({ address: creator, blockTag: 'latest' })).toBe(0);
    expect(await pub.getTransactionCount({ address: creator, blockTag: 'pending' })).toBe(0);
    expect(await pub.getBalance({ address: creator })).toBe(0n);
    // Funding this external test actor does not replace or modify any protocol state.
    await mutate('anvil_setBalance', [creator, `0x${parseEther('0.2').toString(16)}`]);
    await mutate('anvil_impersonateAccount', [creator]);
    initialBalance = await pub.getBalance({ address: creator });
    expect(initialBalance).toBe(parseEther('0.2'));
    walletSetup = { actor: creator, priorCode: '0x', priorNonce: 0, priorBalance: '0', fundedBalance: String(initialBalance), nodeMethods: ['anvil_setBalance', 'anvil_impersonateAccount'], childInfo, transactions: 0 };
    writeFileSync(resolve(directory, 'wallet-setup.json'), json(walletSetup));
    await mutate('evm_setAutomine', [false]);
  }
  const save = () => writeFileSync(evidencePath, json({ scope: 'Owned isolated child only; actual protocol contracts, no successful RPC fixtures', node, walletSetup, initialBlock: initial.number, initialBaseFeePerGas: initial.baseFeePerGas, initialBalance, sent, deposited, gasSpent, records }));

  async function send(to: Address, data: Hash, value: bigint, nonce: number, repriced = false) {
    expect(sent + 1).toBeLessThanOrEqual(11);
    expect(deposited + value).toBeLessThanOrEqual(depositBudget);
    // Bound every submitted gas limit at the highest bid, including transactions later replaced.
    expect(BigInt(sent + 1) * gas * replacementFees.maxFeePerGas).toBeLessThanOrEqual(gasBudget);
    expect(await pub.getChainId()).toBe(31337);
    expect(await pub.getBlockNumber({ cacheTime: 0 })).toBeGreaterThanOrEqual(BigInt(node.parentPinnedBlock));
    const hash = await wallet.sendTransaction({ account: creator, to, data, value, nonce, gas, ...(repriced ? replacementFees : fees), chain: null });
    sent++; deposited += value; save();
    const actual = await pub.getTransaction({ hash });
    expect(actual.from.toLowerCase()).toBe(creator.toLowerCase());
    expect(actual.to?.toLowerCase()).toBe(to.toLowerCase());
    expect(actual.input).toBe(data);
    expect(actual.value).toBe(value);
    expect(actual.nonce).toBe(nonce);
    expect(actual.blockNumber).toBeNull();
    return hash;
  }
  async function mine(hash: Hash) {
    await mutate('evm_mine', []);
    const receipt = await pub.getTransactionReceipt({ hash });
    expect(receipt.from.toLowerCase()).toBe(creator.toLowerCase());
    expect(receipt.effectiveGasPrice).toBeGreaterThan(0n);
    gasSpent += receipt.gasUsed * receipt.effectiveGasPrice;
    expect(gasSpent).toBeLessThan(gasBudget);
    save();
    return receipt;
  }
  async function original(index: number, valid: boolean, label: string) {
    const salt = `0x${(0x7265706c61636500n + BigInt(index)).toString(16).padStart(64, '0')}` as Hash;
    const predicted = await pub.readContract({ address: factory, abi: balancerFactoryAbi, functionName: 'predictBalancer', args: [creator, salt] });
    expect(await pub.readContract({ address: factory, abi: balancerFactoryAbi, functionName: 'isBalancer', args: [predicted] })).toBe(false);
    const settingsHash = await pub.readContract({ address: factory, abi: balancerFactoryAbi, functionName: 'creationSettingsHash' });
    const config = { markupBps: 2500, creatorRevenueBps: valid ? 1234 : 10001, target: 1n, mintFeeCap: 1_000_000_000_000_000n, curatedRequired: false, settingsHash };
    const value = valid ? parseEther('0.025') : 0n;
    if (valid) {
      expect(await pub.getCode({ address: nft })).toBeTruthy();
      if (index === 1) {
        await expect(pub.readContract({ address: nft, abi: nftAbi, functionName: 'ownerOf', args: [tokenId] })).rejects.toThrow();
        const mintHash = await send(nft, encodeFunctionData({ abi: nftAbi, functionName: 'mint', args: [creator, tokenId] }), 0n, await pub.getTransactionCount({ address: creator }));
        const receipt = await mine(mintHash);
        expect(receipt.status).toBe('success');
        records.push({ label: 'mint one real DemoNFT for both valid original transactions', receipt }); save();
      }
      expect((await pub.readContract({ address: nft, abi: nftAbi, functionName: 'ownerOf', args: [tokenId] })).toLowerCase()).toBe(creator.toLowerCase());
      const approveHash = await send(nft, encodeFunctionData({ abi: nftAbi, functionName: 'approve', args: [predicted, tokenId] }), 0n, await pub.getTransactionCount({ address: creator }));
      const receipt = await mine(approveHash);
      expect(receipt.status).toBe('success');
      records.push({ label: `approve real NFT for ${label}`, receipt }); save();
    }
    const curated = valid ? [{ collection: nft, tokenId, base: parseEther('0.01') }] : [];
    const data = encodeFunctionData({ abi: balancerFactoryAbi, functionName: 'createBalancer', args: [salt, config, curated] });
    expect(decodeFunctionData({ abi: balancerFactoryAbi, data }).functionName).toBe('createBalancer');
    if (valid) await pub.call({ account: creator, to: factory, data, value, gas, ...fees });
    else {
      const failure = await pub.call({ account: creator, to: factory, data, value, gas, ...fees }).then(() => undefined, error => error);
      expect(failure).toBeInstanceOf(BaseError);
      if (!(failure instanceof BaseError)) throw new Error('negative preflight did not return a viem error');
      const cause = failure.walk(error => error instanceof Error && 'data' in error && isHex(error.data));
      if (!(cause instanceof Error) || !('data' in cause) || !isHex(cause.data)) throw new Error('negative preflight did not return actual revert data');
      expect(decodeErrorResult({ abi: poolBalancerAbi, data: cause.data }).errorName).toBe('InvalidConfig');
    }
    const nonce = await pub.getTransactionCount({ address: creator, blockTag: 'latest' });
    let saved: CreationAttempt | undefined;
    const a: CreationAttempt = { ...context, salt, predicted, config: { ...config, target: '1', mintFeeCap: String(config.mintFeeCap) }, curated: curated.map(n => ({ ...n, tokenId: String(n.tokenId), base: String(n.base) })), value: String(value) };
    const record: EvidenceRecord = { label };
    records.push(record); save();
    const hash = await submitCreation(a, async beforeWallet => { beforeWallet(); return send(factory, data, value, nonce); }, {
      existing: () => saved,
      store: next => { saved = next; record.latest = next; save(); },
      reject: () => { throw new Error('real local submission must not be classified as wallet rejection'); },
    }, pub);
    expect(saved?.hash).toBe(hash);
    expect(saved?.nonce).toBe(nonce);
    expect(saved?.fromBlock).toBeDefined();
    const frozen = JSON.parse(JSON.stringify(saved)) as CreationAttempt;
    record.original = frozen; record.originalHash = hash; save();
    expect(await recoverCreation(pub, frozen, context)).toBe('pending');
    return { a: frozen, record, data, nonce, value };
  }
  async function reload(a: CreationAttempt, expected: string) {
    let restored = JSON.parse(JSON.stringify(a)) as CreationAttempt;
    expect(await recoverCreation(pub, restored, context, next => { restored = next; })).toBe(expected);
    expect(canRetryCreation(expected as never, restored, context)).toBe(expected !== 'confirmed');
    for (const other of [{ ...context, chainId: 1 }, { ...context, creator: factory }, { ...context, factory: creator }]) {
      expect(await recoverCreation(pub, restored, other)).toBe('context');
      expect(canRetryCreation(expected as never, restored, other)).toBe(false);
    }
    return restored;
  }

  for (const [index, label, valid, kind] of [
    [1, 'mined cancellation with live callback and reload', true, 'cancel'],
    [2, 'same-calldata repriced real revert with live callback and reload', false, 'revert'],
    [3, 'unrelated replacement after actual wait timeout', false, 'late'],
    [4, 'same-calldata repriced successful atomic creation', true, 'success'],
  ] as const) {
    const item = resume && index === 1 ? await (async () => {
      const record = records[2], a = record.original!;
      expect(a.chainId).toBe(context.chainId);
      expect(a.creator).toBe(creator);
      expect(a.factory).toBe(factory);
      expect(a.salt).toBe('0x0000000000000000000000000000000000000000000000007265706c61636501');
      expect(a.config).toEqual({ markupBps: 2500, creatorRevenueBps: 1234, target: '1', mintFeeCap: '1000000000000000' });
      expect(a.curated).toEqual([{ collection: nft, tokenId: String(tokenId), base: '10000000000000000' }]);
      expect(a.value).toBe('25000000000000000');
      expect(await pub.readContract({ address: factory, abi: balancerFactoryAbi, functionName: 'predictBalancer', args: [creator, a.salt] })).toBe(a.predicted);
      const data = encodeFunctionData({ abi: balancerFactoryAbi, functionName: 'createBalancer', args: [a.salt, { ...a.config, target: BigInt(a.config.target), mintFeeCap: BigInt(a.config.mintFeeCap), curatedRequired: !!a.config.curatedRequired, settingsHash: a.config.settingsHash ?? zeroHash }, a.curated.map(n => ({ ...n, tokenId: BigInt(n.tokenId), base: BigInt(n.base) }))] });
      const tx = await pub.getTransaction({ hash: a.hash! });
      expect(tx.hash).toBe(a.hash);
      expect(tx.from.toLowerCase()).toBe(creator.toLowerCase());
      expect(tx.to?.toLowerCase()).toBe(factory.toLowerCase());
      expect(tx.nonce).toBe(2);
      expect(tx.input).toBe(data);
      expect(tx.value).toBe(BigInt(a.value));
      expect(tx.blockNumber).toBeNull();
      expect(await recoverCreation(pub, a, context)).toBe('pending');
      return { a, record, data, nonce: 2, value: BigInt(a.value) };
    })() : await original(index, valid, label);
    let latest = item.a;
    const remembered: CreationAttempt[] = [];
    const remember = (next: CreationAttempt) => { latest = next; remembered.push(next); item.record.latest = next; item.record.liveRemembered = remembered; save(); };
    let observedOriginal: () => void = () => {};
    const originalRead = new Promise<void>(resolve => { observedOriginal = resolve; });
    const observed = createPublicClient({ cacheTime: 0, pollingInterval: 25, transport: custom({ request: async request => {
      const result = await pub.transport.request(request);
      if (request.method === 'eth_getTransactionByHash' && request.params?.[0] === item.a.hash) observedOriginal();
      return result;
    } }, { retryCount: 0 }) });
    let waiting: Promise<unknown> | undefined;
    if (kind === 'late') {
      await expect(waitForCreation(observed, latest, context, remember, 100)).rejects.toThrow();
      expect(canRetryCreation('unknown', latest, context)).toBe(false);
    } else {
      waiting = waitForCreation(observed, latest, context, remember, 4000);
      // The actual waiter must have obtained the original transaction before its nonce is replaced.
      await Promise.race([originalRead, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('waiter never read original transaction')), 2000))]);
    }
    const replacementHash = await send(kind === 'cancel' || kind === 'late' ? creator : factory,
      kind === 'cancel' ? '0x' : kind === 'late' ? '0x1234' : item.data,
      kind === 'success' ? item.value : 0n, item.nonce, true);
    item.record.replacementHash = replacementHash; save();
    const receipt = await mine(replacementHash);
    item.record.receipt = receipt;
    expect(receipt.status).toBe(kind === 'revert' ? 'reverted' : 'success');
    const expected = kind === 'cancel' ? 'cancelled' : kind === 'late' ? 'replaced' : kind === 'revert' ? 'reverted' : 'confirmed';
    if (waiting) {
      expect(await waiting).toBe(expected);
      expect(remembered.some(a => a.hash === replacementHash)).toBe(true);
      expect(latest.hash).toBe(replacementHash);
      expect(latest.submittedHash).toBe(item.a.hash);
    }
    latest = await reload(latest, expected);
    expect(latest.hash).toBe(replacementHash);
    // Standard historical RPC remains usable even if a provider-specific sender/nonce method is unavailable.
    let nonstandardCalls = 0;
    const standard = createPublicClient({ cacheTime: 0, transport: custom({ request: request => {
      if (request.method === 'eth_getTransactionBySenderAndNonce') { nonstandardCalls++; throw new Error('method unavailable'); }
      return pub.transport.request(request);
    } }, { retryCount: 0 }) });
    expect(await recoverCreation(standard, JSON.parse(JSON.stringify(item.a)), context, remember)).toBe(expected);
    expect(nonstandardCalls).toBe(0);
    if (kind !== 'success') {
      expect(latest.hash).toBe(replacementHash);
      expect(latest.submittedHash).toBe(item.a.hash);
      expect(await pub.getCode({ address: item.a.predicted })).toBeUndefined();
      expect(await pub.readContract({ address: factory, abi: balancerFactoryAbi, functionName: 'isBalancer', args: [item.a.predicted] })).toBe(false);
      if (kind === 'cancel') {
        expect((await pub.readContract({ address: nft, abi: nftAbi, functionName: 'ownerOf', args: [tokenId] })).toLowerCase()).toBe(creator.toLowerCase());
        await expect(pub.getTransaction({ hash: item.a.hash! })).rejects.toThrow();
        const withoutNonce = JSON.parse(JSON.stringify(item.a)) as CreationAttempt;
        delete withoutNonce.nonce; delete withoutNonce.fromBlock; delete withoutNonce.submittedHash;
        expect(await recoverCreation(pub, withoutNonce, context)).toBe('unknown');
        expect(canRetryCreation('unknown', withoutNonce, context)).toBe(false);
      }
      // Failure injection supplies no successful transaction/block responses; a consumed nonce alone is insufficient.
      const unavailable = createPublicClient({ cacheTime: 0, transport: custom({ request: request => {
        if (['eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBlockByNumber'].includes(request.method)) throw new Error('historical transaction lookup unavailable');
        return pub.transport.request(request);
      } }, { retryCount: 0 }) });
      expect(await recoverCreation(unavailable, item.a, context)).toBe('unknown');
      // App owns draft clearing. This checks its terminal retry predicate and the submission boundary after clearing.
      let draft: CreationAttempt | undefined = latest;
      if (canRetryCreation(expected, latest, context)) draft = undefined;
      let reachedWallet = false;
      await expect(submitCreation(item.a, async beforeWallet => { beforeWallet(); reachedWallet = true; throw new UserRejectedRequestError(new Error('retry declined')); }, {
        existing: () => draft, store: a => { draft = a; }, reject: () => { draft = undefined; },
      })).rejects.toBeInstanceOf(UserRejectedRequestError);
      expect(reachedWallet).toBe(true);
      expect(draft).toBeUndefined();
    } else {
      expect(await pub.getBalance({ address: latest.predicted })).toBe(parseEther('0.025'));
      expect(await pub.readContract({ address: latest.predicted, abi: poolBalancerAbi, functionName: 'creatorRevenueBps' })).toBe(1234);
      const pool = await pub.readContract({ address: latest.predicted, abi: poolBalancerAbi, functionName: 'pool' });
      expect((await pub.readContract({ address: nft, abi: nftAbi, functionName: 'ownerOf', args: [tokenId] })).toLowerCase()).toBe(pool.toLowerCase());
      expect(canRetryCreation('confirmed', latest, context)).toBe(false);
    }
    item.record.outcome = expected; item.record.latest = latest; save();
  }
  const finalBalance = await pub.getBalance({ address: creator });
  expect(sent).toBe(11);
  expect(deposited).toBe(parseEther('0.075'));
  expect(initialBalance - finalBalance).toBe(gasSpent + parseEther('0.025'));
  writeFileSync(resolve(directory, 'scorecard.json'), json({ sent, submittedValues: deposited, actualPoolDeposit: parseEther('0.025'), gasSpent, initialBalance, finalBalance, balanceDelta: initialBalance - finalBalance, preservedParent: node.parentRpc, regimes: records.map(r => ({ label: r.label, outcome: r.outcome, originalHash: r.originalHash, replacementHash: r.replacementHash, actualValue: r.receipt?.status === 'success' && r.outcome === 'confirmed' ? parseEther('0.025') : 0n })) }));
}, 30_000);

it.skipIf(!rpc || !readback || broadcast)('times out on unavailable real replacement receipts and recovers the mined replacement after reload', async () => {
  expect(rpc).toBe('http://127.0.0.1:18795');
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
  expect(evidence.sent).toBe(11);
  const record = (evidence.records as EvidenceRecord[]).find(r => r.outcome === 'replaced');
  expect(record?.original).toBeDefined();
  expect(record?.replacementHash).toBeDefined();
  const original = record!.original!;
  expect(original.hash).toBe(record!.originalHash);
  expect(original.submittedHash).toBe(original.hash);
  expect(original.nonce).toBeDefined();
  const real = createPublicClient({ cacheTime: 0, pollingInterval: 25, transport: http(rpc, { retryCount: 0 }) });
  expect(await real.getChainId()).toBe(context.chainId);
  const receipt = await real.getTransactionReceipt({ hash: record!.replacementHash! });
  expect(receipt.status).toBe('success');
  const replacement = await real.getTransaction({ hash: receipt.transactionHash });
  expect(replacement.from.toLowerCase()).toBe(original.creator.toLowerCase());
  expect(replacement.nonce).toBe(original.nonce);
  expect(replacement.blockNumber).toBe(receipt.blockNumber);
  expect(receipt.blockNumber).toBeLessThanOrEqual(await real.getBlockNumber({ cacheTime: 0 }));

  let receiptCalls = 0;
  const unavailable = createPublicClient({ cacheTime: 0, pollingInterval: 25, transport: custom({ request: request => {
    if (request.method === 'eth_getTransactionReceipt') {
      receiptCalls++;
      return new Promise<never>(() => {});
    }
    // A receipt service failure is injected; every successful response comes unchanged from the real node.
    return real.transport.request(request);
  } }, { retryCount: 0 }) });
  let saved = JSON.parse(JSON.stringify(original)) as CreationAttempt;
  const remember = (next: CreationAttempt) => { saved = next; };
  await expect(waitForCreation(unavailable, saved, context, remember, 100)).rejects.toBeInstanceOf(WaitForTransactionReceiptTimeoutError);
  expect(receiptCalls).toBeGreaterThan(0);
  expect(saved).toEqual(original);
  expect(canRetryCreation('unknown', saved, context)).toBe(false);
  saved = JSON.parse(JSON.stringify(saved)) as CreationAttempt;
  expect(await recoverCreation(real, saved, context, remember)).toBe('replaced');
  expect(saved.hash).toBe(record!.replacementHash);
  expect(saved.submittedHash).toBe(original.hash);
  expect(saved.nonce).toBe(original.nonce);
  for (const other of [{ ...context, chainId: 1 }, { ...context, creator: factory }, { ...context, factory: creator }]) {
    expect(await recoverCreation(real, saved, other)).toBe('context');
    expect(canRetryCreation('replaced', saved, other)).toBe(false);
  }
  writeFileSync(resolve(directory, 'receipt-timeout-readback.json'), json({ scope: 'Read-only real-node replacement recovery; receipt-only external failure injection, no transactions', original, replacementHash: saved.hash, replacementBlock: receipt.blockNumber, receiptCalls, timeout: 100, requiredError: 'WaitForTransactionReceiptTimeoutError', recoveredOutcome: 'replaced', persisted: saved }));
});
