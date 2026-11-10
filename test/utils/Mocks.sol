// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "solady/tokens/ERC721.sol";

contract MockNFT is ERC721 {
    function name() public pure override returns (string memory) {
        return "Mock";
    }

    function symbol() public pure override returns (string memory) {
        return "MOCK";
    }

    function tokenURI(uint256) public pure override returns (string memory) {
        return "";
    }

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }
}

/// @dev Transfers out of the holder revert once `frozen`, so FWA delivery fails and is quarantined.
contract FreezableNFT is MockNFT {
    bool public frozen;

    function setFrozen(bool f) external {
        frozen = f;
    }

    function _beforeTokenTransfer(address from, address, uint256) internal view override {
        if (frozen && from != address(0)) revert("frozen");
    }
}

interface IReenterTarget {
    function performUpkeep() external;
    function claimSurplus(uint256, address) external;
}

/// @dev Attempts to re-enter a target from inside `transferFrom`.
contract ReentrantNFT is MockNFT {
    address public target;
    bool public reentered;

    function setTarget(address t) external {
        target = t;
    }

    function _beforeTokenTransfer(address from, address, uint256) internal override {
        if (target != address(0) && from != address(0)) {
            (bool ok,) = target.call(abi.encodeCall(IReenterTarget.performUpkeep, ()));
            reentered = ok;
        }
    }
}

/// @dev Reports a false owner after transfer.
contract LyingNFT is MockNFT {
    function ownerOf(uint256) public pure override returns (address) {
        return address(0xdead);
    }
}

/// @dev Keeper contract that rejects ETH, to exercise the forced reward transfer.
contract RejectingKeeper {
    function upkeep(address b) external {
        IReenterTarget(b).performUpkeep();
    }

    receive() external payable {
        revert("no");
    }
}
