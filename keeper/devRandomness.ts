// Local fork only: plays Chainlink for FWA's randomness service, which never answers on a fork. Every few seconds it
// finds draws still waiting for a word (status Pending) in each Balancer's pool and delivers one through the real
// service, impersonating its coordinator, as `keeper/rehearsal.ts` does. Words are keccak(requestId, block): not
// random, only distinct.
// Run: RPC_URL=http://127.0.0.1:8545 FACTORY=0x.. FROM_BLOCK=<n> npx tsx keeper/devRandomness.ts
import { createPublicClient, createTestClient, createWalletClient, encodePacked, http, keccak256, parseAbi, parseAbiItem, type Address } from 'viem';
import { fwaPoolAbi } from '../shared/abi';

const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
const FACTORY = process.env.FACTORY as Address;
const FROM_BLOCK = BigInt(process.env.FROM_BLOCK ?? 0);
const VRF_SERVICE = '0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d' as const;
const PENDING = 1;
const CREATED = parseAbiItem('event BalancerCreated(address indexed creator, address indexed balancer, address indexed pool, bytes32 salt)');
const serviceAbi = parseAbi(['function coordinator() view returns (address)', 'function rawFulfillRandomWords(uint256 requestId, uint256[] randomWords)']);

const pub = createPublicClient({ transport: http(RPC) });
const test = createTestClient({ mode: 'anvil', transport: http(RPC) });
const wallet = createWalletClient({ transport: http(RPC) });

async function main() {
  if ((await pub.getChainId()) !== 31337) throw new Error('local fork only (chain id 31337)');
  if (!FACTORY) throw new Error('missing env FACTORY');
  const coord = await pub.readContract({ address: VRF_SERVICE, abi: serviceAbi, functionName: 'coordinator' });
  await test.impersonateAccount({ address: coord });
  await test.setBalance({ address: coord, value: 10n ** 20n });
  const tried = new Set<bigint>();
  console.log(`delivering randomness for Balancers of ${FACTORY} as ${coord}`);
  for (;;) {
    const logs = await pub.getLogs({ address: FACTORY, event: CREATED, fromBlock: FROM_BLOCK });
    for (const { args } of logs) {
      const pool = args.pool!;
      const [next, last] = await Promise.all([
        pub.readContract({ address: pool, abi: fwaPoolAbi, functionName: 'nextSequenceToProcess' }),
        pub.readContract({ address: pool, abi: fwaPoolAbi, functionName: 'lastIssuedSequence' }),
      ]);
      for (let s = next; s <= last; s++) {
        const id = await pub.readContract({ address: pool, abi: fwaPoolAbi, functionName: 'requestIdAtSequence', args: [s] });
        if (id === 0n || tried.has(id)) continue;
        const [, , , , status] = await pub.readContract({ address: pool, abi: fwaPoolAbi, functionName: 'acquisitions', args: [id] });
        if (status !== PENDING) continue;
        tried.add(id);
        const word = BigInt(keccak256(encodePacked(['uint256', 'uint256'], [id, await pub.getBlockNumber()])));
        try {
          const hash = await wallet.writeContract({ address: VRF_SERVICE, abi: serviceAbi, functionName: 'rawFulfillRandomWords', args: [id, [word]], account: coord, chain: null, gas: 5_000_000n });
          const r = await pub.waitForTransactionReceipt({ hash });
          console.log(`balancer ${args.balancer} draw ${s}: word delivered (${r.status})`);
        } catch (e) {
          console.log(`balancer ${args.balancer} draw ${s}: delivery failed: ${(e as Error).message.split('\n')[0]}`);
        }
      }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
