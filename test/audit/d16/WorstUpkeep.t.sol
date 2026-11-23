// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {ERC721} from "solady/tokens/ERC721.sol";
import {ForkBase} from "../../utils/ForkBase.sol";
import {GasProbe} from "../../utils/FlowBreakdown.sol";
import {PoolBalancer} from "../../../src/PoolBalancer.sol";

interface IPoolPurchaseCallbackLike {
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

interface IFwaExtra {
    function reservedListingCount(uint64 sequence) external view returns (uint256);
}

/// @notice A curated collection a creator may list (an untrusted third party the system accepts by design). Once armed,
///         every delivery out of the FWA pool burns almost all of FWA's 150k delivery stipend but still succeeds, its
///         ERC-165 probe burns the notifier's 30k probe stipend and its purchase callback burns the 100k callback
///         stipend. It never reverts a delivery: it only makes each settlement as expensive as FWA lets it be.
contract GasHogCollection is ERC721, IPoolPurchaseCallbackLike {
    address public immutable owner;
    address public pool;
    bool public armed;
    uint256 public floor = 12_000;

    constructor() {
        owner = msg.sender;
    }

    function name() public pure override returns (string memory) {
        return "Hog";
    }

    function symbol() public pure override returns (string memory) {
        return "HOG";
    }

    function tokenURI(uint256) public pure override returns (string memory) {
        return "";
    }

    function mint(address to, uint256 id) external {
        require(msg.sender == owner);
        _mint(to, id);
    }

    function arm(address pool_, uint256 floor_) external {
        require(msg.sender == owner);
        (pool, armed, floor) = (pool_, true, floor_);
    }

    function supportsInterface(bytes4 id) public view override returns (bool) {
        if (id == type(IPoolPurchaseCallbackLike).interfaceId) {
            if (armed) while (gasleft() > 3_000) {}
            return true;
        }
        return super.supportsInterface(id);
    }

    function onPoolPurchase(Purchase calldata) external view {
        if (armed) while (true) {}
    }

    function _afterTokenTransfer(address from, address, uint256) internal view override {
        if (armed && from == pool) {
            uint256 f = floor;
            while (gasleft() > f) {}
        }
    }
}

/// @notice D16 re-attack: the most expensive single upkeep reachable with processing added, on the pinned mainnet
///         fork (block 26,382,349), real FWA pool, randomness service, Shapes and Draw Packs. Nobody but players, the
///         randomness service, the creator (listing NFTs) and the keeper acts; the test never processes FWA's queue.
contract D16WorstUpkeepTest is ForkBase {
    // forge runs inherited tests too; the honest subclass reruns these, harmless
    GasHogCollection hog;

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

    function _launchBoard() internal {
        createBalancer(10 ether);
        uint256[16] memory c;
        (c[0], c[9], c[1], c[2], c[3]) = (24, 8, 12, 2, 1); // the launch board
        vm.startPrank(creator);
        balancer.configure(2500, plan16(c), shapes.mintFee());
        vm.stopPrank();
        listCurated(1, 0.2 ether);
        vm.prank(creator);
        balancer.open();
        fillUp();
        assertEq(balancer.admissionStatus(), 0, "open");
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

    /// @dev A word under which processing `upTo` draws gives draw `req` a fulfilled hog. Search aid only: the trial
    ///      is reverted; the real settlement below happens inside the keeper's upkeep.
    function _hogWord(uint256 req, uint256 upTo, bytes memory salt) internal returns (uint256) {
        for (uint256 i; i < 200; ++i) {
            uint256 w = uint256(keccak256(abi.encode(salt, i)));
            uint256 snap = vm.snapshotState();
            fulfill(req, w);
            pool.processAcquisitions(upTo);
            (address coll, uint8 st) = _winner(req);
            vm.revertToState(snap);
            if (coll == address(hog) && st == 2) return w;
        }
        revert("no hog word");
    }

    /// Five draws in flight: draws 1-3 settle on FWA's fast path (no reserved listings), draws 4-5 each reserved a
    /// staged batch of the creator's curated NFTs and wait for processing. Draws 4-5 win the gas-hog collection.
    /// One upkeep then processes 2, reconciles 5 and restocks what draws 1-3 won.
    bool packs3; // draws 1-3 each win a two-Shape pack, so the same upkeep also restocks the most Shape units

    /// @dev Search aid (reverted trial): a word under which FWA's fast path gives draw `req` a 0.02 ETH pack prize.
    function _packWord(uint256 req, uint256 i) internal returns (uint256) {
        for (uint256 k; k < 300; ++k) {
            uint256 w = uint256(keccak256(abi.encode("p", i, k)));
            uint256 snap = vm.snapshotState();
            fulfill(req, w);
            (,,, uint256 lid, uint8 st,) = pool.acquisitions(req);
            (, uint8 d,,,) = balancer.items(lid);
            vm.revertToState(snap);
            if (st == 2 && d == 9) return w;
        }
        revert("no pack word");
    }

    function _build(uint256 hogs, bool armed) internal returns (uint256[5] memory req) {
        _setGas(0.5 gwei, 0.55 gwei);
        hog = new GasHogCollection();
        _launchBoard();
        for (uint256 i; i < 3; ++i) req[i] = buy(buyer, 1)[0];
        for (uint64 s = 1; s <= 3; ++s) assertEq(IFwaExtra(address(pool)).reservedListingCount(pool.lastIssuedSequence() - 3 + s), 0);
        _listHogs(hogs, 100);
        if (armed) hog.arm(address(pool), 12_000);
        req[3] = buy(buyer, 1)[0];
        req[4] = buy(stranger, 1)[0];
        emit log_named_uint("reserved by draw 4", IFwaExtra(address(pool)).reservedListingCount(pool.lastIssuedSequence() - 1));
        emit log_named_uint("reserved by draw 5", IFwaExtra(address(pool)).reservedListingCount(pool.lastIssuedSequence()));
        // draws 1-3: randomness arrives, FWA's fast path settles each (they reserved nothing)
        for (uint256 i; i < 3; ++i) fulfill(req[i], packs3 ? _packWord(req[i], i) : uint256(keccak256(abi.encode("w", i))));
        assertEq(pool.nextSequenceToProcess(), pool.lastIssuedSequence() - 1, "fast path settled draws 1-3 only");
        fulfill(req[3], _hogWord(req[3], 1, "d4"));
        fulfill(req[4], _hogWord(req[4], 2, "d5"));
        assertEq(pool.nextSequenceToProcess(), pool.lastIssuedSequence() - 1, "draws 4-5 ready, unprocessed");
        assertEq(pool.unsettledAcquisitionCount(), 2);
        // decomposition only (reverted): FWA's processing of the two draws on its own, called directly
        uint256 snap = vm.snapshotState();
        uint256 g = gasleft();
        pool.processAcquisitions(2);
        emit log_named_uint("processAcquisitions(2) alone, gas", g - gasleft());
        vm.revertToState(snap);
    }

    function _measure(uint256 basefee, uint256 bid) internal returns (uint256 reward, uint256 billed, uint256 measured) {
        _setGas(basefee, bid);
        bytes32 uh1 = balancer.settingsHash();
        uint256 before = keeper.balance;
        vm.recordLogs();
        vm.prank(keeper, keeper);
        reward = balancer.performUpkeep(uh1, 0, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 q; q < logs.length; ++q) {
            if (logs[q].topics[0] == keccak256("KeeperPaid(address,uint256,uint256)")) {
                (, measured) = abi.decode(logs[q].data, (uint256, uint256));
            }
        }
        (bool ok, bytes memory r) = address(vm).staticcall(abi.encodeWithSignature("lastCallGas()"));
        require(ok, "lastCallGas");
        (, uint64 used,,,) = abi.decode(r, (uint64, uint64, uint64, int64, uint64));
        billed = uint256(used); // pinned five-field 1.8.1: intrinsic and applied refund are already included
        assertEq(keeper.balance - before, reward, "paid");
    }

    function _lastMeasured() internal returns (uint256 measured) {
        // reads the KeeperPaid log recorded since vm.recordLogs()
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 q; q < logs.length; ++q) {
            if (logs[q].topics[0] == keccak256("KeeperPaid(address,uint256,uint256)")) {
                (, measured) = abi.decode(logs[q].data, (uint256, uint256));
            }
        }
    }

    function _report(uint256[5] memory req, uint256 price, uint256 reward, uint256 billed, uint256 measured) internal {
        assertEq(pool.unsettledAcquisitionCount(), 0, "upkeep processed both waiting draws");
        assertEq(balancer.reconciledSequence(), pool.lastIssuedSequence(), "and reconciled all five");
        (address c4, uint8 s4) = _winner(req[3]);
        (address c5, uint8 s5) = _winner(req[4]);
        assertTrue(c4 == address(hog) && c5 == address(hog) && s4 == 2 && s5 == 2, "reached: both processed draws delivered a hog NFT");
        for (uint256 i; i < 3; ++i) {
            (,,, uint256 lid,,) = pool.acquisitions(req[i]);
            (uint8 kind, uint8 d,,,) = balancer.items(lid);
            emit log_named_uint("  draw won kind*100+size (0 = deleted after delivery)", uint256(kind) * 100 + d);
        }
        emit log_named_uint("measured inside performUpkeep (capped at 3.2M)", measured);
        emit log_named_uint("keeper's receipt billed gas", billed);
        emit log_named_uint("reward (wei)", reward);
        emit log_named_uint("keeper cost (wei)", billed * price);
        emit log_named_int("keeper margin (wei)", int256(reward) - int256(billed * price));
        _requireCovered(price, reward, billed, measured);
        // the restock this call left for later: every further call is covered too
        for (uint256 k; k < 5; ++k) {
            uint256 snap = vm.snapshotState();
            bytes32 uh2 = balancer.settingsHash();
            vm.prank(keeper, keeper);
            try balancer.performUpkeep(uh2, 0, 0) {} catch {
                vm.revertToState(snap);
                return;
            }
            vm.revertToState(snap);
            (uint256 r2, uint256 b2, uint256 m2) = _measure(block.basefee, price);
            emit log_named_uint("  next call measured", m2);
            _requireCovered(price, r2, b2, m2);
        }
        revert("upkeep never finished");
    }

    /// Requirement (D16 re-attack F1): the keeper's billed gas is covered by its reward. The measured gas stays near
    /// KEEPER_MAX_GAS (2.98M here; up to 3.22M with 1,024 listings, test/audit/d16b/WorstUpkeepB.t.sol), and storage
    /// refunds keep the billed gas well under it.
    function _requireCovered(uint256 price, uint256 reward, uint256 billed, uint256 measured) internal {
        emit log_named_uint("  measured", measured);
        assertGe(reward, billed * price, "the keeper's billed gas is covered");
    }

    function test_worstUpkeep_hogsReserved_055gwei() public {
        uint256[5] memory req = _build(12, true);
        (uint256 reward, uint256 billed, uint256 measured) = _measure(0.5 gwei, 0.55 gwei);
        _report(req, 0.55 gwei, reward, billed, measured);
    }

    function test_worstUpkeep_hogsReserved_5gwei() public {
        uint256[5] memory req = _build(12, true);
        (uint256 reward, uint256 billed, uint256 measured) = _measure(4.95 gwei, 5 gwei);
        _report(req, 5 gwei, reward, billed, measured);
    }
}

contract D16WorstUpkeepPacksTest is D16WorstUpkeepTest {
    function test_worstUpkeep_hogsReservedPacks_015gwei() public {
        packs3 = true;
        uint256[5] memory req = _build(12, true);
        (uint256 reward, uint256 billed, uint256 measured) = _measure(0.1 gwei, 0.15 gwei);
        _report(req, 0.15 gwei, reward, billed, measured);
    }

    function test_worstUpkeep_hogsReserved_015gwei() public {
        uint256[5] memory req = _build(12, true);
        (uint256 reward, uint256 billed, uint256 measured) = _measure(0.1 gwei, 0.15 gwei);
        _report(req, 0.15 gwei, reward, billed, measured);
    }
}

contract D16WorstUpkeepHonestTest is D16WorstUpkeepTest {
    function test_worstUpkeep_honestCuratedReserved_055gwei() public {
        uint256[5] memory req = _build(12, false);
        (uint256 reward, uint256 billed, uint256 measured) = _measure(0.5 gwei, 0.55 gwei);
        _report(req, 0.55 gwei, reward, billed, measured);
    }
}
