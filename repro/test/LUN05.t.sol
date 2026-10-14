// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";

/// Lunua LUN-05 reproduction. Run with Arc Foundry (standard forge does not model native USDC):
///   arc-forge test --match-contract LUN05 -vvvv
contract LUN05 is Test {
    address constant USDC = 0x3600000000000000000000000000000000000000;

    function setUp() public {
        vm.createSelectFork("https://rpc.mainnet.arc.io", 25933812);
    }

    function test_prevrandaoIsConstant() public view {
        assertEq(block.prevrandao, 0, "prevrandao non-zero on this fork");
    }
}
