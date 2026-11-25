// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./utils/ForkBase.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";

/// @dev Real deployed FWA custody; the creator's freely listable NFT collection uses the existing fixture.
/// Gas observations share one Forge transaction and may have different warm slots after snapshot restoration.
/// They exclude refunds and are not independent signed-transaction fee comparisons.
contract FocusedInventoryGasTest is ForkBase {
    uint256[] internal listingIds;
    uint256[] internal prices;
    uint256 internal cash;
    uint256 internal poolCash;
    uint256 internal credit;
    uint256 internal shapeCash;

    function setUp() public {
        setUpFork();
        createBalancer(1 ether);
        PoolBalancer.CuratedInput[] memory inputs = new PoolBalancer.CuratedInput[](20);
        for (uint256 i; i < 20; ++i) {
            nft.mint(creator, 100 + i);
            inputs[i] = PoolBalancer.CuratedInput(address(nft), 100 + i, 0.2 ether);
            prices.push(0.3 ether + i * 0.001 ether);
        }
        vm.startPrank(creator);
        nft.setApprovalForAll(address(balancer), true);
        listingIds = balancer.listCuratedBatch(inputs);
        vm.stopPrank();
        cash = address(balancer).balance;
        poolCash = address(pool).balance;
        credit = balancer.creatorCredit();
        shapeCash = SHAPES.balance;
    }

    function test_maximumCuratedBatchGasAndConservation() public {
        assertEq(tx.gasprice, 1 gwei);
        assertEq(block.basefee, 0.5 gwei);
        assertEq(cash, 1 ether, "absolute initial operating deposit");
        uint256 initial = vm.snapshotState();

        vm.startPrank(creator);
        uint256 beforeGas = gasleft();
        balancer.updateCuratedPricesBatch(listingIds, prices);
        uint256 batchReprice = beforeGas - gasleft();
        vm.stopPrank();
        _assertPrices();
        _assertCash();
        emit log_named_uint("20-item batch reprice raw EVM gas", batchReprice);
        _assertCallFits(batchReprice, abi.encodeCall(balancer.updateCuratedPricesBatch, (listingIds, prices)).length);
        assertTrue(vm.revertToState(initial));

        vm.startPrank(creator);
        beforeGas = gasleft();
        for (uint256 i; i < 20; ++i) balancer.updateCuratedPrice(listingIds[i], prices[i]);
        uint256 singleReprice = beforeGas - gasleft();
        vm.stopPrank();
        _assertPrices();
        _assertCash();
        emit log_named_uint("20 separate reprice calls raw EVM gas", singleReprice);
        assertTrue(vm.revertToState(initial));

        vm.startPrank(creator);
        beforeGas = gasleft();
        balancer.withdrawCuratedBatch(listingIds, creator);
        uint256 batchWithdraw = beforeGas - gasleft();
        vm.stopPrank();
        _assertWithdrawn();
        emit log_named_uint("20-item batch withdraw raw EVM gas", batchWithdraw);
        _assertCallFits(batchWithdraw, abi.encodeCall(balancer.withdrawCuratedBatch, (listingIds, creator)).length);
        assertTrue(vm.revertToState(initial));

        vm.startPrank(creator);
        beforeGas = gasleft();
        for (uint256 i; i < 20; ++i) balancer.withdrawCurated(listingIds[i], creator);
        uint256 singleWithdraw = beforeGas - gasleft();
        vm.stopPrank();
        _assertWithdrawn();
        emit log_named_uint("20 separate withdraw calls raw EVM gas", singleWithdraw);
    }

    function _assertCash() internal view {
        assertEq(address(balancer).balance, cash, "operating ETH conserved");
        assertEq(address(pool).balance, poolCash, "FWA ETH conserved");
        assertEq(balancer.creatorCredit(), credit, "creator claim conserved");
        assertEq(SHAPES.balance, shapeCash, "Shapes backing unchanged");
    }

    function _assertPrices() internal view {
        assertEq(pool.activeListingCount(), 20);
        for (uint256 i; i < 20; ++i) {
            (,,, uint112 base, uint112 price) = balancer.items(listingIds[i]);
            (,,,,, uint256 fwaPrice,,) = pool.listings(listingIds[i]);
            assertEq(base, prices[i]);
            assertEq(price, prices[i]);
            assertEq(fwaPrice, prices[i]);
            assertEq(nft.ownerOf(100 + i), address(pool));
        }
    }

    function _assertWithdrawn() internal view {
        _assertCash();
        assertEq(pool.activeListingCount(), 0);
        assertEq(balancer.getActiveIds().length, 0);
        for (uint256 i; i < 20; ++i) {
            assertEq(nft.ownerOf(100 + i), creator);
            (uint8 kind,,,,) = balancer.items(listingIds[i]);
            (,,,,,,, uint8 status) = pool.listings(listingIds[i]);
            assertEq(kind, 0);
            assertEq(status, 3);
        }
    }

    function _assertCallFits(uint256 executionGas, uint256 calldataBytes) internal pure {
        // Conservative calldata cost; raw gas does not subtract storage-clear refunds.
        assertLt(executionGas + 21_000 + calldataBytes * 16, 16_777_216, "batch below mainnet transaction gas cap");
    }
}
