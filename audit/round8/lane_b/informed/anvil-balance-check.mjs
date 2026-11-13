// Local Anvil accounting diagnostic: direct self-transfer should cost only gas.
import { createPublicClient, createWalletClient, http, parseEther, parseGwei, toHex } from 'viem';
const transport = http('http://127.0.0.1:18547');
const pub = createPublicClient({ transport });
const a = (await pub.request({ method: 'eth_accounts' }))[1];
if ((await pub.getChainId()) !== 31337) throw new Error('not local fork');
const snapshot = await pub.request({ method: 'evm_snapshot', params: [] });
try {
  const before = await pub.getBalance({ address: a });
  await pub.request({ method: 'anvil_setNextBlockBaseFeePerGas', params: [toHex(parseGwei('1'))] });
  const wallet = createWalletClient({ transport, account: a, chain: null });
  const hash = await wallet.sendTransaction({ to: a, value: parseEther('0.01'), gas: 21_000n, maxFeePerGas: parseGwei('1.05'), maxPriorityFeePerGas: parseGwei('0.05') });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  const after = await pub.getBalance({ address: a });
  console.log(JSON.stringify({ actor: a, txHash: hash, status: receipt.status, before: String(before), after: String(after), actualDebit: String(before - after), expectedGasOnly: String(receipt.gasUsed * receipt.effectiveGasPrice), value: String(parseEther('0.01')) }, null, 2));
} finally {
  await pub.request({ method: 'evm_revert', params: [snapshot] });
}
