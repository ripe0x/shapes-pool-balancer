// Zero-draw local acceptance through the hash-bound CurrentRehearsal journal. No coordinator permission exists.
import assert from 'node:assert/strict';
import { parseAbi, type Address, type Hash } from 'viem';
import { balancerFactoryAbi, erc721Abi, poolBalancerAbi } from '../shared/abi';
import { INVENTORY_SCENARIO, ROLES, type CurrentRehearsal } from './current-local-rehearsal';

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as Address;
const wethAbi = parseAbi(['function deposit() payable', 'function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns(uint256)']);
const demoAbi = parseAbi(['function mint(address,uint256)']);
const SALT = `0x${'00'.repeat(31)}a1` as Hash;

export async function runInventoryAcceptance(run: CurrentRehearsal) {
    const actor = ROLES.policyAdmin;
    assert.equal(await run.read<boolean>(run.factory, balancerFactoryAbi, 'creationPaused'), true);
    const mintFeeCap = BigInt(run.plan.parameters.mintFeeWei);
    const settingsHash = await run.read<Hash>(run.factory, balancerFactoryAbi, 'creationSettingsHash');
    const config = { markupBps: 1500, creatorRevenueBps: 400, target: 1n, mintFeeCap, curatedRequired: false, settingsHash };
    try {
        await run.pub.simulateContract({ account: ROLES.creatorA, address: run.factory, abi: balancerFactoryAbi,
            functionName: 'createBalancer', args: [SALT, config, []], value: BigInt(INVENTORY_SCENARIO.depositWei) });
        assert.fail('public creation must be paused');
    } catch (error) {
        const exact = (error as any).walk?.((e: any) => e.data?.errorName === 'CreationPaused');
        assert.equal(exact?.data?.errorName, 'CreationPaused', 'real public call fails specifically at pause gate');
    }
    const demo = await run.create(actor, 'DemoNFT');
    const balancer = await run.read<Address>(run.factory, balancerFactoryAbi, 'predictBalancer', [actor, SALT]);
    const record = { creator: actor, demo, balancer, pool: '' as string };
    run.journal.pools.push(record); run.save();
    await run.send(actor, run.factory, balancerFactoryAbi, 'createBalancer', [SALT, config, []], BigInt(INVENTORY_SCENARIO.depositWei));
    record.pool = await run.read<Address>(balancer, poolBalancerAbi, 'pool'); run.save();
    assert.equal((await run.read<Address>(balancer, poolBalancerAbi, 'creator')).toLowerCase(), actor.toLowerCase());
    assert.equal(await run.pub.getBalance({ address: balancer }), BigInt(INVENTORY_SCENARIO.depositWei));
    await run.send(actor, balancer, poolBalancerAbi, 'close');
    for (const id of [1n, 2n]) {
        await run.send(actor, demo, demoAbi, 'mint', [actor, id]);
        await run.send(actor, demo, erc721Abi, 'approve', [balancer, id]);
    }
    await run.send(actor, balancer, poolBalancerAbi, 'listCuratedBatch', [[1n, 2n].map((tokenId, i) => ({ collection: demo, tokenId, base: BigInt(INVENTORY_SCENARIO.curatedValues[i]) }))]);
    const ids = await run.read<readonly bigint[]>(balancer, poolBalancerAbi, 'getActiveIds');
    assert.equal(ids.length, 2);
    await run.send(actor, balancer, poolBalancerAbi, 'updateCuratedPricesBatch', [ids, INVENTORY_SCENARIO.repricedValues.map(BigInt)]);
    for (const [i, id] of ids.entries()) {
        const item = await run.read<readonly [number, number, number, bigint, bigint]>(balancer, poolBalancerAbi, 'items', [id]);
        assert.equal(item[3], BigInt(INVENTORY_SCENARIO.repricedValues[i]));
        assert.equal(item[4], item[3]);
    }
    await run.send(actor, balancer, poolBalancerAbi, 'withdrawCuratedBatch', [ids, actor]);
    for (const id of [1n, 2n]) assert.equal((await run.read<Address>(demo, erc721Abi, 'ownerOf', [id])).toLowerCase(), actor.toLowerCase());
    assert.equal((await run.read<readonly bigint[]>(balancer, poolBalancerAbi, 'getActiveIds')).length, 0);
    const beforeWeth = await run.read<bigint>(WETH, wethAbi, 'balanceOf', [actor]);
    const amount = BigInt(INVENTORY_SCENARIO.wethWei);
    await run.send(actor, WETH, wethAbi, 'deposit', [], amount);
    await run.send(actor, WETH, wethAbi, 'transfer', [balancer, amount]);
    assert.equal(await run.read<bigint>(WETH, wethAbi, 'balanceOf', [balancer]), amount);
    await run.send(actor, balancer, poolBalancerAbi, 'recoverERC20', [WETH, amount]);
    assert.equal(await run.read<bigint>(WETH, wethAbi, 'balanceOf', [balancer]), 0n);
    assert.equal(await run.read<bigint>(WETH, wethAbi, 'balanceOf', [actor]), beforeWeth + amount);
    const claim = await run.read<bigint>(balancer, poolBalancerAbi, 'withdrawableSurplus');
    assert.equal(claim, BigInt(INVENTORY_SCENARIO.depositWei));
    run.beginCloseout();
    await run.send(actor, balancer, poolBalancerAbi, 'claimSurplus', [claim, actor]);
    assert.equal(await run.pub.getBalance({ address: balancer }), 0n);
    assert.equal(await run.read<boolean>(run.factory, balancerFactoryAbi, 'creationPaused'), true);
    run.report({ zeroDrawAcceptance: true, nativeReturnedWei: String(claim), wethRecoveredWei: String(amount), nftsReturned: 2,
        coordinatorPermissions: 0, draws: 0, uiWritesSupported: false, remainingEvidence: ['actual creator-wallet UI', 'authentic failed delivery/refund recovery', 'economic release regimes'] });
}
