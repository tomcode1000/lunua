// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";

/// Lunua LUN-TX reproduction. Run with Arc Foundry (standard forge does not model native USDC):
///   arc-forge test --match-contract LUNTX -vvvv
contract LUNTX is Test {
    address constant USDC = 0x3600000000000000000000000000000000000000;

    function setUp() public {
        vm.createSelectFork("https://rpc.mainnet.arc.io", 23827913);
    }


    function test_originalRevertsAtBlock() public {
        address sender = vm.parseAddress("0x92c794d97ee4cbef692b9ef7a57e27562d913da8");
        address target = vm.parseAddress("0x0970462cece33d425dba716cbf4855bb4f44fcf5");
        vm.prank(sender);
        (bool ok, ) = target.call{value: 4000000000000000000}("");
        assertFalse(ok, "original call did not revert at this block");
    }

    function test_erc20RailSucceedsAtBlock() public {
        address sender = vm.parseAddress("0x92c794d97ee4cbef692b9ef7a57e27562d913da8");
        address target = vm.parseAddress("0x0970462cece33d425dba716cbf4855bb4f44fcf5");
        vm.prank(sender);
        (bool ok, ) = USDC.call(abi.encodeWithSignature("transfer(address,uint256)", target, 4000000));
        assertTrue(ok, "ERC-20 rail failed at this block");
    }
}
