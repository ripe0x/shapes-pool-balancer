// Bounded read-only corpus acquisition. No wallet, test client, protocol mutation or broadcast capability.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, http, keccak256, parseAbi, parseAbiItem, type Hash } from 'viem';

const RPC = 'https://mainnet.gateway.tenderly.co';
const SERVICE = '0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d' as const;
const ANCHOR = '0x2d9d2a85771c6ea346a6ed9e581fe5c5c1f5aefb770f669effcee35e254f8283' as Hash;
const OUT = 'test/fixtures/authentic-vrf-proofs.json';
const REQUEST = parseAbiItem('event RandomnessRequested(uint256 indexed requestId,address indexed pool)');
const STORED = parseAbiItem('event RandomnessStored(uint256 indexed requestId,address indexed pool,uint256 word,bool hasWord)');
const LIMITS = { targetRequests: 6, maximumBlocks: 65536, chunkBlocks: 4096, fulfillmentLookaheadBlocks: 128, maximumRpcCalls: 80, maximumElapsedMs: 120000 };
const base = createPublicClient({ transport: http(RPC, { retryCount: 0, timeout: 15000 }), cacheTime: 0 });
const started = Date.now();
let calls = 0;
let queue = Promise.resolve();
async function rpc<T>(action: () => Promise<T>): Promise<T> {
  queue = queue.then(() => new Promise<void>(resolve => setTimeout(resolve, 300)));
  await queue;
  for (let attempt = 0; ; attempt++) {
    assert.ok(++calls <= LIMITS.maximumRpcCalls, 'bounded RPC call count');
    assert.ok(Date.now() - started < LIMITS.maximumElapsedMs, 'bounded collection elapsed time');
    try { return await action(); }
    catch (error) {
      const message = String(error);
      if (attempt !== 0 || !/429|rate limit/i.test(message)) throw error;
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }
}
const stringify = (v: unknown) => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? String(x) : x, 2);

