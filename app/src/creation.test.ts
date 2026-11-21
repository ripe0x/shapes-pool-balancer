import { BaseError, UserRejectedRequestError, WaitForTransactionReceiptTimeoutError, createPublicClient, createWalletClient, custom, decodeFunctionData, http, type Address, type Hash } from 'viem';
import { describe, expect, it } from 'vitest';
import { canRetryCreation, creationContextMatches, creationNotSubmitted, recoverCreation, sameCreation, sameSubmission, submitCreation, type CreationAttempt } from './creation';

const attempt: CreationAttempt = {
  chainId: 31337,
  factory: '0xCd171B437d9329C2654128645944fbC05C9AA2BF',
  creator: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  salt: `0x${'01'.repeat(32)}`,
  predicted: '0xA54AF51f57035550af3b9bbCf1fD298a0C1c2626',
  config: { markupBps: 2500, creatorRevenueBps: 1234, target: '0', mintFeeCap: '1000000000000000' },
  curated: [],
  value: '0',
};
const context = { chainId: attempt.chainId, factory: attempt.factory, creator: attempt.creator };

describe('atomic creation submission identity', () => {
  it('retains the same attempt when its transaction hash arrives', () => {
    expect(sameCreation(attempt, { ...attempt, hash: `0x${'02'.repeat(32)}` })).toBe(true);
    for (const other of [{ ...attempt, chainId: 1 }, { ...attempt, creator: attempt.factory },
      { ...attempt, factory: attempt.creator }, { ...attempt, salt: `0x${'03'.repeat(32)}` as const },
      { ...attempt, value: '1' }, { ...attempt, config: { ...attempt.config, creatorRevenueBps: 10000 } },
      { ...attempt, curated: [{ collection: attempt.factory, tokenId: '1', base: '1' }] }]) {
      expect(sameCreation(attempt, other)).toBe(false);
    }
  });

  it('requires the creating account, chain and factory before opening or clearing a saved attempt', () => {
    expect(creationContextMatches(attempt, context)).toBe(true);
    expect(creationContextMatches(attempt, { ...context, creator: attempt.creator.toLowerCase() as Address })).toBe(true);
    for (const other of [{ ...context, chainId: 1 }, { ...context, creator: undefined },
      { ...context, creator: attempt.factory }, { ...context, factory: attempt.creator }]) {
      expect(creationContextMatches(attempt, other)).toBe(false);
    }
  });

  it('rejects late writes or clearing against an older persisted transaction identity', () => {
    const submitted = { ...attempt, hash: `0x${'05'.repeat(32)}` as const };
    const observed = { ...submitted, nonce: 7 };
    const replaced = { ...observed, hash: `0x${'06'.repeat(32)}` as const };
    expect(sameCreation(submitted, replaced)).toBe(true);
    expect(sameSubmission(submitted, observed)).toBe(false);
    expect(sameSubmission(observed, replaced)).toBe(false);
    expect(sameSubmission(replaced, JSON.parse(JSON.stringify(replaced)))).toBe(true);
    expect(sameSubmission(undefined, replaced)).toBe(false);
    for (const outcome of ['cancelled', 'replaced', 'reverted'] as const) {
      expect(canRetryCreation(outcome, replaced, context)).toBe(true);
      for (const other of [{ ...context, chainId: 1 }, { ...context, creator: attempt.factory }, { ...context, factory: attempt.creator }]) {
        expect(canRetryCreation(outcome, replaced, other)).toBe(false);
      }
    }
  });

  it('distinguishes explicit wallet rejection from an uncertain submission or receipt timeout', () => {
    const rejected = new UserRejectedRequestError(new Error('user cancelled'));
    expect(creationNotSubmitted(rejected)).toBe(true);
    expect(creationNotSubmitted(new BaseError('wallet failed', { cause: rejected }))).toBe(true);
    expect(creationNotSubmitted({ code: 4001 })).toBe(true);
    for (const failure of [new Error('timeout'), new Error('receipt unavailable'), { code: -32000 }]) {
      expect(creationNotSubmitted(failure)).toBe(false);
    }
  });
});

