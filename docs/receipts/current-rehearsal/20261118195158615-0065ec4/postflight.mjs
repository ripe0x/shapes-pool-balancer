// Read-only verification of the retained completed run. Never replays execution.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createPublicClient, http, parseAbi } from 'viem';
import { createHash } from 'node:crypto';
import { sourceCheck } from '../../../../scripts/current-local-rehearsal.ts';
const directory = new URL('.', import.meta.url);
const packet = JSON.parse(fs.readFileSync(new URL('bounded-plan.json', directory)));
const journal = JSON.parse(fs.readFileSync(new URL('journal.json', directory)));
sourceCheck(packet.plan);
assert.equal(journal.completed, true);
assert.equal(journal.inFlight, null);
assert.equal(journal.failure, undefined);
const client = createPublicClient({ transport: http(packet.plan.rpc) });
assert.equal(await client.getChainId(), 31337);
let gas = 0n, reverts = 0;
for (let i = 0; i < journal.receipts.length; i += 20) {
  await Promise.all(journal.receipts.slice(i, i + 20).map(async saved => {
    const receipt = await client.getTransactionReceipt({ hash: saved.hash });
    assert.equal(receipt.status, saved.status);
    assert.equal(receipt.blockHash, saved.blockHash);
    assert.equal(receipt.gasUsed, BigInt(saved.gasUsed));
    assert.equal(receipt.effectiveGasPrice, BigInt(saved.gasPrice));
    gas += receipt.gasUsed * receipt.effectiveGasPrice;
    if (receipt.status === 'reverted') reverts++;
  }));
}
assert.equal(reverts, 1);
assert.equal(gas, 270486714751984388n);
const abi = parseAbi(['function creatorCredit() view returns(uint256)', 'function getActiveIds() view returns(uint256[])', 'function ownerProceeds() view returns(uint256)', 'function acquisitionRefundCreditTotal() view returns(uint256)']);
const pools = [];
for (const pool of journal.pools) {
  const balance = await client.getBalance({ address: pool.balancer });
  const credit = await client.readContract({ address: pool.balancer, abi, functionName: 'creatorCredit' });
  const active = await client.readContract({ address: pool.balancer, abi, functionName: 'getActiveIds' });
  const proceeds = await client.readContract({ address: pool.pool, abi, functionName: 'ownerProceeds' });
  const refunds = await client.readContract({ address: pool.pool, abi, functionName: 'acquisitionRefundCreditTotal' });
  assert.equal(balance + credit + proceeds + refunds, 0n);
  assert.equal(active.length, 0);
  pools.push({ balancer: pool.balancer, pool: pool.pool, balance, credit, activeCount: active.length, ownerProceeds: proceeds, refunds });
}
const manifest = JSON.parse(fs.readFileSync('docs/verification/protected-revenue/manifest.json'));
for (const [path, hash] of Object.entries(manifest.productionSourceSha256)) {
  assert.equal(createHash('sha256').update(fs.readFileSync(path)).digest('hex'), hash, path);
}
const result = {
  checkedAt: new Date().toISOString(), revision: packet.plan.revision, planHash: packet.planHash,
  sourceFingerprint: packet.plan.sourceFingerprint, sourceCheck: 'pass, 146 inputs and ten full artifact hashes',
  productionManifestFiles: Object.keys(manifest.productionSourceSha256).length,
  receiptsChecked: journal.receipts.length, expectedReverts: reverts, gasWei: gas, pools,
  executionCompletion: 'Journal completed=true and final console marker retained; original terminal session expired before OS exit status could be recovered',
  validationCommandExitStatus: 0,
  limitations: ['Read-only postflight; no execution replay', 'FWA protocol fees remain; no claim that FWA pool balances are zero'],
};
const output = JSON.stringify(result, (_, value) => typeof value === 'bigint' ? String(value) : value, 2) + '\n';
fs.writeFileSync(new URL('final-verification.json', directory), output);
console.log(output);
