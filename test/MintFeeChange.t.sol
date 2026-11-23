// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Test.sol";
import {ForkBase} from "./utils/ForkBase.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";

interface IShapesFeeAdmin {
    function setMintFee(uint256) external;
}

/// @notice Spec §7 on a mainnet fork: the real Shapes mint fee moves 0.001 -> 0.0005 -> 0.001 through the real Shapes
///         admin (impersonated on the fork only; mainnet is never touched). Absolute wei throughout.
contract MintFeeChangeTest is ForkBase {
    /// Live Shapes admin, the only caller `setMintFee` accepts (same address OptionalCurated uses).
    address internal constant SHAPES_ADMIN = 0xCB43078C32423F5348Cab5885911C3B5faE217F9;
    bytes32 internal constant SHAPES_MINTED = keccak256("ShapesMinted(uint8,uint256,uint256,uint256)");

    uint256 internal target;

    function setUp() public {
        setUpFork();
        curatedRequired = false;
        createBalancer(5 ether);
        target = plan([uint256(20), 0, 0, 0, 0, 0, 0, 0, 0]);
        configure(target);
        vm.prank(creator);
        balancer.open();
        fillUp();
    }

    function _setFee(uint256 fee) internal {
        vm.prank(SHAPES_ADMIN);
        IShapesFeeAdmin(SHAPES).setMintFee(fee);
        assertEq(shapes.mintFee(), fee);
    }

    function _win() internal {
        uint256[] memory ids = buy(buyer, 1);
        fulfill(ids[0], 0);
    }

    /// Run upkeep to completion and return what it minted, from the Balancer's own ShapesMinted events.
    function _fill() internal returns (uint256 quantity, uint256 cost) {
        vm.recordLogs();
        fillUp();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(balancer) || logs[i].topics[0] != SHAPES_MINTED) continue;
            (, uint256 q, uint256 c) = abi.decode(logs[i].data, (uint256, uint256, uint256));
            quantity += q;
            cost += c;
        }
    }

    function _accept(uint256 cap) internal {
        vm.prank(creator);
        balancer.configure(MARKUP, target, cap);
    }

    function _newest() internal view returns (uint112 base, uint112 price) {
        uint256[] memory ids = balancer.getActiveIds();
        (,,, base, price) = balancer.items(ids[ids.length - 1]);
    }

    function _prices() internal view returns (uint256[] memory ids, uint256[] memory prices) {
        ids = balancer.getActiveIds();
        prices = new uint256[](ids.length);
        for (uint256 i; i < ids.length; ++i) (,,,, prices[i]) = balancer.items(ids[i]);
    }

    function _assertUnchanged(uint256[] memory ids, uint256[] memory prices) internal view {
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind,,,, uint112 price) = balancer.items(ids[i]);
            if (kind == 0) continue; // drawn or unlisted since
            assertEq(price, prices[i], "an existing listing keeps its price");
            (,,,,, uint256 fwaPrice,,) = pool.listings(ids[i]);
            assertEq(fwaPrice, prices[i], "FWA holds the same price");
        }
    }

    function test_mintFeeDownAndBackUp() public {
        uint256 restock = balancer.restockFeeFor(0);
        assertEq(restock, 0.000695 ether, "V1 restocking fee at 0.5 gwei basefee");
        assertEq(shapes.mintFee(), 0.001 ether, "fork's real Shapes mint fee");
        assertEq(balancer.mintFeeCap(), 0.001 ether);
        (uint256[] memory ids0, uint256[] memory prices0) = _prices();
        (,,, uint112 base0, uint112 price0) = balancer.items(ids0[0]);
        assertEq(base0, 0.0125 ether, "0.01 backing + 0.001 fee + 15% markup");
        assertEq(price0, 0.0125 ether + restock);

        // 1. The live fee falls to 0.0005, below the accepted 0.001. Upkeep mints at the live fee with no creator action.
        _setFee(0.0005 ether);
        _win();
        (uint256 q, uint256 c) = _fill();
        assertEq(q, 1);
        assertEq(c, 0.0105 ether, "exact mint payment at the lower live fee");
        assertEq(balancer.mintFeeCap(), 0.001 ether, "nothing accepted on the creator's behalf");
        (uint112 base1, uint112 price1) = _newest();
        assertEq(base1, 0.012 ether, "new listing: 0.01 backing + 0.0005 fee + 15% markup");
        assertEq(price1, 0.012 ether + restock);
        _assertUnchanged(ids0, prices0);

        // 2. Accept the lower fee with the design unchanged. The reserve prices missing prizes at the accepted cap.
        uint256[] memory two = new uint256[](2);
        two[0] = balancer.getActiveIds()[0];
        two[1] = balancer.getActiveIds()[1];
        vm.prank(creator);
        balancer.unlistShapes(two);
        uint256 atOld = balancer.requiredReserve();
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.InvalidConfig.selector);
        balancer.configure(MARKUP, target, 0.0004 ether); // below the live fee
        _accept(0.0005 ether);
        assertEq(balancer.mintFeeCap(), 0.0005 ether);
        assertEq(balancer.markupBps(), MARKUP);
        assertEq(balancer.target(), target);
        assertEq(atOld - balancer.requiredReserve(), 2 * 0.0005 ether, "two missing Shapes now reserved at the lower cap");
        (uint256[] memory ids1, uint256[] memory prices1) = _prices();
        (q, c) = _fill();
        assertEq(q, 2);
        assertEq(c, 2 * 0.0105 ether);
        assertEq(balancer.getActiveShapes()[0], 20);

        // 3. The fee rises back to 0.001, above the accepted 0.0005: listed prizes keep selling, nothing is minted.
        _setFee(0.001 ether);
        assertEq(balancer.admissionStatus(), 0);
        assertTrue(balancer.canPurchase(buyer));
        _win();
        (q,) = _fill();
        assertEq(q, 0, "a live fee above the cap stops minting");
        assertEq(balancer.getActiveShapes()[0], 19, "the sale was reconciled");
        assertEq(balancer.admissionStatus(), 0, "purchases of listed inventory continue");
        _win();
        upkeep();
        assertEq(balancer.getActiveShapes()[0], 18, "a further purchase was admitted and reconciled");

        // A save that binds the fee the creator saw (0.0005) cannot silently accept the rise.
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.InvalidConfig.selector);
        balancer.configure(MARKUP, target, 0.0005 ether);
        uint256 atLow = balancer.requiredReserve();
        _accept(0.001 ether);
        assertEq(balancer.requiredReserve() - atLow, 2 * 0.0005 ether, "two missing Shapes reserved at the higher cap");
        (q, c) = _fill();
        assertEq(q, 2);
        assertEq(c, 2 * 0.011 ether, "exact mint payment at the restored fee");
        (uint112 base2, uint112 price2) = _newest();
        assertEq(base2, 0.0125 ether);
        assertEq(price2, 0.0125 ether + restock);
        _assertUnchanged(ids0, prices0);
        _assertUnchanged(ids1, prices1);
    }

    /// Creation binds the shown fee the same way: a cap below the live fee reverts the whole creation.
    function test_creationBindsAcceptedFee() public {
        PoolBalancer.CreationConfig memory cfg = PoolBalancer.CreationConfig(MARKUP, 400, target, 0.0009 ether, false);
        vm.prank(stranger);
        vm.expectRevert(PoolBalancer.InvalidConfig.selector);
        factory.createBalancer{value: 1 ether}(bytes32(uint256(7)), cfg, new PoolBalancer.CuratedInput[](0));
        _setFee(0.0005 ether);
        cfg.mintFeeCap = 0.0005 ether;
        vm.prank(stranger);
        PoolBalancer b = PoolBalancer(payable(factory.createBalancer{value: 1 ether}(bytes32(uint256(7)), cfg, new PoolBalancer.CuratedInput[](0))));
        assertEq(b.mintFeeCap(), 0.0005 ether);
    }
}
