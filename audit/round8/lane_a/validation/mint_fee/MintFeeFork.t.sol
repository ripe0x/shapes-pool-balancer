// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {PoolBalancer} from "../../../../../src/PoolBalancer.sol";
import {BalancerFactory} from "../../../../../src/BalancerFactory.sol";
import {ShapePacks} from "packs/ShapePacks.sol";
import {ShapePackRenderer} from "packs/ShapePackRenderer.sol";

interface ILiveShapesFee {
    function admin() external view returns (address);
    function mintFee() external view returns (uint256);
    function setMintFee(uint256 newFee) external;
    function feeRecipient() external view returns (address);
    function pendingFees() external view returns (uint256);
    function feesOwedTo(address recipient) external view returns (uint256);
    function redeemableBacking() external view returns (uint256);
    function withdrawFees(address recipient) external;
}

contract FeeCreator is ERC721 {
    PoolBalancer public balancer;

    constructor() ERC721("Fee Creator Curated", "FCC") { _mint(address(this), 1); }

    receive() external payable {}

    function makePool(BalancerFactory factory) external payable {
        balancer = PoolBalancer(payable(factory.createBalancer{value: msg.value}(bytes32(uint256(1001)))));
        balancer.configure(0, 1);
        this.approve(address(balancer), 1);
    }

    function list() external returns (uint256) { return balancer.listCurated(address(this), 1, 0.1 ether); }
    function configure(uint256 target) external { balancer.configure(0, target); }
    function open() external { balancer.open(); }
    function close() external { balancer.close(); }
    function unlist(uint256[] calldata ids) external { balancer.unlistShapes(ids); }
    function claimAll() external { balancer.claimSurplus(address(balancer).balance, address(this)); }
}

