// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AuthenticEconomicFlowsTest} from "./AuthenticEconomicFlows.t.sol";
import {IVRFService} from "./utils/ForkBase.sol";
import {IERC721Min} from "../src/interfaces/External.sol";

interface IContinuationMeta {
    function acquisitionMeta(uint256) external view returns (uint64, uint64, uint64, uint16, uint16, uint256);
}

/// @dev Genuine public proof submission, not oracle impersonation. This proves proof validation and restocking,
/// not a second cohort: the bounded historical scan found only the first three requests.
contract AuthenticContinuationTest is AuthenticEconomicFlowsTest {
    string internal corpus;
    address internal coordinator;
    uint256 internal accepted;

    function _key(uint256 i, string memory field) internal pure returns (string memory) {
        return string.concat(".entries[", vm.toString(i), "].", field);
    }

    function _advance(uint256 height) internal {
        vm.rollFork(height);
        // Economic calls use this explicit counterfactual gas context, not the historical node's bid.
        vm.fee(0.5 gwei);
        vm.txGasPrice(0.55 gwei);
        probe.record();
        assertEq(probe.baseFee(), 0.5 gwei);
        assertEq(probe.gasPrice(), 0.55 gwei);
    }

    function _proof(uint256 i, uint256 expected) internal {
        assertEq(vm.parseUint(vm.parseJsonString(corpus, _key(i, "requestId"))), expected);
        _advance(vm.parseUint(vm.parseJsonString(corpus, _key(i, "fulfillmentBlock"))));
        bytes memory input = vm.parseJsonBytes(corpus, _key(i, "input"));
        (bool ok, bytes memory reason) = coordinator.call(input);
        if (!ok) assembly { revert(add(reason, 32), mload(reason)) }
        (,,,,, uint256 actualWord) = IContinuationMeta(address(pool)).acquisitionMeta(expected);
        assertEq(actualWord, vm.parseUint(vm.parseJsonString(corpus, _key(i, "word"))), "actual verified output matches canonical historical word");
        ++accepted;
        pool.processAcquisitions(3);
        (address purchaser,,, uint256 lid, uint8 status,) = pool.acquisitions(expected);
        assertEq(status, 2, "public caller supplied a genuine accepted proof");
        assertEq(purchaser, buyer);
        (address collection,,, uint256 tokenId,,,,) = pool.listings(lid);
        assertEq(IERC721Min(collection).ownerOf(tokenId), buyer);
    }

    function test_publicProofsRejectTamperingAndReplayThenRestock() public {
        corpus = vm.readFile("test/fixtures/authentic-vrf-proofs.json");
        coordinator = IVRFService(VRF_SERVICE).coordinator();
        assertEq(coordinator, 0xD7f86b4b8Cae7D942340FF628F82735b7a20893a);
        assertGe(vm.parseJsonArrayLength(corpus, ".entries"), 3, "three distinct genuine proofs");
        _advance(vm.parseUint(vm.parseJsonString(corpus, _key(0, "fulfillmentBlock"))));
        bytes memory damaged = vm.parseJsonBytes(corpus, _key(0, "input"));
        damaged[99] = bytes1(uint8(damaged[99]) ^ 1);
        (bool bad,) = coordinator.call(damaged);
        assertFalse(bad, "tampering cannot substitute an invented VRF result");
        (,,,, uint8 beforeStatus,) = pool.acquisitions(requests[0]);
        assertEq(beforeStatus, 1, "rejected proof leaves actual request pending");
        for (uint256 i; i < 3; ++i) _proof(i, requests[i]);
        uint256 proceeds = pool.ownerProceeds();
        (bool replay,) = coordinator.call(vm.parseJsonBytes(corpus, _key(0, "input")));
        assertFalse(replay, "consumed coordinator commitment cannot be reused");
        assertEq(pool.ownerProceeds(), proceeds, "replay adds no owner proceeds");
        fillUp();
        assertEq(pool.unsettledAcquisitionCount(), 0);
        assertEq(balancer.reconciledSequence(), pool.lastIssuedSequence());
        assertEq(balancer.listedShapePrizes(), 47, "real keeper restocked the launch board");

        assertEq(accepted, 3);
        assertEq(pool.lastIssuedSequence(), 3, "three distinct commitments consumed exactly once");
        balancer.collectProceeds();
        _assertCostFirstProfit();
        uint256 credit = balancer.creatorCredit();
        balancer.collectProceeds();
        assertEq(balancer.creatorCredit(), credit);
    }
}