async function main() {
  assert.equal(process.argv.length, 2, 'fixed read-only collection; no argument overrides');
  assert.equal(await rpc(() => base.getChainId()), 1);
  const anchor = await rpc(() => base.getTransaction({ hash: ANCHOR }));
  assert.ok(anchor.blockNumber !== null && anchor.transactionIndex !== null);
  const start = anchor.blockNumber;
  const head = await rpc(() => base.getBlockNumber());
  const coordinator = await rpc(() => base.readContract({ address: SERVICE,
    abi: parseAbi(['function coordinator() view returns(address)']), functionName: 'coordinator', blockNumber: start }));
  const checkpoint = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : undefined;
  const resumed = checkpoint?.complete === false && checkpoint?.anchorTransactionHash === ANCHOR && Array.isArray(checkpoint?.requestLogs);
  const requests: any[] = resumed ? checkpoint.requestLogs.map((r: any) => ({ ...r, blockNumber: BigInt(r.blockNumber),
    args: { ...r.args, requestId: BigInt(r.args.requestId) } })) : [];
  let scannedThrough = resumed ? BigInt(checkpoint.scannedThroughBlock) : start - 1n;
  const scanOffset = Number(scannedThrough + 1n - start);
  for (let offset = scanOffset; offset < LIMITS.maximumBlocks && requests.length < LIMITS.targetRequests; offset += LIMITS.chunkBlocks) {
    const fromBlock = start + BigInt(offset);
    if (fromBlock > head) break;
    const limit = fromBlock + BigInt(LIMITS.chunkBlocks - 1);
    const toBlock = limit < head ? limit : head;
    const found = await rpc(() => base.getLogs({ address: SERVICE, event: REQUEST, fromBlock, toBlock }));
    for (const log of found) {
      if (log.blockNumber === start && log.transactionIndex < anchor.transactionIndex) continue;
      requests.push(log);
      if (requests.length === LIMITS.targetRequests) break;
    }
    scannedThrough = toBlock;
    writeFileSync(OUT, stringify({ schema: 'authentic-vrf-proof-corpus-v1', complete: false, anchorTransactionHash: ANCHOR,
      scannedFromBlock: start, scannedThroughBlock: scannedThrough, requestCount: requests.length, rpcCalls: calls,
      requestLogs: requests, limitations: ['collection in progress; no proof acceptance claim'] }) + '\n');
  }
  assert.ok(requests.length >= 1, 'bounded canonical service request prefix exists');
  assert.equal(requests[0].transactionHash, ANCHOR);
  assert.equal(new Set(requests.map(r => String(r.args.requestId))).size, requests.length, 'distinct ordered request IDs');
  const lastRequest = requests.at(-1)!;
  const stored = await rpc(() => base.getLogs({ address: SERVICE, event: STORED,
    args: { requestId: requests.map(r => r.args.requestId!) }, fromBlock: start,
    toBlock: lastRequest.blockNumber! + BigInt(LIMITS.fulfillmentLookaheadBlocks) }));
  const hashes = [...new Set([...requests.map(r => r.transactionHash), ...stored.map(r => r.transactionHash)])];
  const transactions: Record<string, any> = {};
  const blocks: Record<string, any> = {};
  for (let i = 0; i < hashes.length; i += 4) {
    const batch = await Promise.all(hashes.slice(i, i + 4).map(hash => rpc(() => base.getTransaction({ hash }))));
    for (const tx of batch) {
      assert.ok(tx.blockNumber !== null && tx.blockHash !== null);
      transactions[tx.hash] = { hash: tx.hash, from: tx.from, to: tx.to, input: tx.input, value: tx.value,
        gas: tx.gas, gasPrice: tx.gasPrice, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
        blockNumber: tx.blockNumber, blockHash: tx.blockHash, transactionIndex: tx.transactionIndex };
    }
  }
  const blockNumbers = [...new Set([start, ...Object.values(transactions).map(t => t.blockNumber as bigint)])];
  for (let i = 0; i < blockNumbers.length; i += 4) {
    const batch = await Promise.all(blockNumbers.slice(i, i + 4).map(blockNumber => rpc(() => base.getBlock({ blockNumber }))));
    for (const block of batch) blocks[String(block.number)] = { number: block.number, hash: block.hash,
      timestamp: block.timestamp, baseFeePerGas: block.baseFeePerGas, parentHash: block.parentHash };
  }
  for (const tx of Object.values(transactions)) assert.equal(blocks[String(tx.blockNumber)].hash, tx.blockHash, 'canonical transaction block');
  const entries = requests.map((request, index) => {
    if (index) assert.ok(request.blockNumber! > requests[index - 1].blockNumber!
      || request.blockNumber === requests[index - 1].blockNumber && request.logIndex > requests[index - 1].logIndex, 'canonical request ordering');
    const fulfilled = stored.filter(s => s.args.requestId === request.args.requestId);
    assert.equal(fulfilled.length, 1, 'each prefix request has exactly one authentic stored randomness event');
    const event = fulfilled[0];
    assert.ok(event.transactionHash, "canonical fulfillment transaction hash");
    assert.equal(event.args.hasWord, true, 'actual nonempty randomness callback');
    assert.equal(event.args.pool?.toLowerCase(), request.args.pool?.toLowerCase());
    assert.ok(event.blockNumber! >= request.blockNumber!);
    return { index, requestId: request.args.requestId, pool: request.args.pool,
      requestTx: request.transactionHash, requestTransactionHash: request.transactionHash, requestBlock: request.blockNumber, requestBlockHash: request.blockHash,
      requestLogIndex: request.logIndex, fulfillmentTx: event.transactionHash, fulfillmentTransactionHash: event.transactionHash,
      input: transactions[event.transactionHash].input,
      fulfillmentBlock: event.blockNumber, fulfillmentBlockHash: event.blockHash,
      fulfillmentLogIndex: event.logIndex, word: event.args.word, hasWord: true };
  });
  const purchaseBatches = [...new Set(entries.map(e => e.requestTransactionHash))];
  const targetReached = requests.length >= LIMITS.targetRequests && purchaseBatches.length >= 2;
  const serviceCode = await rpc(() => base.getCode({ address: SERVICE, blockNumber: start }));
  const coordinatorCode = await rpc(() => base.getCode({ address: coordinator, blockNumber: start }));
  const source = 'audit/release-04bc760-interrupted/b/verified-VRFService.sol.txt';
  const corpus = { schema: 'authentic-vrf-proof-corpus-v1', complete: true, rpc: RPC, chainId: 1, collectedAt: new Date().toISOString(),
    limits: LIMITS, rpcCalls: calls, elapsedMs: Date.now() - started, service: SERVICE, coordinator,
    serviceCodeHash: keccak256(serviceCode!), coordinatorCodeHash: keccak256(coordinatorCode!),
    serviceSource: source, serviceSourceSha256: createHash('sha256').update(readFileSync(source)).digest('hex'),
    sourceToRuntimeCorrespondence: 'not established by collector; code hashes and exact canonical event/transaction data captured',
    anchorTransactionHash: ANCHOR, forkBeforeAnchorTransaction: ANCHOR, scannedFromBlock: start, scannedThroughBlock: scannedThrough,
    targetReached, requestCount: entries.length, purchaseBatchCount: purchaseBatches.length, entries, transactions, blocks,
    collectionAttempts: ['4096-block scan found fewer than6', 'expanded scan hit Tenderly429; no alternate RPC used', 'paced scan through actual head found only3 service requests; canonical checkpoint reused without rescan'],
    limitations: ['contiguous service request prefix only, not the 180-draw/28-regime campaign',
      'historical canonical metadata/proofs do not establish current oracle availability',
      'collector verifies recorded events and canonical blocks; candidate proof acceptance requires execution'] };
  writeFileSync(OUT, stringify(corpus) + '\n');
  console.log(stringify({ output: OUT, targetReached, requestCount: entries.length, purchaseBatchCount: purchaseBatches.length,
    rpcCalls: calls, elapsedMs: Date.now() - started, firstBlock: start, lastRequestBlock: lastRequest.blockNumber,
    fulfillmentTransactions: [...new Set(entries.map(e => e.fulfillmentTransactionHash))] }));
}
async function collectPrevious() {
  assert.equal(process.argv.length, 3);
  const corpus = JSON.parse(readFileSync(OUT, 'utf8'));
  const requestId = 107220125894382930235884166813798674911115236089907205895420064519421068854620n;
  const requestHash = '0x426bee17b87a3da5b8c9478857003dc3220896bbf8ea5540e566fd0b57e81c4e' as Hash;
  const request = await rpc(() => base.getTransaction({ hash: requestHash }));
  assert.equal(request.blockNumber, 26442101n);
  const requestReceipt = await rpc(() => base.getTransactionReceipt({ hash: requestHash }));
  assert.equal(requestReceipt.status, 'success');
  const requested = await rpc(() => base.getLogs({ address: SERVICE, event: REQUEST, args: { requestId }, fromBlock: 26442101n, toBlock: 26442101n }));
  assert.equal(requested.length, 1); assert.equal(requested[0].transactionHash, requestHash);
  const logs = await rpc(() => base.getLogs({ address: SERVICE, event: STORED, args: { requestId }, fromBlock: 26442101n, toBlock: 26442229n }));
  assert.equal(logs.length, 1); assert.equal(logs[0].args.hasWord, true);
  const stored = logs[0];
  const proof = await rpc(() => base.getTransaction({ hash: stored.transactionHash! }));
  const proofReceipt = await rpc(() => base.getTransactionReceipt({ hash: stored.transactionHash! }));
  assert.equal(proofReceipt.status, 'success');
  assert.equal(proof.to?.toLowerCase(), corpus.coordinator.toLowerCase());
  for (const tx of [request, proof]) {
    assert.ok(tx.blockNumber !== null);
    const b = await rpc(() => base.getBlock({ blockNumber: tx.blockNumber! }));
    assert.equal(b.hash, tx.blockHash);
    corpus.blocks[String(b.number)] = { number: b.number, hash: b.hash, timestamp: b.timestamp, baseFeePerGas: b.baseFeePerGas, parentHash: b.parentHash };
    corpus.transactions[tx.hash] = { hash: tx.hash, from: tx.from, to: tx.to, input: tx.input, value: tx.value,
      gas: tx.gas, gasPrice: tx.gasPrice, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      blockNumber: tx.blockNumber, blockHash: tx.blockHash, transactionIndex: tx.transactionIndex };
  }
  corpus.previousEntries = [{ index: -1, requestId, pool: requested[0].args.pool,
    requestTx: requestHash, requestTransactionHash: requestHash, requestBlock: request.blockNumber, requestBlockHash: request.blockHash,
    requestLogIndex: requested[0].logIndex, fulfillmentTx: proof.hash, fulfillmentTransactionHash: proof.hash,
    fulfillmentBlock: proof.blockNumber, fulfillmentBlockHash: proof.blockHash, fulfillmentLogIndex: stored.logIndex,
    input: proof.input, word: stored.args.word, hasWord: true }];
  corpus.previousCollection = { rpcCalls: calls, elapsedMs: Date.now() - started, maximumRpcCalls: 10,
    limitation: 'nearest preceding singleton only; not the full 836-request historical corpus' };
  assert.ok(calls <= 10);
  writeFileSync(OUT, stringify(corpus) + '\n');
  console.log(stringify({ previous: corpus.previousEntries[0], rpcCalls: calls, mainEntriesUnchanged: corpus.entries.length }));
}
(process.argv[2] === '--previous-only' ? collectPrevious() : main()).catch(error => { console.error(error); process.exitCode = 1; });
