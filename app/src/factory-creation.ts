import { parseAbi, toFunctionSelector, type Address, type Hex, type PublicClient } from 'viem';

const pauseAbi = parseAbi(['function creationPaused() view returns (bool)', 'function policyAdmin() view returns (address)']);
export const supportsCreationPause = (runtime: Hex) => runtime.toLowerCase().includes(`63${toFunctionSelector('creationPaused()').slice(2)}`);
export const creationAllowed = (paused: boolean, admin: Address, creator?: Address) => !paused || admin.toLowerCase() === creator?.toLowerCase();

/** Old immutable factories lack the selector. RPC failures must never look like an unpaused factory. */
export async function readFactoryCreation(pub: Pick<PublicClient, 'getCode' | 'readContract'>, factory: Address, creator?: Address, blockNumber?: bigint) {
  const code = await pub.getCode({ address: factory, blockNumber });
  if (!code || code === '0x') throw new Error('Factory code is unavailable.');
  if (!supportsCreationPause(code)) return { supported: false, paused: false, allowed: true };
  const [paused, admin] = await Promise.all([
    pub.readContract({ address: factory, abi: pauseAbi, functionName: 'creationPaused', blockNumber }),
    pub.readContract({ address: factory, abi: pauseAbi, functionName: 'policyAdmin', blockNumber }),
  ]);
  return { supported: true, paused, allowed: creationAllowed(paused, admin, creator) };
}
