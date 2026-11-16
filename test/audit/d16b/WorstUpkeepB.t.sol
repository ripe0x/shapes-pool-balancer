// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {ERC721} from "solady/tokens/ERC721.sol";
import {ForkBase} from "../../utils/ForkBase.sol";
import {GasProbe} from "../../utils/FlowBreakdown.sol";
import {PoolBalancer} from "../../../src/PoolBalancer.sol";

interface IPoolPurchaseCallbackId {
    struct Purchase {
        address pool;
        uint256 requestId;
        uint256 listingId;
        uint256 tokenId;
        address purchaser;
        address resolver;
        address paymentToken;
        uint256 amountPaid;
        uint256 listingPrice;
        uint256 randomWord;
    }

    function onPoolPurchase(Purchase calldata purchase) external;
}

interface IFWAPurchaseCallbackLike {
    function onFWAPurchase(address, uint256, address, address, uint256, uint256, uint8) external;
}

interface IFwaExtra2 {
    function reservedListingCount(uint64 sequence) external view returns (uint256);
}

/// @notice Hostile curated collection (accepted by design): burns both notifier ERC-165 probes (answers "no" to the
///         first so the notifier probes the second), the 100k callback stipend and FWA's 150k delivery stipend.
contract ProbeHog is ERC721 {
    address public immutable owner;
    address public pool;
    bool public armed;

    constructor() {
        owner = msg.sender;
    }

    function name() public pure override returns (string memory) {
        return "PHog";
    }

    function symbol() public pure override returns (string memory) {
        return "PHOG";
    }

    function tokenURI(uint256) public pure override returns (string memory) {
        return "";
    }

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }

    bool public failDelivery;

    function arm(address pool_) external {
        (pool, armed) = (pool_, true);
    }

    function setFailDelivery() external {
        failDelivery = true;
    }

    function supportsInterface(bytes4 id) public view override returns (bool) {
        if (id == type(IPoolPurchaseCallbackId).interfaceId) {
            if (armed) while (gasleft() > 3_000) {}
            return false;
        }
        if (id == type(IFWAPurchaseCallbackLike).interfaceId) {
            if (armed) while (gasleft() > 3_000) {}
            return true;
        }
        return super.supportsInterface(id);
    }

    function onFWAPurchase(address, uint256, address, address, uint256, uint256, uint8) external view {
        if (armed) while (true) {}
    }

    function _afterTokenTransfer(address from, address, uint256) internal view override {
        if (armed && from == pool) {
            while (gasleft() > 12_000) {}
            if (failDelivery) revert();
        }
    }
}

