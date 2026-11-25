// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {PoolBalancer} from "../../src/PoolBalancer.sol";
import {BalancerFactory} from "../../src/BalancerFactory.sol";
import {IFWAPool, IShapes} from "../../src/interfaces/External.sol";
import {KeeperPolicyCalls} from "../../src/KeeperPolicyCalls.sol";
import {MockNFT} from "./Mocks.sol";
import {ListOne} from "./ListOne.sol";

using ListOne for PoolBalancer;

interface IVRFService {
    function coordinator() external view returns (address);
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external;
}

interface ITimeout {
    function selectionTimeoutBlocks() external view returns (uint256);
}

/// @dev Mainnet fork against the deployed FWA PoolFactory, StandardPoolBuyback and Shapes.
///      Randomness is delivered through the real FWA VRF service by impersonating its Chainlink
///      coordinator, the only caller the service accepts.
abstract contract ForkBase is Test {
    uint256 internal constant FORK_BLOCK = 26_382_349;
    address internal constant FWA_FACTORY = 0x8919814D825a5Af238cC04DE06b1C18c9eaA477C;
    address internal constant FWA_IMPL = 0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7;
    bytes32 internal constant FWA_CODEHASH = 0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02;
    address internal constant SHAPES = 0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0;
    address internal constant ENS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    address internal constant VRF_SERVICE = 0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d;

    uint16 internal constant MARKUP = 1500;
    /// @dev Fixtures predating optional curated NFTs keep their original curated-required admission; tests of the
    ///      standard mode set this false before creating a fixture.
    bool internal curatedRequired = true;

    BalancerFactory internal factory;
    PoolBalancer internal balancer;
    IFWAPool internal pool;
    IShapes internal shapes = IShapes(SHAPES);
    MockNFT internal nft;
    address internal packs;

    address internal creator = makeAddr("creator");
    address internal keeper = makeAddr("keeper");
    address internal buyer = makeAddr("buyer");
    address internal stranger = makeAddr("stranger");
    address internal keeperAdmin = makeAddr("keeperAdmin");

    function setUpFork() internal {
        vm.createSelectFork("mainnet", FORK_BLOCK);
        // Foundry runs test transactions at gas price 0, and at basefee 0 inside calls, unless set here; every fee,
        // keeper reward and VRF charge depends on these. test/ForkContext.t.sol fails if they stop reaching calls.
        vm.txGasPrice(1 gwei);
        vm.fee(0.5 gwei);
        address renderer = deployCode("out/ShapePackRenderer.sol/ShapePackRenderer.json", abi.encode(SHAPES));
        packs = deployCode("out/ShapePacks.sol/ShapePacks.json", abi.encode(SHAPES, renderer, makeAddr("packsAdmin"), "Pool Prize Packs", "PRIZEPACK", uint256(2)));
        PoolBalancer impl = new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, packs, ENS);
        factory = new BalancerFactory(address(impl), keeperAdmin, address(this));
        factory.setCreationPaused(false);
        nft = new MockNFT();
        vm.deal(creator, 1_000 ether);
        vm.deal(buyer, 1_000 ether);
        vm.deal(stranger, 1_000 ether);
        vm.deal(keeper, 1 ether);
    }

    /// @dev Existing flow fixtures start closed. Reach that state through the real atomic creation path, then
    ///      unwind its temporary curated listing. Dedicated atomic tests exercise creation without this round trip.
    function _createFixture(address owner, bytes32 salt, uint256 deposit) internal returns (PoolBalancer b) {
        address predicted = factory.predictBalancer(owner, salt);
        uint256 id = uint256(keccak256(abi.encode(owner, salt, address(factory))));
        nft.mint(owner, id);
        PoolBalancer.CuratedInput[] memory initial = new PoolBalancer.CuratedInput[](1);
        initial[0] = PoolBalancer.CuratedInput(address(nft), id, 0.2 ether);
        uint256 seed = deposit < 0.1 ether ? 0.1 ether : deposit;
        vm.startPrank(owner);
        nft.approve(predicted, id);
        b = PoolBalancer(payable(factory.createBalancer{value: seed}(salt,
            PoolBalancer.CreationConfig(MARKUP, 400, 1, shapes.mintFee(), curatedRequired,
                factory.creationSettingsHash()), initial)));
        b.close();
        b.withdrawCurated(b.getActiveIds()[0], owner);
        if (seed > deposit) b.claimSurplus(seed - deposit, owner);
        vm.stopPrank();
    }

    function createBalancer(uint256 deposit) internal returns (PoolBalancer b) {
        b = _createFixture(creator, bytes32(0), deposit);
        balancer = b;
        pool = b.pool();
    }

    /// @dev Informational fees derived from current listing records, never used as liquid funding.
    function _listedFees(PoolBalancer b) internal view returns (uint256 fees) {
        uint256[] memory ids = b.getActiveIds();
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind,,, uint112 base, uint112 price) = b.items(ids[i]);
            if (kind == 2) fees += price - base;
        }
    }

    /// @dev Pack nine Shape counts, denomination index 0 first.
    function plan(uint256[9] memory counts) internal pure returns (uint256 p) {
        for (uint256 d; d < 9; ++d) {
            p |= counts[d] << (16 * d);
        }
    }

    /// @dev Pack sixteen prize counts: the nine Shapes denominations, then the pack sizes
    ///      0.02, 0.03, 0.2, 0.25, 2, 2.5 and 25 ETH.
    function plan16(uint256[16] memory counts) internal pure returns (uint256 p) {
        for (uint256 d; d < 16; ++d) {
            p |= counts[d] << (16 * d);
        }
    }

    function listCurated(uint256 id, uint256 base) internal returns (uint256 lid) {
        nft.mint(creator, id);
        vm.startPrank(creator);
        nft.approve(address(balancer), id);
        lid = balancer.listCurated(address(nft), id, base);
        vm.stopPrank();
    }

    /// @dev Configure at MARKUP with prize target `t` (see `plan`, `plan16`).
    function configure(uint256 t) internal {
        vm.startPrank(creator);
        balancer.configure(MARKUP, t, shapes.mintFee());
        vm.stopPrank();
    }

    /// @dev Independent arithmetic for the default (V1) economics: work fee 0.00002 ETH, 3.2M reimbursable gas,
    ///      V1_OVERHEAD, 5 gwei ceiling, 0.05 gwei priority allowance, V1_RESTOCK_GAS + 0.0002 ETH per Shape; per-operation bounds 200k base, 1.8M per processed
    ///      draw, 150k per reconcile, 700k per Shape unit, 150k per prize. Zero while paid upkeep is off.
    uint256 internal constant V1_OVERHEAD = 60_000; // recalibrated default (BalancerFactory.OVERHEAD_GAS)
    uint256 internal constant V1_RESTOCK_GAS = 910_000; // recalibrated default (BalancerFactory.RESTOCK_GAS)
    function _v1Price() internal view returns (uint256 price) {
        price = block.basefee + 0.05 gwei;
        if (price > 5 gwei) price = 5 gwei;
    }

    /// @dev One owed draw: process + reconcile one, 200k + 1.8M + 150k gas, and a work fee for each.
    function _reconciliationBudget() internal view returns (uint256) {
        if (!balancer.paidUpkeepEnabled()) return 0;
        return (2_150_000 + V1_OVERHEAD) * _v1Price() + 0.00004 ether;
    }

    function _workingBufferAt(uint256 price) internal pure returns (uint256) {
        return (3_200_000 + V1_OVERHEAD) * price + 0.0002 ether;
    }

    /// @dev One operating call: both candidate calls reach the 3.2M reimbursable limit (five reconciles plus five
    ///      Shape units, or two processed draws plus five reconciles); the first carries ten work fees.
    function _workingBuffer() internal view returns (uint256) {
        if (!balancer.paidUpkeepEnabled()) return 0;
        return (3_200_000 + V1_OVERHEAD) * _v1Price() + 0.0002 ether;
    }

    function upkeep() internal {
        bytes32 uh1 = balancer.settingsHash();
        vm.prank(keeper, keeper);
        balancer.performUpkeep(uh1, 0, 0);
    }

    /// @dev Run upkeep until it has nothing left to do (each call is bounded by MAX_OPS); returns the calls that worked.
    ///      A 200-prize fill of three-Shape packs needs 120 calls.
    function fillUp() internal returns (uint256 calls) {
        for (uint256 i; i < 400; ++i) {
            bytes32 uh2 = balancer.settingsHash();
            vm.prank(keeper, keeper);
            try balancer.performUpkeep(uh2, 0, 0) {
                ++calls;
            } catch {
                return calls;
            }
        }
        revert("upkeep never settled");
    }

    function buy(address who, uint256 count) internal returns (uint256[] memory ids) {
        (,, uint256 total) = pool.quoteAcquisitionPrice(count);
        // read before the prank: an argument's external call would otherwise take it, and the harness would pay
        uint256 version = pool.inventoryVersion();
        uint256 before = who.balance;
        vm.prank(who, who);
        ids = pool.acquireBatch{value: total}(who, count, 0, 0, 10_000, version, block.timestamp + 1);
        assertEq(before - who.balance, total, "the named player paid the quote");
    }

    /// @dev `n` single draws, one per block, left without randomness. Returns the first block in which the first has
    ///      expired; each later block expires exactly one more. Upkeep processes an expired draw only after the grace
    ///      (`KeeperPolicyCalls.stuck`), so callers that need it sooner process them on FWA as any third party would.
    function buyOnePerBlock(address who, uint256 n) internal returns (uint256 firstExpired) {
        uint256 timeout = ITimeout(address(pool)).selectionTimeoutBlocks();
        firstExpired = vm.getBlockNumber() + timeout + 1;
        for (uint256 i; i < n; ++i) {
            if (i != 0) vm.roll(vm.getBlockNumber() + 1);
            buy(who, 1);
        }
    }

    /// @dev Deliver `word` through the real VRF service, then process the canonical queue.
    function fulfill(uint256 requestId, uint256 word) internal {
        vm.roll(vm.getBlockNumber() + 3);
        uint256[] memory words = new uint256[](1);
        words[0] = word;
        vm.prank(IVRFService(VRF_SERVICE).coordinator());
        IVRFService(VRF_SERVICE).rawFulfillRandomWords{gas: 5_000_000}(requestId, words);
    }

    function settle() internal {
        if (pool.unsettledAcquisitionCount() != 0) pool.processAcquisitions(5);
    }

    /// @dev A word that selects the active listing in `slot` (1-based, slots fill in listing order).
    function wordForSlot(uint256 slot) internal view returns (uint256 word) {
        // Sum active weights of slots before `slot` by walking listings in id order.
        uint256 next = 1;
        uint256 acc;
        while (true) {
            (,,,, uint256 w,, uint256 s, uint8 status) = pool.listings(next);
            if (status == 0 && w == 0) break;
            if (status == 1 && s < slot) acc += w;
            ++next;
        }
        word = acc; // target == acc lands at the first unit of `slot`
    }

    function lastListingId() internal view returns (uint256 id) {
        while (true) {
            (,,,,,,, uint8 status) = pool.listings(id + 1);
            if (status == 0) return id;
            ++id;
        }
    }
}
