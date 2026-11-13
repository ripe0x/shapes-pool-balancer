// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {PoolBalancer} from "../../../../../src/PoolBalancer.sol";
import {BalancerFactory} from "../../../../../src/BalancerFactory.sol";
import {IFWAPool} from "../../../../../src/interfaces/External.sol";
import {ShapePacks} from "packs/ShapePacks.sol";
import {ShapePackRenderer} from "packs/ShapePackRenderer.sol";

interface ISurfaceVRFService {
    function coordinator() external view returns (address);
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata words) external;
}

interface ISurfaceENSRegistry {
    function owner(bytes32 node) external view returns (address);
    function resolver(bytes32 node) external view returns (address);
}

interface ISurfaceReverseRegistrar {
    function node(address addr) external view returns (bytes32);
}

interface ISurfaceNameResolver {
    function name(bytes32 node) external view returns (string memory);
}

contract SurfaceCreator is ERC721 {
    PoolBalancer public balancer;

    constructor() ERC721("Surface Curated", "SC") { _mint(address(this), 1); }

    receive() external payable {}

    function makePool(BalancerFactory factory) external payable {
        balancer = PoolBalancer(payable(factory.createBalancer{value: msg.value}(bytes32(uint256(801)))));
        balancer.configure(0, 1);
        this.approve(address(balancer), 1);
    }

    function list() external returns (uint256) { return balancer.listCurated(address(this), 1, 0.1 ether); }
    function open() external { balancer.open(); }
    function close() external { balancer.close(); }
    function unlist(uint256[] calldata ids) external { balancer.unlistShapes(ids); }
    function claimAll(address to) external { balancer.claimSurplus(address(balancer).balance, to); }
    function approvePage(string calldata issuedAt, bytes32 metadataHash) external returns (bytes32) {
        return balancer.approvePoolPage(issuedAt, metadataHash);
    }
    function revokePages() external { balancer.revokePoolPages(); }
    function setName(string calldata name) external { balancer.setENSName(name); }
}