describe('creation-only submission orchestration', () => {
  // Program callbacks model persistence; the wallet boundary supplies failures only, never fabricated successful answers.
  const tracking = () => {
    let saved: CreationAttempt | undefined;
    return {
      existing: () => saved,
      store: (a: CreationAttempt) => { saved = a; },
      reject: (a: CreationAttempt) => { if (sameCreation(saved, a)) saved = undefined; },
    };
  };

  it('keeps preparation failures retryable because no wallet submission was attempted', async () => {
    const state = tracking();
    let writes = 0;
    await expect(submitCreation(attempt, async () => { writes++; throw new Error('simulation failed'); }, state)).rejects.toThrow('simulation failed');
    expect(state.existing()).toBeUndefined();
    await expect(submitCreation(attempt, async () => { writes++; throw new Error('simulation failed'); }, state)).rejects.toThrow('simulation failed');
    expect(writes).toBe(2);
  });

  it('clears an explicitly rejected wallet submission and preserves its legitimate retry', async () => {
    const state = tracking();
    const write = async (beforeWallet: () => void) => {
      beforeWallet();
      throw new UserRejectedRequestError(new Error('user cancelled'));
    };
    await expect(submitCreation(attempt, write, state)).rejects.toBeInstanceOf(UserRejectedRequestError);
    expect(state.existing()).toBeUndefined();
    await expect(submitCreation(attempt, write, state)).rejects.toBeInstanceOf(UserRejectedRequestError);
  });

  it('never resubmits a wallet call whose outcome is unknown, including after state serialization', async () => {
    const state = tracking();
    let writes = 0;
    const write = async (beforeWallet: () => void) => {
      beforeWallet(); writes++;
      throw new Error('RPC timed out after submission');
    };
    await expect(submitCreation(attempt, write, state)).rejects.toThrow('timed out');
    expect(state.existing()).toEqual(attempt);
    const restored = JSON.parse(JSON.stringify(state.existing())) as CreationAttempt;
    const afterRefresh = { ...state, existing: () => restored };
    await expect(submitCreation(attempt, write, afterRefresh)).rejects.toThrow('still needs confirmation');
    expect(writes).toBe(1);
    for (const outcome of ['unknown', 'pending', 'context', 'mismatch', 'confirmed'] as const) {
      expect(canRetryCreation(outcome, restored, context)).toBe(false);
    }
    // The outcome is program state here. Only real receipt reads in recoverCreation can establish an actual revert.
    expect(canRetryCreation('reverted', restored, context)).toBe(true);
    expect(canRetryCreation('reverted', restored, { ...context, creator: attempt.factory })).toBe(false);
  });

  it('rechecks saved submissions after preparation, before reaching the wallet', async () => {
    const state = tracking();
    let walletCalls = 0;
    const other = { ...attempt, salt: `0x${'04'.repeat(32)}` as const };
    await expect(submitCreation(attempt, async (beforeWallet) => {
      state.store(other);
      beforeWallet();
      walletCalls++;
      throw new Error('wallet must not be reached');
    }, state)).rejects.toThrow('still needs confirmation');
    expect(walletCalls).toBe(0);
    expect(state.existing()).toEqual(other);
  });
});

describe('creation lookup failure', () => {
  it('retains unknown submissions when the RPC cannot establish their outcome', async () => {
    const pub = createPublicClient({ transport: http('http://127.0.0.1:1', { retryCount: 0, timeout: 100 }) });
    expect(await recoverCreation(pub, attempt, context)).toBe('unknown');
  });

  it('does not contact another context to resolve or clear the saved submission', async () => {
    let calls = 0;
    // Failure injection only: no successful chain response is supplied by this client.
    const unavailable = { getChainId: async () => { calls++; throw new Error('RPC unavailable'); } };
    expect(await recoverCreation(unavailable as never, attempt, { ...context, chainId: 1 })).toBe('context');
    expect(calls).toBe(0);
  });
});

const forkRpc = process.env.CREATION_TOGGLE_RPC;
const forkFactory = process.env.CREATION_RECOVERY_FACTORY as Address | undefined;
// Local fork only (chain 31337): the real factory's latest creation is replayed from its own transaction, then the creator
// changes the pool's mode through a real transaction. Every successful answer comes from that fork node.
it.skipIf(!forkRpc || !forkFactory)('confirms a created pool after the creator changes its settings, and rejects a different reviewed design', async () => {
  const { balancerFactoryAbi, poolBalancerAbi } = await import('../../shared/abi');
  const pub = createPublicClient({ transport: http(forkRpc, { retryCount: 0 }), cacheTime: 0, pollingInterval: 100 });
  expect(await pub.getChainId()).toBe(31337);
  const created = await pub.getContractEvents({ address: forkFactory!, abi: balancerFactoryAbi, eventName: 'BalancerCreated',
    fromBlock: await pub.getBlockNumber() - 50n, strict: true });
  const log = created.at(-1)!;
  const transaction = await pub.getTransaction({ hash: log.transactionHash });
  const { args: [salt, config, curated] } = decodeFunctionData({ abi: balancerFactoryAbi, data: transaction.input }) as never as { args: [Hash, {
    markupBps: number; creatorRevenueBps: number; target: bigint; mintFeeCap: bigint; curatedRequired: boolean }, { collection: Address; tokenId: bigint; base: bigint }[]] };
  const creator = transaction.from;
  const live: CreationAttempt = { chainId: 31337, factory: forkFactory!, creator, salt, predicted: log.args.balancer, hash: transaction.hash,
    nonce: transaction.nonce, value: String(transaction.value),
    config: { markupBps: config.markupBps, creatorRevenueBps: config.creatorRevenueBps, target: String(config.target),
      mintFeeCap: String(config.mintFeeCap), curatedRequired: config.curatedRequired },
    curated: curated.map(n => ({ collection: n.collection, tokenId: String(n.tokenId), base: String(n.base) })) };
  const liveContext = { chainId: 31337, factory: forkFactory!, creator };
  expect(await recoverCreation(pub, live, liveContext)).toBe('confirmed');

  const current = await pub.readContract({ address: live.predicted, abi: poolBalancerAbi, functionName: 'curatedRequired' });
  await pub.request({ method: 'anvil_impersonateAccount' as never, params: [creator] as never });
  const wallet = createWalletClient({ account: creator, transport: http(forkRpc, { retryCount: 0 }) });
  const toggle = await wallet.writeContract({ address: live.predicted, abi: poolBalancerAbi, functionName: 'setCuratedRequired',
    args: [!current], chain: null });
  expect((await pub.waitForTransactionReceipt({ hash: toggle })).status).toBe('success');
  expect(await pub.readContract({ address: live.predicted, abi: poolBalancerAbi, functionName: 'curatedRequired' })).toBe(!current);

  expect(await recoverCreation(pub, live, liveContext)).toBe('confirmed');
  // The saved record survives a reload without its hash when it has the block it was submitted after.
  expect(await recoverCreation(pub, { ...live, hash: undefined, nonce: undefined, fromBlock: String(transaction.blockNumber! - 1n) }, liveContext)).toBe('confirmed');
  expect(await recoverCreation(pub, { ...live, config: { ...live.config, curatedRequired: !current } }, liveContext)).toBe('mismatch');
  expect(await recoverCreation(pub, { ...live, config: { ...live.config, creatorRevenueBps: (live.config.creatorRevenueBps + 1) % 10_001 } }, liveContext)).toBe('mismatch');
  expect(await recoverCreation(pub, live, { ...liveContext, creator: forkFactory! })).toBe('context');
}, 60_000);

