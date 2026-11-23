import assert from 'node:assert/strict';
import { createPublicClient, custom, http, numberToHex, parseEther, type Address, type Hash } from 'viem';
import { transferUnresolved } from '../../app/src/tx';

// Failure injection only: this read endpoint has not learned the wallet's pending hash.
// Its successful nonce answers come unchanged from the real local mainnet fork.
const url = 'http://127.0.0.1:19863';
const real = createPublicClient({ transport: http(url, { retryCount: 0 }), cacheTime: 0 });
const node = (method: string, params: unknown[]) => real.request({ method: method as never, params: params as never });
const info = await node('anvil_nodeInfo', []) as { forkConfig: { forkUrl: string; forkBlockNumber: number } };
assert.equal(info.forkConfig.forkUrl, 'https://mainnet.gateway.tenderly.co');
assert.equal(info.forkConfig.forkBlockNumber, 26382349);
const accounts = await node('eth_accounts', []) as Address[];
const from = accounts[0];
const recipient = '0x000000000000000000000000000000000000bEEF' as Address;
const recipientBefore = await real.getBalance({ address: recipient });
const initial = await real.getTransactionCount({ address: from, blockTag: 'pending' });
await node('evm_setAutomine', [false]);
const high = await node('eth_sendTransaction', [{ from, to: recipient, value: numberToHex(parseEther('0.2356')),
  nonce: numberToHex(initial + 2), gas: numberToHex(21_000), maxFeePerGas: numberToHex(2_000_000_000), maxPriorityFeePerGas: numberToHex(100_000_000) }]) as Hash;
const low = await node('eth_sendTransaction', [{ from, to: recipient, value: '0x0', nonce: numberToHex(initial),
  gas: numberToHex(21_000), maxFeePerGas: numberToHex(2_000_000_000), maxPriorityFeePerGas: numberToHex(100_000_000) }]) as Hash;
await node('evm_mine', []);
assert.equal((await real.getTransactionReceipt({ hash: low })).status, 'success');
const highTx = await real.getTransaction({ hash: high });
assert.equal(highTx.blockNumber, null, '0.2356 ETH transfer remains pending on wallet node');
const confirmed = await real.getTransactionCount({ address: from, blockTag: 'latest' });
assert.equal(confirmed, initial + 1, 'unrelated lower nonce is confirmed');
const pending = { hash: high, chainId: 1, from, to: recipient, nonce: initial };
assert.equal(await transferUnresolved(real, pending), true, 'wallet node still knows hash and real higher nonce');
const lagging = createPublicClient({ transport: custom({ request: async (request) => {
  if (request.method === 'eth_getTransactionByHash' && request.params?.[0] === high) return null;
  return real.transport.request(request as never);
} }, { retryCount: 0 }), cacheTime: 0 });
assert.equal(await transferUnresolved(lagging, pending), false,
  'read endpoint missing hash clears guard using earlier lower nonce while transfer is pending');
const duplicate = await node('eth_sendTransaction', [{ from, to: recipient, value: numberToHex(parseEther('0.2356')),
  nonce: numberToHex(initial + 1), gas: numberToHex(21_000), maxFeePerGas: numberToHex(2_000_000_000),
  maxPriorityFeePerGas: numberToHex(100_000_000) }]) as Hash;
await node('evm_mine', []);
assert.equal((await real.getTransactionReceipt({ hash: high })).status, 'success');
assert.equal((await real.getTransactionReceipt({ hash: duplicate })).status, 'success');
const recipientGain = (await real.getBalance({ address: recipient })) - recipientBefore;
assert.equal(recipientGain, parseEther('0.4712'), 'both contributions settle to the same recipient');
console.log(JSON.stringify({ forkBlock: info.forkConfig.forkBlockNumber, pendingWei: parseEther('0.2356').toString(),
  recordedNonce: initial, actualPendingNonce: highTx.nonce, confirmedNonce: confirmed, pendingHash: high,
  walletNodeUnresolved: true, laggingReadNodeUnresolved: false, duplicateHash: duplicate,
  recipientGainWei: recipientGain.toString() }));