/// @notice D16 re-attack B: the worst upkeep with (a) the notifier's double ERC-165 probe burned, (b) the reserved
///         activations landing on fresh segment-tree slots at a power-of-two boundary (zero-to-nonzero tree writes).
contract D16bWorstUpkeepTest is ForkBase {
    ProbeHog hog;
    bool anyStatus; // search aid accepts a hog won with failed delivery

    function setUp() public {
        setUpFork();
    }

    function _setGas(uint256 basefee, uint256 bid) internal {
        vm.fee(basefee);
        vm.txGasPrice(bid);
        GasProbe probe = new GasProbe();
        probe.record();
        assertEq(probe.baseFee(), basefee, "basefee inside a transaction");
        assertEq(probe.gasPrice(), bid, "gas price inside a transaction");
    }

    function _listHogs(uint256 n, uint256 firstId) internal {
        PoolBalancer.CuratedInput[] memory in_ = new PoolBalancer.CuratedInput[](n);
        for (uint256 i; i < n; ++i) {
            hog.mint(creator, firstId + i);
            vm.prank(creator);
            hog.approve(address(balancer), firstId + i);
            in_[i] = PoolBalancer.CuratedInput(address(hog), firstId + i, 0.01 ether);
        }
        vm.prank(creator);
        balancer.listCuratedBatch(in_);
    }

    function _winner(uint256 req) internal view returns (address coll, uint8 st) {
        uint256 lid;
        (,,, lid, st,) = pool.acquisitions(req);
        if (lid != 0) (coll,,,,,,,) = pool.listings(lid);
    }

    function _hogWord(uint256 req, uint256 upTo, bytes memory salt) internal returns (uint256) {
        for (uint256 i; i < 400; ++i) {
            uint256 w = uint256(keccak256(abi.encode(salt, i)));
            uint256 snap = vm.snapshotState();
            fulfill(req, w);
            pool.processAcquisitions(upTo);
            (address coll, uint8 st) = _winner(req);
            vm.revertToState(snap);
            if (coll == address(hog) && (st == 2 || (anyStatus && st != 0))) return w;
        }
        revert("no hog word");
    }

    /// @dev `pad` extra plain curated listings before play, so FWA's fresh slots start where the test wants.
    function _build(uint256 pad) internal returns (uint256[5] memory req) {
        _setGas(0.5 gwei, 0.55 gwei);
        hog = new ProbeHog();
        createBalancer(10 ether);
        uint256[16] memory c;
        (c[0], c[9], c[1], c[2], c[3]) = (24, 8, 12, 2, 1);
        vm.prank(creator);
        balancer.configure(2500, plan16(c));
        listCurated(1, 0.2 ether);
        for (uint256 i; i < pad; ++i) listCurated(1000 + i, 0.2 ether);
        vm.prank(creator);
        balancer.open();
        fillUp();
        assertEq(balancer.admissionStatus(), 0, "open");
        emit log_named_uint("listings before play (all active, no removals)", lastListingId());
        for (uint256 i; i < 3; ++i) req[i] = buy(buyer, 1)[0];
        _listHogs(12, 100);
        hog.arm(address(pool));
        req[3] = buy(buyer, 1)[0];
        req[4] = buy(stranger, 1)[0];
        assertEq(IFwaExtra2(address(pool)).reservedListingCount(pool.lastIssuedSequence() - 1), 6);
        assertEq(IFwaExtra2(address(pool)).reservedListingCount(pool.lastIssuedSequence()), 6);
        for (uint256 i; i < 3; ++i) fulfill(req[i], uint256(keccak256(abi.encode("w", i))));
        assertEq(pool.nextSequenceToProcess(), pool.lastIssuedSequence() - 1, "fast path settled draws 1-3 only");
        fulfill(req[3], _hogWord(req[3], 1, "d4"));
        fulfill(req[4], _hogWord(req[4], 2, "d5"));
        assertEq(pool.unsettledAcquisitionCount(), 2);
    }

    function _measure(uint256 basefee, uint256 bid) internal returns (uint256 reward, uint256 billed, uint256 measured) {
        _setGas(basefee, bid);
        bytes32 uh1 = balancer.settingsHash();
        uint256 before = keeper.balance;
        vm.recordLogs();
        vm.prank(keeper, keeper);
        reward = balancer.performUpkeep(uh1);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 q; q < logs.length; ++q) {
            if (logs[q].topics[0] == keccak256("KeeperPaid(address,uint256,uint256)")) {
                (, measured) = abi.decode(logs[q].data, (uint256, uint256));
            }
        }
        (bool ok, bytes memory r) = address(vm).staticcall(abi.encodeWithSignature("lastCallGas()"));
        require(ok);
        (, uint64 used,, int64 refunded,) = abi.decode(r, (uint64, uint64, uint64, int64, uint64));
        billed = uint256(used) + 21_000;
        emit log_named_int("refunded", refunded);
        emit log_named_uint("execution gas before refund (used+refunded)", uint256(used) + uint256(int256(refunded)));
        assertEq(keeper.balance - before, reward, "paid");
    }

    function _run(uint256 pad) internal {
        uint256[5] memory req = _build(pad);
        {
            uint256 snap = vm.snapshotState();
            uint256 g0 = gasleft();
            pool.processAcquisitions(2);
            emit log_named_uint("processAcquisitions(2) alone", g0 - gasleft());
            vm.revertToState(snap);
            snap = vm.snapshotState();
            _setGas(0.5 gwei, 0.55 gwei);
            bytes32 uh2 = balancer.settingsHash();
            vm.prank(keeper, keeper);
            g0 = gasleft();
            balancer.performUpkeep(uh2);
            emit log_named_uint("performUpkeep uncapped, from caller frame", g0 - gasleft());
            vm.revertToState(snap);
        }
        (uint256 reward, uint256 billed, uint256 measured) = _measure(0.5 gwei, 0.55 gwei);
        assertEq(pool.unsettledAcquisitionCount(), 0, "processed both");
        (address c4, uint8 s4) = _winner(req[3]);
        (address c5, uint8 s5) = _winner(req[4]);
        assertTrue(c4 == address(hog) && c5 == address(hog) && s4 == 2 && s5 == 2, "reached: both delivered a hog");
        emit log_named_uint("measured inside performUpkeep", measured);
        emit log_named_uint("billed incl 21000", billed);
        emit log_named_uint("reward wei", reward);
        emit log_named_int("headroom under 3.2M", int256(3_200_000) - int256(measured));
        // Requirement (D16 re-attack 2, finding 2): the measured gas may pass KEEPER_MAX_GAS here (storage refunds
        // keep the billed gas well under it); the keeper's billed gas is covered at every reimbursed price.
        uint256[3] memory prices = [uint256(0.15 gwei), 0.55 gwei, 5 gwei];
        uint256 m = measured < 3_200_000 ? measured : 3_200_000;
        for (uint256 k; k < 3; ++k) {
            assertGe((m + 50_000) * prices[k] + 0.0001 ether, billed * prices[k], "the keeper's billed gas is covered");
        }
    }

    function test_probeHog_noPad() public {
        _run(0);
    }

    /// 48 launch listings + 16 = 64: fresh slots start at 65 (seven fresh tree nodes for the first)
    function test_probeHog_pad16() public {
        _run(16);
    }

    /// 48 + 80 = 128: fresh slots start at 129
    function test_probeHog_pad80() public {
        _run(80);
    }

    /// pad so the 3 freed slots and 9 fresh slots cross 64 later in the batch
    function test_probeHog_pad13() public {
        _run(13);
    }

    function test_probeHog_pad208() public {
        _run(208);
    }

    function test_probeHog_pad336() public {
        _run(336);
    }

    function test_probeHog_pad976() public {
        _run(976);
    }

    function test_probeHog_pad464() public {
        _run(464);
    }

    /// Unlimited curated NFTs (decision 89, audit rc-f5c81d6): FWA's selection tree deepens by one level each time the
    /// listings pass a power of two. 48 + 2,000 = 2,048: fresh slots start at 2,049 (12 levels).
    function test_probeHog_pad2000() public {
        _run(2000);
    }

    /// 48 + 4,048 = 4,096: fresh slots start at 4,097 (13 levels).
    function test_probeHog_pad4048() public {
        _run(4048);
    }
}
