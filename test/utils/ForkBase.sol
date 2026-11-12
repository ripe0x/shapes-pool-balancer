// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {PoolBalancer} from "../../src/PoolBalancer.sol";
import {BalancerFactory} from "../../src/BalancerFactory.sol";
import {IFWAPool, IShapes} from "../../src/interfaces/External.sol";
import {MockNFT} from "./Mocks.sol";

interface IVRFService {
    function coordinator() external view returns (address);
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external;
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
        vm.txGasPrice(1 gwei);
        vm.fee(0.5 gwei);
        address renderer = deployCode("out/ShapePackRenderer.sol/ShapePackRenderer.json", abi.encode(SHAPES));
        packs = deployCode("out/ShapePacks.sol/ShapePacks.json", abi.encode(SHAPES, renderer, makeAddr("packsAdmin"), "Pool Prize Packs", "PRIZEPACK", uint256(2)));
        PoolBalancer impl = new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, packs, ENS);
        factory = new BalancerFactory(address(impl), keeperAdmin);
        nft = new MockNFT();
        vm.deal(creator, 1_000 ether);
        vm.deal(buyer, 1_000 ether);
        vm.deal(keeper, 1 ether);
    }

    function createBalancer(uint256 deposit) internal returns (PoolBalancer b) {
        vm.prank(creator);
        b = PoolBalancer(payable(factory.createBalancer{value: deposit}(bytes32(0))));
        balancer = b;
        pool = b.pool();
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
        vm.prank(creator);
        balancer.configure(MARKUP, t);
    }

    function upkeep() internal {
        vm.prank(keeper, keeper);
        balancer.performUpkeep();
    }

    /// @dev Run upkeep until it has nothing left to do (each call is bounded by MAX_OPS); returns the calls that worked.
    function fillUp() internal returns (uint256 calls) {
        for (uint256 i; i < 40; ++i) {
            vm.prank(keeper, keeper);
            try balancer.performUpkeep() {
                ++calls;
            } catch {
                return calls;
            }
        }
        revert("upkeep never settled");
    }

    function buy(address who, uint256 count) internal returns (uint256[] memory ids) {
        (,, uint256 total) = pool.quoteAcquisitionPrice(count);
        vm.prank(who, who);
        ids = pool.acquireBatch{value: total}(who, count, 0, 0, 10_000, pool.inventoryVersion(), block.timestamp + 1);
    }

    /// @dev Deliver `word` through the real VRF service, then process the canonical queue.
    function fulfill(uint256 requestId, uint256 word) internal {
        vm.roll(block.number + 3);
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
