// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "../utils/ForkBase.sol";
import {PoolBalancer} from "../../src/PoolBalancer.sol";
import {console} from "forge-std/console.sol";

interface IShapesAdmin {
    function admin() external view returns (address);
    function setMintFee(uint256) external;
    function mintFee() external view returns (uint256);
}

/// @dev Gas context probe: reads tx.gasprice and basefee from inside a state-changing call.
contract Probe {
    uint256 public gp;
    uint256 public bf;

    function hit() external {
        gp = tx.gasprice;
        bf = block.basefee;
    }
}

/// Step-B uninformed audit attacks. Real FWA, Shapes, VRF service; own Draw Packs instance as deployed by Deploy.s.sol.
contract AttackB is ForkBase {
    uint8 constant SHAPE_KIND = 2;
    Probe probe;

    function setUp() public {
        setUpFork();
        probe = new Probe();
    }

    function _gas(uint256 basefee, uint256 price) internal {
        vm.fee(basefee);
        vm.txGasPrice(price);
        probe.hit();
        assertEq(probe.gp(), price, "tx.gasprice reached the call");
        assertEq(probe.bf(), basefee, "basefee reached the call");
    }

    function _launchBoard() internal pure returns (uint256[16] memory c) {
        // the shipped launch board (FlowBreakdown._launch): 24 x 0.01, 8 x 0.02 pack, 12 x 0.05, 2 x 0.1, 1 x 0.5
        (c[0], c[9], c[1], c[2], c[3]) = (24, 8, 12, 2, 1);
    }

    function _open(uint256[16] memory c, uint16 markup, uint256 deposit, uint256 nftBase) internal {
        createBalancer(deposit);
        vm.prank(creator);
        balancer.configure(markup, plan16(c));
        listCurated(1, nftBase);
        vm.prank(creator);
        balancer.open();
        for (uint256 i; i < 200; ++i) {
            vm.prank(keeper, keeper);
            try balancer.performUpkeep() {} catch { break; }
        }
        assertEq(balancer.admissionStatus(), 0, "open");
    }

    /// @dev FWA all-in quote for one draw against the Shape backing weighted as FWA weighs draws (O10's metric).
    function _ratioBps() internal view returns (uint256) {
        (,, uint256 total) = pool.quoteAcquisitionPrice(1);
        uint256 w;
        uint256 wb;
        uint256[] memory ids = balancer.getActiveIds();
        for (uint256 k; k < ids.length; ++k) {
            (,,,, uint256 weight,,, uint8 st) = pool.listings(ids[k]);
            if (st != 1) continue;
            w += weight;
            (uint8 kind, uint8 d,,,) = balancer.items(ids[k]);
            if (kind == SHAPE_KIND) wb += weight * balancer.denominationAmount(d);
        }
        return total * 10_000 * w / wb;
    }

    // ---------------------------------------------------------------- R19 / O10 at the creator's bounds

    function test_O10_launchBoardAtMaxMarkup() public {
        _gas(0.1 gwei, 0.15 gwei);
        _open(_launchBoard(), 10_000, 10 ether, 0.2 ether);
        _gas(0.1 gwei, 0.15 gwei);
        uint256 r = _ratioBps();
        console.log("launch board, markup 100%, basefee 0.1 gwei: price/backing bps", r);
        assertGt(r, 15_000, "exceeds O10's 1.5x");
    }

    function test_O10_launchBoardAtMinMarkup() public {
        _gas(0.1 gwei, 0.15 gwei);
        _open(_launchBoard(), 1_000, 10 ether, 0.2 ether);
        _gas(0.1 gwei, 0.15 gwei);
        console.log("launch board, markup 10%, basefee 0.1 gwei: price/backing bps", _ratioBps());
    }

    function test_O10_smallestBoard() public {
        uint256[16] memory c;
        c[0] = 1;
        _gas(0.1 gwei, 0.15 gwei);
        _open(c, 2_500, 1 ether, 0.2 ether);
        _gas(0.1 gwei, 0.15 gwei);
        console.log("one 0.01 Shape, markup 25%, basefee 0.1 gwei: price/backing bps", _ratioBps());
    }

    /// @dev The launch board turns over during a gas spike at the 5 gwei cap, then gas returns to 0.1 gwei. Prices are
    ///      fixed at listing, so the restocking fee of the spike stays in every prize relisted then.
    function test_O10_afterSpike() public {
        _gas(0.1 gwei, 0.15 gwei);
        _open(_launchBoard(), 2_500, 10 ether, 0.2 ether);
        uint256 before = _ratioBps();
        _gas(4.95 gwei, 5 gwei);
        uint256 sold;
        for (uint256 i; i < 60; ++i) {
            if (balancer.admissionStatus() != 0) break;
            uint256[] memory r = buy(buyer, 1);
            fulfill(r[0], uint256(keccak256(abi.encode("spike", i))));
            settle();
            fillUp();
            ++sold;
            // the curated NFT may be won: relist one so the gate stays open
            if (balancer.admissionStatus() == 3) listCurated(100 + i, 0.2 ether);
        }
        _gas(0.1 gwei, 0.15 gwei);
        uint256 afterSpike = _ratioBps();
        console.log("draws sold during the spike", sold);
        console.log("ratio at 0.1 gwei before the spike (bps)", before);
        console.log("ratio at 0.1 gwei after the spike (bps)", afterSpike);
        assertGt(afterSpike, 15_000, "player pays over 1.5x at normal gas after a spike");
    }

    /// @dev The launch board plus 20 curated NFTs the creator values at 50 ETH each (worthless in fact): each is won
    ///      almost never, yet each raises FWA's harmonic draw price for every player.
    function test_O10_overpricedCurated() public {
        _gas(0.1 gwei, 0.15 gwei);
        _open(_launchBoard(), 2_500, 10 ether, 0.2 ether);
        uint256 before = _ratioBps();
        PoolBalancer.CuratedInput[] memory in_ = new PoolBalancer.CuratedInput[](20);
        vm.startPrank(creator);
        for (uint256 k; k < 20; ++k) {
            nft.mint(creator, 900 + k);
            nft.approve(address(balancer), 900 + k);
            in_[k] = PoolBalancer.CuratedInput(address(nft), 900 + k, 50 ether);
        }
        balancer.listCuratedBatch(in_);
        vm.stopPrank();
        _gas(0.1 gwei, 0.15 gwei);
        (uint256 fee0,,) = pool.quoteAcquisitionPrice(1);
        console.log("ratio before (bps)", before);
        console.log("ratio with 20 curated at 50 ETH (bps)", _ratioBps());
        console.log("draw price now (wei)", fee0);
        assertEq(balancer.admissionStatus(), 0, "still admitted");
    }

    // ---------------------------------------------------------------- R6 / R7 / R8: a creator who claims the maximum

    /// @dev Launch board at 0.5 gwei; after every draw and upkeep the creator claims everything claimable. Records how
    ///      much of the collected proceeds the creator took, how much of it was the `profit` counter (the 90/10 split
    ///      of markup above the reserve), and the creator's net after a closeout.
    function test_R7_maxClaimingCreator() public {
        _gas(0.5 gwei, 0.55 gwei);
        uint256 dep = 10 ether;
        _open(_launchBoard(), 2_500, dep, 0.2 ether);
        uint256 claimed;
        uint256 proceeds;
        uint256 creditedTotal;
        uint256 nftLost;
        uint256 wonBacking;
        uint256 markupAbove10;
        for (uint256 i; i < 120; ++i) {
            if (balancer.admissionStatus() == 3) { listCurated(2000 + i, 0.2 ether); nftLost += 0.2 ether; }
            if (balancer.admissionStatus() != 0) { fillUp(); if (balancer.admissionStatus() != 0) break; }
            uint256[] memory r = buy(buyer, 1);
            fulfill(r[0], uint256(keccak256(abi.encode("claim", i))));
            settle();
            (,,, uint256 lid,,) = pool.acquisitions(r[0]);
            (uint8 kind, uint8 d,,,) = balancer.items(lid);
            if (kind == SHAPE_KIND) {
                wonBacking += balancer.denominationAmount(d);
                markupAbove10 += balancer.denominationAmount(d) * 1500 / 10_000;
            }
            proceeds += pool.ownerProceeds();
            uint256 p0 = balancer.profit();
            fillUp();
            uint256 p1 = balancer.profit();
            if (p1 > p0) creditedTotal += p1 - p0;
            uint256 w = balancer.withdrawableSurplus();
            if (w != 0) { vm.prank(creator); balancer.claimSurplus(w, creator); claimed += w; }
        }
        console.log("proceeds collected (wei)", proceeds);
        console.log("claimed while open (wei)", claimed);
        console.log("of which credited as profit (wei)", creditedTotal);
        console.log("markup above 10% on Shape prizes won (wei)", markupAbove10);
        console.log("backing of Shape prizes won (wei)", wonBacking);
        console.log("fund at end, requiredReserve", address(balancer).balance - balancer.profit(), balancer.requiredReserve());
    }

    /// @dev R15 / O5 from the worst creator state: the creator has claimed everything, then the 0.5 ETH Shape is won
    ///      twice in a row. Is the board missing a prize, and does Add ETH restore it with sales never refused?
    function test_O5_bigWinsAfterMaxClaim() public {
        _gas(0.5 gwei, 0.55 gwei);
        _open(_launchBoard(), 2_500, 10 ether, 0.2 ether);
        uint256 w0 = balancer.withdrawableSurplus();
        vm.prank(creator);
        balancer.claimSurplus(w0, creator);
        uint256 refused;
        for (uint256 k; k < 2; ++k) {
            if (balancer.admissionStatus() != 0) ++refused;
            uint256[] memory r = buy(buyer, 1);
            fulfill(r[0], _wordFor(3));
            settle();
            fillUp();
            uint256 w = balancer.withdrawableSurplus();
            if (w != 0) { vm.prank(creator); balancer.claimSurplus(w, creator); }
        }
        uint16[16] memory a = balancer.getActiveShapes();
        console.log("0.5 ETH Shapes listed after two wins (target 1)", a[3]);
        console.log("admission status", balancer.admissionStatus());
        console.log("fund, requiredReserve", address(balancer).balance - balancer.profit(), balancer.requiredReserve());
        // Add ETH: the dashboard's first response
        vm.prank(creator);
        balancer.depositETH{value: 1 ether}();
        fillUp();
        a = balancer.getActiveShapes();
        console.log("0.5 ETH Shapes listed after Add ETH", a[3]);
        assertEq(refused, 0, "sales never refused");
        assertEq(a[3], 1, "restored");
    }

    // ---------------------------------------------------------------- hard bounds: upkeep gas against KEEPER_MAX_GAS

    /// @dev Five draws each win a different pack/Shape size of the most expensive kinds; one upkeep reconciles all five
    ///      and restocks. Measures the call against KEEPER_MAX_GAS (3.2M) and the reward against its real cost at 5 gwei.
    function test_worstUpkeepGas_mixedPacks() public {
        uint256[16] memory c;
        // one of each pack size and the two largest Shapes: every prize a different size
        (c[9], c[10], c[11], c[12], c[13], c[14], c[15], c[7], c[8]) = (1, 1, 1, 1, 1, 1, 1, 1, 1);
        // a cheap 0.01 Shape base so the fill gate admits draws while unreconciled
        c[0] = 40;
        vm.deal(creator, 100_000 ether);
        _gas(0.5 gwei, 0.55 gwei);
        _open(c, 2_500, 2_000 ether, 0.2 ether);
        // five draws, each forced onto a different pack
        uint8[5] memory sizes = [uint8(15), 14, 13, 12, 11];
        for (uint256 k; k < 5; ++k) {
            uint256[] memory r = buy(buyer, 1);
            fulfill(r[0], _wordFor(sizes[k]));
            settle();
        }
        _gas(4.95 gwei, 5 gwei);
        uint256 maxGas;
        for (uint256 i; i < 10; ++i) {
            vm.cool(address(balancer));
            vm.cool(address(pool));
            vm.cool(SHAPES);
            vm.cool(packs);
            uint256 g = gasleft();
            vm.prank(keeper, keeper);
            try balancer.performUpkeep() returns (uint256 reward) {
                uint256 used = g - gasleft();
                if (used > maxGas) maxGas = used;
                console.log("upkeep gas", used, "reward wei", reward);
                console.log("   real cost at 5 gwei incl 21k", (used + 21_000) * 5 gwei);
            } catch {
                break;
            }
        }
        console.log("max upkeep gas", maxGas);
        assertLt(maxGas, 3_200_000, "under KEEPER_MAX_GAS");
    }

    function _wordFor(uint8 denom) internal view returns (uint256) {
        uint256[] memory ids = balancer.getActiveIds();
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind, uint8 d,,,) = balancer.items(ids[i]);
            if (kind == SHAPE_KIND && d == denom) {
                (,,,,,, uint256 slot, uint8 st) = pool.listings(ids[i]);
                if (st == 1) return wordForSlot(slot);
            }
        }
        revert("size not listed");
    }

    // ---------------------------------------------------------------- compromised keeper admin

    function test_keeperAdminLocksOutKeepers() public {
        _gas(0.5 gwei, 0.55 gwei);
        _open(_launchBoard(), 2_500, 10 ether, 0.2 ether);
        vm.prank(keeperAdmin);
        factory.setKeepersRestricted(true);
        uint256 sold;
        for (uint256 i; i < 30; ++i) {
            if (balancer.admissionStatus() != 0) break;
            uint256[] memory r = buy(buyer, 1);
            fulfill(r[0], uint256(keccak256(abi.encode("lock", i))));
            settle();
            ++sold;
            vm.prank(keeper, keeper);
            try balancer.performUpkeep() {
                revert("unapproved keeper ran upkeep");
            } catch {}
        }
        console.log("draws sold with no keeper able to reconcile", sold);
        console.log("admission status then", balancer.admissionStatus());
        console.log("unreconciled draws", pool.lastIssuedSequence() - balancer.reconciledSequence());
        assertTrue(balancer.admissionStatus() != 0, "sales stop without keepers");
        // the creator restores it
        for (uint256 i; i < 10; ++i) {
            vm.prank(creator, creator);
            try balancer.performUpkeep() {} catch { break; }
        }
        assertEq(balancer.admissionStatus(), 0, "creator upkeep reopens sales");
    }

    // ---------------------------------------------------------------- external dependency hostile: Shapes mint fee

    /// @dev Shapes' admin raises the mint fee to its cap while the pool is open with draws in flight. Purchases stop;
    ///      the creator closes and exits. Where does every wei of the creator's end up?
    function test_shapesFeeAtCap_thenCloseout() public {
        _gas(0.5 gwei, 0.55 gwei);
        _open(_launchBoard(), 2_500, 10 ether, 0.2 ether);
        uint256[] memory r = buy(buyer, 3);
        IShapesAdmin s = IShapesAdmin(SHAPES);
        vm.prank(s.admin());
        s.setMintFee(0.01 ether);
        console.log("mint fee now", s.mintFee());
        assertEq(balancer.admissionStatus(), 5, "MINT_FEE_ROSE");
        uint256 reqOpen = balancer.requiredReserve();
        console.log("required reserve while open at the raised fee", reqOpen);
        for (uint256 k; k < 3; ++k) fulfill(r[k], uint256(keccak256(abi.encode("fee", k))));
        settle();
        // upkeep still reconciles (paid) but cannot restock
        fillUp();
        vm.startPrank(creator);
        balancer.close();
        balancer.claimSurplus(balancer.withdrawableSurplus(), creator);
        vm.stopPrank();
        // unlist everything
        uint256[] memory ids = balancer.getActiveIds();
        uint256[] memory shapesIds = new uint256[](ids.length);
        uint256 n;
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind,,,,) = balancer.items(ids[i]);
            if (kind == SHAPE_KIND) shapesIds[n++] = ids[i];
        }
        for (uint256 from; from < n; from += 20) {
            uint256 m = n - from < 20 ? n - from : 20;
            uint256[] memory chunk = new uint256[](m);
            for (uint256 j; j < m; ++j) chunk[j] = shapesIds[from + j];
            vm.prank(creator);
            balancer.unlistShapes(chunk);
        }
        vm.startPrank(creator);
        balancer.claimSurplus(balancer.withdrawableSurplus(), creator);
        vm.stopPrank();
        console.log("left in the Balancer", address(balancer).balance);
        console.log("owner proceeds left at FWA", pool.ownerProceeds());
        assertEq(address(balancer).balance, 0, "nothing left");
    }

    // ---------------------------------------------------------------- compromised creator vs keepers after close

    /// @dev Five draws in flight; the creator closes and claims the maximum at once. A keeper at the 5 gwei cap then
    ///      processes and reconciles one draw per call. Is every useful call paid in full?
    function test_closeClaimThenSplitReconcileAtCap() public {
        _gas(0.5 gwei, 0.55 gwei);
        _open(_launchBoard(), 2_500, 10 ether, 0.2 ether);
        uint256[] memory r = buy(buyer, 5);
        vm.startPrank(creator);
        balancer.close();
        balancer.claimSurplus(balancer.withdrawableSurplus(), creator);
        vm.stopPrank();
        console.log("held after the claim", address(balancer).balance);
        _gas(4.95 gwei, 5 gwei);
        uint256 short;
        for (uint256 k; k < 5; ++k) {
            fulfill(r[k], uint256(keccak256(abi.encode("c", k)))); // FWA's fast path processes it in the callback
            vm.cool(address(balancer));
            vm.cool(address(pool));
            uint256 g = gasleft();
            vm.prank(keeper, keeper);
            uint256 reward = balancer.performUpkeep();
            uint256 cost = (g - gasleft() + 21_000) * 5 gwei;
            console.log("reward", reward, "cost", cost);
            if (reward < cost) short += cost - reward;
        }
        console.log("keeper shortfall total", short);
        console.log("left after reconciling", address(balancer).balance);
        assertEq(short, 0, "every split call paid at least its gas");
    }

    // ---------------------------------------------------------------- R11 / O1 on boards the gate does not run

    /// @dev O1's own metric, per useful upkeep: reward - ((outside gas + 21k) + 50k) x price - 0.0001 ETH.
    function _beyond(uint256 price) internal returns (uint256 beyond, bool ran) {
        vm.cool(address(balancer));
        vm.cool(address(pool));
        vm.cool(SHAPES);
        vm.cool(packs);
        uint256 g = gasleft();
        vm.prank(keeper, keeper);
        try balancer.performUpkeep() returns (uint256 reward) {
            uint256 used = g - gasleft() + 21_000;
            uint256 most = (used + 50_000) * price + 0.0001 ether;
            return (reward > most ? reward - most : 0, true);
        } catch {
            return (0, false);
        }
    }

    function _o1Run(uint256[16] memory c, uint256 deposit, uint256 draws, uint256 basefee) internal returns (uint256 total) {
        vm.deal(creator, 100_000 ether);
        _gas(0.5 gwei, 0.55 gwei);
        _open(c, 2_500, deposit, 0.2 ether);
        _gas(basefee, basefee + 0.05 gwei);
        for (uint256 i; i < draws; ++i) {
            if (balancer.admissionStatus() == 3) listCurated(1000 + i, 0.2 ether);
            if (balancer.admissionStatus() != 0) break;
            uint256[] memory r = buy(buyer, 1);
            fulfill(r[0], uint256(keccak256(abi.encode("o1", i))));
            settle();
            for (uint256 j; j < 5; ++j) {
                (uint256 b, bool ran) = _beyond(basefee + 0.05 gwei);
                if (!ran) break;
                total += b;
            }
        }
    }

    function test_O1_packBoard_5gwei() public {
        uint256[16] memory c;
        c[9] = 40; // 40 x 0.02 ETH packs
        c[10] = 20; // 20 x 0.03 ETH packs
        uint256 t = _o1Run(c, 10 ether, 60, 4.95 gwei);
        console.log("pack board, 60 draws at 5 gwei: paid beyond gas+50k+0.0001 (wei)", t);
        console.log("scaled to 180 draws", t * 3);
    }

    function test_O1_bottomHeavy_5gwei() public {
        uint256[16] memory c;
        c[0] = 80;
        uint256 t = _o1Run(c, 10 ether, 60, 4.95 gwei);
        console.log("80 x 0.01 board, 60 draws at 5 gwei: paid beyond (wei)", t);
        console.log("scaled to 180 draws", t * 3);
    }

    function test_O1_launch_5gwei() public {
        uint256 t = _o1Run(_launchBoard(), 10 ether, 60, 4.95 gwei);
        console.log("launch board, 60 draws at 5 gwei: paid beyond (wei)", t);
        console.log("scaled to 180 draws", t * 3);
    }

    /// @dev How long the spike's prices stay: after the spike, keep selling at 0.1 gwei and record the ratio.
    function test_O10_spikeRecovery() public {
        _gas(0.1 gwei, 0.15 gwei);
        _open(_launchBoard(), 2_500, 10 ether, 0.2 ether);
        _gas(1.95 gwei, 2 gwei);
        for (uint256 i; i < 30; ++i) {
            if (balancer.admissionStatus() == 3) listCurated(100 + i, 0.2 ether);
            uint256[] memory r = buy(buyer, 1);
            fulfill(r[0], uint256(keccak256(abi.encode("spike2", i))));
            settle();
            fillUp();
        }
        _gas(0.1 gwei, 0.15 gwei);
        console.log("after 30 draws at 2 gwei, ratio at 0.1 gwei (bps)", _ratioBps());
        uint256 n;
        for (uint256 i; i < 400 && _ratioBps() > 15_000; ++i) {
            if (balancer.admissionStatus() == 3) listCurated(1000 + i, 0.2 ether);
            uint256[] memory r = buy(buyer, 1);
            fulfill(r[0], uint256(keccak256(abi.encode("calm", i))));
            settle();
            fillUp();
            ++n;
        }
        console.log("draws at 0.1 gwei until the ratio is back under 1.5x", n);
        console.log("ratio then (bps)", _ratioBps());
    }

    // ---------------------------------------------------------------- liveness: who processes a draw FWA's fast path skips

    /// @dev A restock staged while a draw is in flight is reserved by the next request; that request's VRF callback then
    ///      skips FWA's fast path and the draw stays Ready until someone calls processAcquisitions. The shipped keeper
    ///      only calls performUpkeep. Does the system stall with only players, the VRF service and the keeper acting?
    function test_reservedBatchDrawWaitsForAProcessor() public {
        _gas(0.5 gwei, 0.55 gwei);
        _open(_launchBoard(), 2_500, 10 ether, 0.2 ether);
        vm.deal(stranger, 100 ether);
        uint256 stuckMax;
        uint256 reservedDraws;
        for (uint256 i; i < 40; ++i) {
            uint8 st = balancer.admissionStatus();
            if (st == 3) { listCurated(500 + i, 0.2 ether); st = balancer.admissionStatus(); }
            if (st != 0) {
                console.log("purchases refused, status", st, "after round", i);
                break;
            }
            uint256[] memory r = buy(buyer, 1);
            // the keeper runs while this draw is in flight: the restock of earlier wins is staged
            vm.prank(keeper, keeper);
            try balancer.performUpkeep() {} catch {}
            uint256[] memory r2;
            if (balancer.admissionStatus() == 0) {
                // a second player buys while the first draw is unsettled: this request reserves the staged restock
                r2 = buy(stranger, 1);
                if (IReserved(address(pool)).reservedListingCount(pool.lastIssuedSequence()) != 0) ++reservedDraws;
            }
            fulfill(r[0], uint256(keccak256(abi.encode("live", i))));
            if (r2.length != 0) fulfill(r2[0], uint256(keccak256(abi.encode("live2", i))));
            // nobody calls processAcquisitions; the keeper's next upkeep runs at the start of the next round
            uint256 u = pool.unsettledAcquisitionCount();
            if (u > stuckMax) stuckMax = u;
        }
        console.log("draws whose request reserved a staged restock", reservedDraws);
        console.log("most draws left unsettled with no processor", stuckMax);
        console.log("unsettled at end", pool.unsettledAcquisitionCount());
        console.log("admission status at end", balancer.admissionStatus());
        vm.roll(block.number + 10_000);
        console.log("unsettled 10,000 blocks later", pool.unsettledAcquisitionCount());
        // repair cost: anyone processes the stuck queue, then the keeper's upkeep reconciles and restocks
        uint256 g = gasleft();
        uint256 n = pool.processAcquisitions(5);
        console.log("processed", n, "gas for processAcquisitions(5)", g - gasleft());
        vm.prank(keeper, keeper);
        uint256 reward = balancer.performUpkeep();
        console.log("following upkeep reward (wei)", reward);
        console.log("admission status after", balancer.admissionStatus());
    }

    // ---------------------------------------------------------------- player: make a losing Shape draw "fail delivery"

    /// @dev A player who sees a cached word that wins a cheap prize processes it with a gas limit chosen so FWA's
    ///      150k-stipend delivery child runs out of gas while the parent finishes. If that worked, the player could take
    ///      the delivery refund after 7 days and keep only winning draws. Sweep every gas limit in steps.
    uint256 FULFILL_GAS = 1050000;

    function test_gasGriefDeliveryFailure() public {
        _gas(0.5 gwei, 0.55 gwei);
        _open(_launchBoard(), 2_500, 10 ether, 0.2 ether);
        vm.deal(stranger, 100 ether);
        uint256[] memory r0 = buy(buyer, 1);
        fulfill(r0[0], _wordFor(0)); // won and processed by FWA's fast path: a deficit exists
        uint256[] memory ra = buy(buyer, 1);
        upkeep(); // reconciles the win and stages its restock while ra is in flight
        uint256[] memory r = buy(stranger, 1); // reserves the staged restock
        assertGt(IReserved(address(pool)).reservedListingCount(pool.lastIssuedSequence()), 0, "reserved");
        fulfill(ra[0], 888);
        fulfill(r[0], 12345); // no fast path: stays Ready
        (,,,, uint8 st0,) = pool.acquisitions(r[0]);
        console.log("status after the callback (5 = Ready)", st0);
        assertEq(st0, 5, "Ready, not processed");
        uint256 deliveryFailed;
        uint256 succeeded;
        for (uint256 g = 100_000; g < 4_000_000; g += 3_000) {
            uint256 snap = vm.snapshotState();
            try pool.processAcquisitions{gas: g}(1) returns (uint256 n) {
                if (n == 1) {
                    (,,, uint256 lid, uint8 st,) = pool.acquisitions(r[0]);
                    if (st == 7) { ++deliveryFailed; console.log("delivery failed at gas", g, "listing", lid); }
                    else ++succeeded;
                }
            } catch {}
            vm.revertToState(snap);
        }
        console.log("gas limits that settled normally", succeeded);
        console.log("gas limits that left delivery pending", deliveryFailed);
        assertEq(deliveryFailed, 0, "no gas limit forces a failed Shape delivery");
    }
}

interface IReserved {
    function reservedListingCount(uint64 sequence) external view returns (uint256);
}

interface IVRFServiceB {
    function coordinator() external view returns (address);
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external;
}