contract SurfaceEdgesForkTest is Test {
    address constant FWA_FACTORY = 0x8919814D825a5Af238cC04DE06b1C18c9eaA477C;
    address constant FWA_IMPL = 0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7;
    bytes32 constant FWA_CODEHASH = 0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02;
    address constant SHAPES = 0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0;
    address constant ENS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    address constant VRF_SERVICE = 0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d;
    address constant COORDINATOR = 0xD7f86b4b8Cae7D942340FF628F82735b7a20893a;
    bytes32 constant REVERSE_NODE = 0x91d1777781884d03a6757a803996e38de2a42967fb37eeaca72729271025a9e2;
    address constant PLAYER = address(0xB0B);
    address constant DONOR = address(0xD0D0);
    address constant KEEPER = address(0xBEEF);

    SurfaceCreator creator;
    PoolBalancer balancer;
    IFWAPool pool;
    ShapePacks packs;

    function setUp() public {
        vm.fee(1 gwei);
        vm.txGasPrice(1.05 gwei);
        assertEq(PLAYER.code.length, 0);
        assertEq(DONOR.code.length, 0);
        assertEq(KEEPER.code.length, 0);
        assertEq(ISurfaceVRFService(VRF_SERVICE).coordinator(), COORDINATOR);
        vm.deal(address(this), 4 ether);
        vm.deal(PLAYER, 1 ether);
        vm.deal(DONOR, 1 ether);
        vm.deal(KEEPER, 1 ether);
        ShapePackRenderer renderer = new ShapePackRenderer(SHAPES);
        packs = new ShapePacks(SHAPES, address(renderer), address(this), "Pool Prize Packs", "PRIZEPACK", 2);
        PoolBalancer impl = new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, address(packs), ENS);
        BalancerFactory factory = new BalancerFactory(address(impl), address(this));
        creator = new SurfaceCreator();
        creator.makePool{value: 2 ether}(factory);
        balancer = creator.balancer();
        pool = balancer.pool();
    }

    function testFourForbiddenRecipientsUnder100kGasAndRevokePages() public {
        creator.list();
        creator.open();
        vm.prank(KEEPER);
        balancer.performUpkeep();
        assertEq(balancer.admissionStatus(), 0);
        assertTrue(balancer.canPurchase(PLAYER));
        address[4] memory forbidden = [address(balancer), SHAPES, address(packs), address(pool)];
        for (uint256 i; i < forbidden.length; ++i) {
            (bool ok, bytes memory result) = address(balancer).staticcall{gas: 100_000}(
                abi.encodeCall(PoolBalancer.canPurchase, (forbidden[i]))
            );
            assertTrue(ok, "forbidden-recipient hook exceeded 100k gas");
            assertFalse(abi.decode(result, (bool)), "forbidden recipient admitted");
        }
        (bool ordinaryOk, bytes memory ordinaryResult) = address(balancer).staticcall{gas: 100_000}(
            abi.encodeCall(PoolBalancer.canPurchase, (PLAYER))
        );
        assertTrue(ordinaryOk, "ordinary hook exceeded 100k gas");
        assertTrue(abi.decode(ordinaryResult, (bool)), "ordinary player refused");
        (uint256 fee,, uint256 total) = pool.quoteAcquisitionPrice(1);
        uint256 version = pool.inventoryVersion();
        uint256 payerBefore = PLAYER.balance;
        for (uint256 i; i < forbidden.length; ++i) {
            vm.prank(PLAYER);
            vm.expectRevert();
            pool.acquire{value: total}(
                forbidden[i], fee, 0, 10_000, version, block.timestamp + 1 days
            );
        }
        assertEq(PLAYER.balance, payerBefore, "a forbidden FWA attempt charged the payer");

        bytes32 digest = creator.approvePage("2026-11-10T12:34:56.789Z", keccak256("surface-page"));
        assertEq(balancer.isValidSignature(digest, ""), bytes4(0x1626ba7e));
        uint256 epochBefore = balancer.pageEpoch();
        vm.prank(PLAYER);
        vm.expectRevert();
        balancer.revokePoolPages();
        creator.revokePages();
        assertEq(balancer.pageEpoch(), epochBefore + 1);
        assertEq(balancer.isValidSignature(digest, ""), bytes4(0xffffffff));
        bytes32 digestAgain = creator.approvePage("2026-11-10T12:34:56.789Z", keccak256("surface-page"));
        assertEq(digestAgain, digest);
        assertEq(balancer.isValidSignature(digest, ""), bytes4(0x1626ba7e));
        console2.log("four forbidden hook recipients rejected under 100k gas");
        console2.log("page epoch after revoke", balancer.pageEpoch());
    }

    function testDirectCollectProceedsAndDonorDepositRoundTrip() public {
        uint256 curatedId = creator.list();
        creator.open();
        vm.prank(KEEPER);
        balancer.performUpkeep();
        (uint256 fee, uint256 vrf, uint256 total) = pool.quoteAcquisitionPrice(1);
        uint256 version = pool.inventoryVersion();
        uint256 playerBefore = PLAYER.balance;
        vm.prank(PLAYER);
        uint256 request = pool.acquire{value: total}(
            PLAYER, fee, 0, 10_000, version, block.timestamp + 1 days
        );
        assertEq(playerBefore - PLAYER.balance, total);
        vm.roll(block.number + 1);
        uint256 trials = _selectCurated(request, curatedId);
        (,,, uint256 selected, uint8 acquisitionStatus,) = pool.acquisitions(request);
        assertEq(selected, curatedId);
        assertEq(acquisitionStatus, 2);
        assertEq(creator.ownerOf(1), PLAYER);
        uint256 proceeds = pool.ownerProceeds();
        assertGt(proceeds, 0);
        uint256 beforeCollect = address(balancer).balance;
        vm.prank(DONOR);
        uint256 collected = balancer.collectProceeds();
        assertEq(collected, proceeds);
        assertEq(pool.ownerProceeds(), 0);
        assertEq(address(balancer).balance - beforeCollect, proceeds);
        vm.prank(DONOR);
        assertEq(balancer.collectProceeds(), 0);

        uint256 donorBefore = DONOR.balance;
        uint256 deposit = 0.123 ether;
        vm.prank(DONOR);
        balancer.depositETH{value: deposit}();
        assertEq(donorBefore - DONOR.balance, deposit);
        assertEq(address(balancer).balance, beforeCollect + proceeds + deposit);
        vm.prank(KEEPER);
        balancer.performUpkeep(); // Direct collection does not reconcile the drawn local listing.
        assertEq(balancer.reconciledSequence(), pool.lastIssuedSequence());
        creator.close();
        uint256[] memory ids = balancer.getActiveIds();
        assertEq(ids.length, 1);
        uint256 beforeUnlist = address(balancer).balance;
        creator.unlist(ids);
        assertEq(address(balancer).balance - beforeUnlist, 0.01 ether);
        uint256 claim = address(balancer).balance;
        uint256 creatorBefore = address(creator).balance;
        creator.claimAll(address(creator));
        assertEq(address(creator).balance - creatorBefore, claim);
        assertEq(address(balancer).balance, 0);
        console2.log("direct collected owner proceeds wei", proceeds);
        console2.log("donor deposit wei", deposit);
        console2.log("creator final claim wei", claim);
        console2.log("player VRF fee wei", vrf);
        console2.log("curated word trials", trials);
    }

    function testSetENSNameThroughLiveReverseRegistrar() public {
        address registrar = ISurfaceENSRegistry(ENS).owner(REVERSE_NODE);
        assertGt(registrar.code.length, 0, "live reverse registrar unavailable");
        vm.prank(PLAYER);
        vm.expectRevert();
        balancer.setENSName("unauthorized.eth");
        creator.setName("surface-audit.eth");
        bytes32 node = ISurfaceReverseRegistrar(registrar).node(address(balancer));
        address resolver = ISurfaceENSRegistry(ENS).resolver(node);
        assertGt(resolver.code.length, 0, "live reverse resolver unavailable");
        assertEq(ISurfaceNameResolver(resolver).name(node), "surface-audit.eth");
        creator.setName("");
        assertEq(ISurfaceNameResolver(resolver).name(node), "");
        console2.log("live ENS reverse registrar", registrar);
        console2.log("live ENS reverse resolver", resolver);
    }

    function _selectCurated(uint256 request, uint256 wantedId) internal returns (uint256) {
        for (uint256 candidate = 1; candidate <= 5_000; ++candidate) {
            uint256 snapshot = vm.snapshotState();
            uint256[] memory words = new uint256[](1);
            words[0] = uint256(keccak256(abi.encodePacked("surface-curated", request, candidate)));
            vm.prank(COORDINATOR);
            ISurfaceVRFService(VRF_SERVICE).rawFulfillRandomWords(request, words);
            pool.processAcquisitions(5);
            (,,, uint256 selected,,) = pool.acquisitions(request);
            if (selected == wantedId) return candidate;
            vm.revertToState(snapshot);
        }
        fail("curated outcome not reached");
        return 0;
    }
}
