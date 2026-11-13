// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

// These are adversary-written NFT collections (legitimate adversaries per packet section 4), NOT stand-ins for any
// protocol contract. No protocol contract (FWA, Shapes, Packs, VRF) is mocked anywhere.

/// Minimal ERC721 the creator controls, used as a "curated" collection.
contract SimpleNFT {
    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    string public name = "Simple";
    string public symbol = "SMP";

    function mint(address to, uint256 id) external {
        ownerOf[id] = to;
    }

    function approve(address to, uint256 id) external {
        require(msg.sender == ownerOf[id] || isApprovedForAll[ownerOf[id]][msg.sender], "auth");
        getApproved[id] = to;
    }

    function setApprovalForAll(address op, bool ok) external {
        isApprovedForAll[msg.sender][op] = ok;
    }

    function transferFrom(address from, address to, uint256 id) public {
        require(ownerOf[id] == from, "owner");
        require(msg.sender == from || getApproved[id] == msg.sender || isApprovedForAll[from][msg.sender], "auth");
        ownerOf[id] = to;
        getApproved[id] = address(0);
    }

    function safeTransferFrom(address from, address to, uint256 id) external {
        transferFrom(from, to, id);
        // best-effort receiver hook
        if (to.code.length != 0) {
            try IERC721Receiver(to).onERC721Received(msg.sender, from, id, "") returns (bytes4 r) {
                require(r == IERC721Receiver.onERC721Received.selector, "recv");
            } catch {
                revert("recv");
            }
        }
    }

    function supportsInterface(bytes4) external pure returns (bool) {
        return true;
    }
}

interface IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4);
}

/// A collection whose transfer/ownerOf callbacks reenter a target. Used to probe reentrancy on creator entry points.
contract ReentrantNFT {
    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    address public target;
    bytes public payload;
    bool public armed;

    function mint(address to, uint256 id) external {
        ownerOf[id] = to;
    }

    function arm(address t, bytes calldata p) external {
        target = t;
        payload = p;
        armed = true;
    }

    function approve(address to, uint256 id) external {
        getApproved[id] = to;
    }

    function setApprovalForAll(address op, bool ok) external {
        isApprovedForAll[msg.sender][op] = ok;
    }

    function _reenter() internal {
        if (armed && target != address(0)) {
            armed = false; // one shot
            (bool ok,) = target.call(payload);
            require(ok, "reenter-reverted"); // surface whether the guard blocked us
        }
    }

    function transferFrom(address from, address to, uint256 id) public {
        ownerOf[id] = to;
        _reenter();
    }

    function safeTransferFrom(address from, address to, uint256 id) external {
        transferFrom(from, to, id);
    }

    function supportsInterface(bytes4) external pure returns (bool) {
        return true;
    }
}