const rpc = process.env.CREATION_RECOVERY_RPC;
// Public facts from docs/verification/frontend-followup/creation-readback.json.
// This transaction was already broadcast and mined by the real browser flow; these tests never submit it again.
const minedAttempt: CreationAttempt = {
  ...attempt,
  predicted: '0xA3d5312103C3f64506A914BcA71768b7695297A0',
  hash: '0x090688e3bf5d6728b36d8d6ac952b123d880f8b7a29526035884f30dae616803',
  salt: '0xf0f73c0fecaa42e9d1596e10499921da71cb7ccb796470bbe380d58414492927',
  config: { ...attempt.config, target: '66902235595591869424607154817945088813236234' },
  curated: [{ collection: '0x7de7BC53e06f8549c6F89AEE3F59cD605c97c455', tokenId: '2026111802', base: '250000000000000000' }],
  value: '536112000000000000',
};

describe.skipIf(!rpc)('mined atomic creation with unavailable receipt confirmation', () => {
  for (const failure of ['throw', 'timeout'] as const) {
    it(`retains and recovers the actual mined creation after viem receipt ${failure}, without another wallet call`, async () => {
      const real = createPublicClient({ transport: http(rpc, { retryCount: 0 }), cacheTime: 0 });
      const hash = minedAttempt.hash!;
      const receipt = await real.getTransactionReceipt({ hash });
      expect(receipt.status).toBe('success');
      expect(receipt.from.toLowerCase()).toBe(minedAttempt.creator.toLowerCase());
      expect(receipt.to?.toLowerCase()).toBe(minedAttempt.factory.toLowerCase());
      const transaction = await real.getTransaction({ hash });
      expect(transaction.value).toBe(BigInt(minedAttempt.value));

      let receiptCalls = 0;
      const unavailable = createPublicClient({ cacheTime: 0, transport: custom({
        request: async (request) => {
          if (request.method === 'eth_getTransactionReceipt') {
            receiptCalls++;
            if (failure === 'throw') throw new Error('receipt RPC deliberately unavailable');
            return new Promise<never>(() => {});
          }
          // Every successful external answer comes unchanged from the real fork node.
          return real.transport.request(request);
        },
      }, { retryCount: 0 }) });
      const confirmationError = await unavailable.waitForTransactionReceipt({
        hash, pollingInterval: 10, timeout: failure === 'timeout' ? 100 : 2000,
      }).then(() => { throw new Error('unavailable receipt unexpectedly confirmed'); }, error => error);
      expect(receiptCalls).toBeGreaterThan(0);
      if (failure === 'timeout') expect(confirmationError).toBeInstanceOf(WaitForTransactionReceiptTimeoutError);
      else {
        expect(confirmationError).not.toBeInstanceOf(WaitForTransactionReceiptTimeoutError);
        expect(String(confirmationError)).toContain('receipt RPC deliberately unavailable');
      }
      expect(creationNotSubmitted(confirmationError)).toBe(false);

      // Model the persisted attempt after refresh, including its already returned real transaction hash.
      const restored = JSON.parse(JSON.stringify(minedAttempt)) as CreationAttempt;
      expect(restored).toEqual(minedAttempt);
      let walletCalls = 0;
      const tracking = { existing: () => restored, store: () => { throw new Error('must retain attempt'); }, reject: () => { throw new Error('must retain attempt'); } };
      await expect(submitCreation(restored, async () => { walletCalls++; throw new Error('wallet must not be reached'); }, tracking)).rejects.toThrow('still needs confirmation');
      expect(walletCalls).toBe(0);
      expect(await recoverCreation(unavailable, restored, context)).toBe('confirmed');
      expect(tracking.existing()).toEqual(minedAttempt);
    });
  }
});
