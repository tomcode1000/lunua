// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PreflightRegistry
/// @notice On-chain record of Arc Preflight results. Anyone can post a result; readers
///         decide which attesters they trust. A result is pinned to the target's code hash,
///         so it goes stale automatically if the code at that address changes.
contract PreflightRegistry {
    struct Result {
        bytes32 codeHash; // extcodehash of the target when checked
        uint32 failMask;  // bit i set = check i failed
        uint32 warnMask;  // bit i set = check i warned
        uint64 checkedAt; // block timestamp
    }

    // Check ids (bit positions), mirrored in engine/preflight.mjs
    // 0 native-receive, 1 dust, 2 two-views, 3 allowance, 4 selfdestruct, 5 prevrandao

    mapping(address attester => mapping(address target => Result)) public results;

    event Checked(address indexed attester, address indexed target, bytes32 codeHash, uint32 failMask, uint32 warnMask);

    function record(address target, uint32 failMask, uint32 warnMask) external {
        bytes32 h = target.codehash;
        require(h != bytes32(0) && h != keccak256(""), "not a contract");
        results[msg.sender][target] = Result(h, failMask, warnMask, uint64(block.timestamp));
        emit Checked(msg.sender, target, h, failMask, warnMask);
    }

    /// @return known  a result exists and still matches the current code
    /// @return passed known and no failing checks
    function status(address attester, address target) external view returns (bool known, bool passed, uint32 failMask, uint32 warnMask) {
        Result memory r = results[attester][target];
        known = r.checkedAt != 0 && r.codeHash == target.codehash;
        passed = known && r.failMask == 0;
        return (known, passed, r.failMask, r.warnMask);
    }
}