contract MintFeeForkTest is Test {
    address constant FWA_FACTORY = 0x8919814D825a5Af238cC04DE06b1C18c9eaA477C;
    address constant FWA_IMPL = 0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7;
    bytes32 constant FWA_CODEHASH = 0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02;
    address constant SHAPES = 0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0;
    address constant ENS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    address constant ADMIN = 0xCB43078C32423F5348Cab5885911C3B5faE217F9;
    address constant RECIPIENT = 0xD4ba7cA95f3983514DDa317C4428CDb8F59c7e72;
    address constant KEEPER = address(0xBEEF);

    ILiveShapesFee shapes = ILiveShapesFee(SHAPES);
    FeeCreator creator;
    PoolBalancer balancer;

    function setUp() public {
        vm.fee(1 gwei);
        vm.txGasPrice(1.05 gwei);
        assertEq(KEEPER.code.length, 0);
        assertEq(shapes.admin(), ADMIN);
        assertEq(shapes.feeRecipient(), RECIPIENT);
        assertEq(shapes.mintFee(), 0.001 ether);
        assertEq(
            keccak256(ADMIN.code),
            keccak256(hex"ef0100612373d7003d694220f7800eeaf8e3924c0951d3"),
            "admin is not the pinned EIP-7702 delegated external account"
        );
        vm.deal(address(this), 3 ether);
        vm.deal(KEEPER, 1 ether);
        ShapePackRenderer renderer = new ShapePackRenderer(SHAPES);
        ShapePacks packs = new ShapePacks(SHAPES, address(renderer), address(this), "Pool Prize Packs", "PRIZEPACK", 2);
        PoolBalancer impl = new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, address(packs), ENS);
        BalancerFactory factory = new BalancerFactory(address(impl), address(this));
        creator = new FeeCreator();
        creator.makePool{value: 2 ether}(factory);
        balancer = creator.balancer();
    }

    function testRealAdminFeeRisePausesThenCreatorAcceptsAndFeesReachRecipient() public {
        creator.list();
        creator.open();
        uint256 initialPending = shapes.pendingFees();
        uint256 initialOwed = shapes.feesOwedTo(RECIPIENT);
        uint256 initialBacking = shapes.redeemableBacking();
        vm.prank(KEEPER);
        balancer.performUpkeep();
        assertEq(balancer.admissionStatus(), 0);
        assertEq(balancer.mintFeeCap(), 0.001 ether);
        assertEq(shapes.pendingFees() - initialPending, 0.001 ether);
        assertEq(shapes.redeemableBacking() - initialBacking, 0.01 ether);

        uint256 reserveBeforeFirstRise = balancer.requiredReserve();
        vm.prank(ADMIN); // Real external EIP-7702 delegated account, not a protocol contract.
        shapes.setMintFee(0.005 ether);
        assertEq(shapes.mintFee(), 0.005 ether);
        assertEq(balancer.admissionStatus(), 5, "live mint fee above creator cap should close admission");
        assertFalse(balancer.canPurchase(address(0xB0B)));
        assertGt(balancer.requiredReserve(), reserveBeforeFirstRise);
        vm.prank(KEEPER);
        vm.expectRevert(PoolBalancer.NoUpkeepNeeded.selector);
        balancer.performUpkeep();

        creator.configure(2);
        assertEq(balancer.mintFeeCap(), 0.005 ether);
        assertEq(balancer.admissionStatus(), 2, "creator work must finish before admission");
        vm.prank(KEEPER);
        balancer.performUpkeep();
        assertEq(balancer.admissionStatus(), 0);
        assertEq(shapes.pendingFees() - initialPending, 0.006 ether);
        assertEq(shapes.redeemableBacking() - initialBacking, 0.02 ether);

        creator.configure(3); // Missing third Shape at the accepted 0.005 ETH fee.
        assertTrue(balancer.creatorWork());
        vm.prank(ADMIN);
        shapes.setMintFee(0.01 ether);
        assertEq(shapes.mintFee(), 0.01 ether);
        assertEq(balancer.mintFeeCap(), 0.005 ether);
        assertEq(balancer.admissionStatus(), 2, "creator-work status has priority over fee-rise status");
        vm.prank(KEEPER);
        vm.expectRevert(PoolBalancer.NoUpkeepNeeded.selector);
        balancer.performUpkeep();
        assertTrue(balancer.creatorWork(), "unaccepted fee rise unexpectedly cleared missing work");

        creator.configure(3);
        assertEq(balancer.mintFeeCap(), 0.01 ether);
        vm.prank(KEEPER);
        balancer.performUpkeep();
        assertEq(balancer.admissionStatus(), 0);
        assertEq(shapes.pendingFees() - initialPending, 0.016 ether);
        assertEq(shapes.feesOwedTo(RECIPIENT) - initialOwed, 0.016 ether);
        assertEq(shapes.redeemableBacking() - initialBacking, 0.03 ether);

        creator.close();
        uint256[] memory ids = balancer.getActiveIds();
        assertEq(ids.length, 4, "three Shapes and one curated item expected");
        uint256[] memory shapeIds = new uint256[](3);
        uint256 n;
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind,,,,) = balancer.items(ids[i]);
            if (kind == 2) shapeIds[n++] = ids[i];
        }
        assertEq(n, 3);
        uint256 liquidBeforeUnlist = address(balancer).balance;
        creator.unlist(shapeIds);
        assertEq(address(balancer).balance - liquidBeforeUnlist, 0.03 ether);
        assertEq(shapes.redeemableBacking(), initialBacking);
        assertEq(shapes.pendingFees() - initialPending, 0.016 ether, "unlisting refunded fees to the wrong party");

        uint256 owedBeforeWithdrawal = shapes.feesOwedTo(RECIPIENT);
        uint256 recipientBefore = RECIPIENT.balance;
        shapes.withdrawFees(RECIPIENT); // Permissionless, payout only to Shapes' configured recipient.
        assertEq(RECIPIENT.balance - recipientBefore, owedBeforeWithdrawal);
        assertEq(shapes.feesOwedTo(RECIPIENT), 0);
        assertEq(shapes.pendingFees(), initialPending + 0.016 ether - owedBeforeWithdrawal);

        uint256 creatorBefore = address(creator).balance;
        uint256 liquid = address(balancer).balance;
        creator.claimAll();
        assertEq(address(creator).balance - creatorBefore, liquid);
        assertEq(address(balancer).balance, 0);
        console2.log("initial/first/second admin mint fees wei", uint256(0.001 ether), uint256(0.005 ether), uint256(0.01 ether));
        console2.log("three minted Shapes fee delta wei", uint256(0.016 ether));
        console2.log("Shapes fee recipient payout wei", owedBeforeWithdrawal);
        console2.log("Shapes backing returned on unlist wei", uint256(0.03 ether));
        console2.log("creator liquid claim wei", liquid);
    }
}
