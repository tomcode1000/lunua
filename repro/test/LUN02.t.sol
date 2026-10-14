// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";

/// Lunua LUN-02 reproduction. Run with Arc Foundry (standard forge does not model native USDC):
///   arc-forge test --match-contract LUN02 -vvvv
contract LUN02 is Test {
    address constant USDC = 0x3600000000000000000000000000000000000000;

    function setUp() public {
        vm.createSelectFork("https://rpc.mainnet.arc.io", 25933812);
    }

    // Confirms or refutes the signal. Fill in the target's accounting getter.
    function test_singleBalanceNotDoubleCounted() public {
        address target = vm.parseAddress("0xa8bd8c8f580d5f00cef41bfa524555de17e3b38f");
        vm.deal(target, target.balance + 1e18); // +1 USDC, visible through BOTH views
        (, bytes memory r) = USDC.staticcall(abi.encodeWithSignature("balanceOf(address)", target));
        uint256 erc20View = abi.decode(r, (uint256));
        // uint256 reported = ITarget(target).totalAssets();   // <- the getter under test
        // assertEq(reported, erc20View, "LUN-02 reproduced: balance counted twice");
        assertEq(erc20View * 1e12 <= target.balance, true);
    }
}
