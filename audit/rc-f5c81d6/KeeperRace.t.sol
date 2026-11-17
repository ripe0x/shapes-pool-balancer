// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {PoolBalancer} from "../../src/PoolBalancer.sol";
import {BalancerFactory} from "../../src/BalancerFactory.sol";
import {IERC721Min, IFWAPool} from "../../src/interfaces/External.sol";

contract RcGasProbe {
    uint256 public gasPrice;
    uint256 public baseFee;

    function record() external {
        gasPrice = tx.gasprice;
        baseFee = block.basefee;
    }
}

contract RcSettingsRaceTest is Test {
    uint256 constant FORK_BLOCK = 26_382_349;
    address constant FWA_FACTORY = 0x8919814D825a5Af238cC04DE06b1C18c9eaA477C;
    address constant FWA_IMPL = 0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7;
    bytes32 constant FWA_CODEHASH = 0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02;
    address constant SHAPES = 0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0;
    address constant ENS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    address constant BAYC = 0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D;

    PoolBalancer balancer;
    address creator = makeAddr("creator");
    address keeper = makeAddr("keeper");

    function setUp() public {
        vm.createSelectFork("https://mainnet.gateway.tenderly.co", FORK_BLOCK);
        vm.fee(4 gwei);
        vm.txGasPrice(4 gwei);
        address renderer = deployCode("out/ShapePackRenderer.sol/ShapePackRenderer.json", abi.encode(SHAPES));
        address packs = deployCode("out/ShapePacks.sol/ShapePacks.json", abi.encode(SHAPES, renderer, makeAddr("packsAdmin"), "Pool Prize Packs", "PRIZEPACK", uint256(2)));
        PoolBalancer impl = new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, packs, ENS);
        BalancerFactory factory = new BalancerFactory(address(impl), makeAddr("keeperAdmin"));
        vm.deal(creator, 10 ether);
        vm.deal(keeper, 1 ether);
        vm.prank(creator);
        balancer = PoolBalancer(payable(factory.createBalancer{value: 5 ether}(bytes32(0))));
        vm.prank(creator);
        balancer.configure(1500, 1);
        uint256 id = 100;
        address holder;
        for (uint256 i; i < 100; ++i) {
            holder = IERC721Min(BAYC).ownerOf(id);
            if (holder.code.length == 0) break;
            ++id;
        }
        assertEq(holder.code.length, 0, "BAYC holder must be an ordinary external actor");
        vm.prank(holder);
        IERC721Min(BAYC).transferFrom(holder, creator, id);
        vm.startPrank(creator);
        IERC721Min(BAYC).approve(address(balancer), id);
        PoolBalancer.CuratedInput[] memory one = new PoolBalancer.CuratedInput[](1);
        one[0] = PoolBalancer.CuratedInput(BAYC, id, 0.2 ether);
        balancer.listCuratedBatch(one);
        balancer.open();
        vm.stopPrank();
    }

    function test_creatorCutsRewardAfterKeeperPreflight() public {
        RcGasProbe probe = new RcGasProbe();
        probe.record();
        assertEq(probe.gasPrice(), 4 gwei, "gas price inside state-changing call");
        assertEq(probe.baseFee(), 4 gwei, "basefee inside state-changing call");
        uint256 snap = vm.snapshotState();
        vm.prank(keeper, keeper);
        uint256 preflightReward = balancer.performUpkeep();
        assertGt(preflightReward, 0, "preflight reaches useful real FWA and Shapes work");
        vm.revertToStateAndDelete(snap);

        vm.prank(creator);
        balancer.setOverrides(1, 1 gwei, 0, 0, 0);
        assertEq(balancer.settings().maxGasPrice, 1 gwei);
        vm.prank(keeper, keeper);
        uint256 includedReward = balancer.performUpkeep();
        (bool ok, bytes memory result) = address(vm).staticcall(abi.encodeWithSignature("lastCallGas()"));
        assertTrue(ok);
        (, uint64 billedGas,,,) = abi.decode(result, (uint64, uint64, uint64, int64, uint64));
        assertGt(billedGas, 0);
        uint256 billedCost = uint256(billedGas) * 4 gwei;
        emit log_named_uint("preflight reward wei", preflightReward);
        emit log_named_uint("included reward wei", includedReward);
        emit log_named_uint("billed gas", billedGas);
        emit log_named_uint("billed cost wei at 4 gwei", billedCost);
        assertGt(preflightReward, includedReward);
        assertGt(billedCost, includedReward + 0.0002 ether, "loss exceeds keeper policy");
    }

    /// No oracle response: five real FWA purchases expire, then the creator unlists five
    /// prizes to force a four-size restock in the same upkeep that reconciles the refunds.
    function test_gasReconcileAndRestock200With20CuratedWithoutRandomness() public {
        RcGasProbe probe = new RcGasProbe();
        probe.record();
        assertEq(probe.gasPrice(), 4 gwei, "gas price inside state-changing call");
        assertEq(probe.baseFee(), 4 gwei, "basefee inside state-changing call");
        uint256 t = 188;
        for (uint256 d = 1; d <= 6; ++d) t |= uint256(1) << (16 * d);
        t |= uint256(3) << (16 * 7);
        t |= uint256(3) << (16 * 8);
        vm.deal(creator, 3_000 ether);
        vm.startPrank(creator);
        balancer.depositETH{value: 2_000 ether}();
        balancer.configure(1500, t);
        vm.stopPrank();
        for (uint256 i; i < 150 && balancer.creatorWork(); ++i) {
            vm.prank(keeper, keeper);
            balancer.performUpkeep();
        }
        assertFalse(balancer.creatorWork(), "200 prizes filled");

        PoolBalancer.CuratedInput[] memory batch = new PoolBalancer.CuratedInput[](19);
        uint256 next = 101;
        for (uint256 i; i < 19; ++i) {
            address holder;
            for (uint256 j; j < 100; ++j) {
                holder = IERC721Min(BAYC).ownerOf(next);
                if (holder.code.length == 0) break;
                ++next;
            }
            assertEq(holder.code.length, 0, "ordinary BAYC owner");
            vm.prank(holder);
            IERC721Min(BAYC).transferFrom(holder, creator, next);
            vm.prank(creator);
            IERC721Min(BAYC).approve(address(balancer), next);
            batch[i] = PoolBalancer.CuratedInput(BAYC, next, 0.2 ether);
            ++next;
        }
        vm.prank(creator);
        balancer.listCuratedBatch(batch);
        assertEq(balancer.getActiveIds().length, 220, "200 Shapes and 20 NFTs");

        IFWAPool p = balancer.pool();
        address buyer = makeAddr("buyer");
        vm.deal(buyer, 1_000 ether);
        (,, uint256 total) = p.quoteAcquisitionPrice(5);
        uint256 version = p.inventoryVersion();
        vm.prank(buyer, buyer);
        p.acquireBatch{value: total}(buyer, 5, 0, 0, 10_000, version, block.timestamp + 1);
        vm.roll(block.number + 40);
        p.processAcquisitions(5);
        assertEq(p.nextSequenceToProcess(), 6, "all five expired without randomness");

        uint256[] memory ids = balancer.getActiveIds();
        uint256[] memory remove = new uint256[](5);
        uint256[4] memory wanted = [uint256(2), 1, 1, 1];
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind, uint8 d,,,) = balancer.items(ids[i]);
            if (kind == 2 && d < 4 && wanted[d] != 0) {
                remove[5 - (wanted[0] + wanted[1] + wanted[2] + wanted[3])] = ids[i];
                --wanted[d];
            }
        }
        for (uint256 d; d < 4; ++d) assertEq(wanted[d], 0, "all four restock sizes found");
        vm.prank(creator);
        balancer.unlistShapes(remove);

        vm.recordLogs();
        vm.prank(keeper, keeper);
        uint256 reward = balancer.performUpkeep();
        (bool ok, bytes memory result) = address(vm).staticcall(abi.encodeWithSignature("lastCallGas()"));
        assertTrue(ok);
        (, uint64 billedGas,,,) = abi.decode(result, (uint64, uint64, uint64, int64, uint64));
        uint256 measured;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == keccak256("KeeperPaid(address,uint256,uint256)")) {
                (, measured) = abi.decode(logs[i].data, (uint256, uint256));
            }
        }
        assertEq(balancer.reconciledSequence(), 5, "five refunds reconciled");
        assertGt(reward, 0, "useful work paid");
        assertGt(measured, 0, "KeeperPaid measured gas emitted");
        emit log_named_uint("no-mock 200+20 measured gas", measured);
        emit log_named_uint("no-mock 200+20 billed gas", billedGas);
        assertLt(measured, 3_200_000, "under the measured-gas pay cap");
    }
}
