// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/Test.sol";
import {ForkBase} from "../utils/ForkBase.sol";
import {GasProbe} from "../utils/FlowBreakdown.sol";
import {IERC721Min} from "../../src/interfaces/External.sol";

/// @notice D6 measurement (no code change): the launch board listed fresh at basefee 0.5, 2 and 4.95 gwei (gas price
///         +0.05 gwei), on the pinned mainnet fork with the real FWA pool, randomness service and Shapes. Logs every
///         listing (L lines) and, per basefee, FWA's own quote and the keeper pay measured for one Shape replacement and
///         one NFT-win reconcile (M lines). `docs/D6-PRICE-CAPS.md` computes the other fee caps from these lines and
///         checks its formula against FWA's quote at the current cap.
contract PriceCapsMeasure is ForkBase {
    address constant BAYC = 0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D;
    GasProbe probe;

    function setUp() public {
        setUpFork();
        probe = new GasProbe();
    }

    function test_board_at_0_5_gwei() public {
        _measure(0.5 gwei);
    }

    function test_board_at_2_gwei() public {
        _measure(2 gwei);
    }

    function test_board_at_4_95_gwei() public {
        _measure(4.95 gwei);
    }

    function _measure(uint256 basefee) internal {
        uint256 gp = basefee + 0.05 gwei;
        vm.fee(basefee);
        vm.txGasPrice(gp);
        probe.record();
        assertEq(probe.baseFee(), basefee, "basefee inside a transaction");
        assertEq(probe.gasPrice(), gp, "gas price inside a transaction");

        createBalancer(5 ether);
        uint256[16] memory c;
        (c[0], c[9], c[1], c[2], c[3]) = (24, 8, 12, 2, 1);
        vm.prank(creator);
        balancer.configure(2500, plan16(c));
        uint256 nftLid = _listNft();
        vm.prank(creator);
        balancer.open();
        fillUp();
        assertEq(balancer.getActiveIds().length, 48, "reached: the whole board (47 prizes and the NFT) is listed");

        (uint256 fee, uint256 vrf, uint256 total) = pool.quoteAcquisitionPrice(1);
        uint256[] memory ids = balancer.getActiveIds();
        uint256 shapeLid;
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind, uint8 d,, uint112 base, uint112 price) = balancer.items(ids[i]);
            (,,,, uint256 w, uint256 p,, uint8 st) = pool.listings(ids[i]);
            assertEq(st, 1, "active at FWA");
            assertEq(p, price, "same price at FWA");
            console2.log(string.concat("L,", vm.toString(basefee), ",", vm.toString(kind), ",", vm.toString(d), ",",
                vm.toString(base), ",", vm.toString(price), ",", vm.toString(w)));
            if (kind == 2 && d == 0 && shapeLid == 0) shapeLid = ids[i];
        }

        // keeper pay for one Shape replacement (reconcile one draw, restock one 0.01 Shape) and one NFT-win reconcile
        uint256 rShape = _drawAndUpkeep(shapeLid);
        uint256 rNft = _drawAndUpkeep(nftLid);
        console2.log(string.concat("M,", vm.toString(basefee), ",", vm.toString(fee), ",", vm.toString(vrf), ",",
            vm.toString(total), ",", vm.toString(balancer.restockFee()), ",", vm.toString(rShape), ",", vm.toString(rNft)));
    }

    function _drawAndUpkeep(uint256 lid) internal returns (uint256 reward) {
        uint256[] memory ids = buy(buyer, 1);
        (,,,,,, uint256 slot,) = pool.listings(lid);
        fulfill(ids[0], wordForSlot(slot));
        settle();
        (,,,,,,, uint8 st) = pool.listings(lid);
        assertEq(st, 4, "reached: the chosen prize was won");
        vm.prank(keeper, keeper);
        reward = balancer.performUpkeep();
    }

    function _listNft() internal returns (uint256 lid) {
        uint256 id = 300;
        address holder;
        while ((holder = IERC721Min(BAYC).ownerOf(id)).code.length != 0) ++id;
        vm.prank(holder);
        IERC721Min(BAYC).transferFrom(holder, creator, id);
        vm.startPrank(creator);
        IERC721Min(BAYC).approve(address(balancer), id);
        lid = balancer.listCurated(BAYC, id, 0.2 ether);
        vm.stopPrank();
    }
}
