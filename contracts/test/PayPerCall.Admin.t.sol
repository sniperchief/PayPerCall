// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {PayPerCall} from "../PayPerCall.sol";
import {PayPerCallBase} from "./PayPerCall.Base.t.sol";

/// Required test 15: operator auth, two-step ownership, renounce disabled, pause semantics.
contract PayPerCallAdminTest is PayPerCallBase {
    function _unauth(address who) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, who);
    }

    function test_15_onlyOwnerCanSetOperator() public {
        address newOp = makeAddr("newOp");
        address[3] memory callers = [mallory, operator, alice];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(_unauth(callers[i]));
            ppc.setOperator(newOp);
        }
        assertEq(ppc.operator(), operator);
    }

    function test_15_setOperatorZeroAndSameRevert() public {
        vm.prank(owner);
        vm.expectRevert(PayPerCall.ZeroAddress.selector);
        ppc.setOperator(address(0));
        vm.prank(owner);
        vm.expectRevert(PayPerCall.SameOperator.selector);
        ppc.setOperator(operator);
    }

    function test_15_setOperatorEmitsAndRotates() public {
        address newOp = makeAddr("newOp");
        bytes32 id = _create(alice, NONCE, PARAMS);
        vm.expectEmit(true, true, false, false, address(ppc));
        emit PayPerCall.OperatorUpdated(operator, newOp);
        vm.prank(owner);
        ppc.setOperator(newOp);
        assertEq(ppc.operator(), newOp);

        vm.prank(operator);
        vm.expectRevert(PayPerCall.NotOperator.selector);
        ppc.settle(id, REPORT);
        vm.prank(newOp);
        ppc.settle(id, REPORT);
        assertEq(uint8(_status(id)), uint8(PayPerCall.Status.Settled));
        assertEq(usdc.balanceOf(treasury), PRICE);
    }

    function test_15_twoStepOwnership() public {
        vm.prank(mallory);
        vm.expectRevert(_unauth(mallory));
        ppc.transferOwnership(mallory);

        vm.prank(owner);
        ppc.transferOwnership(bob);
        assertEq(ppc.owner(), owner); // not yet transferred
        assertEq(ppc.pendingOwner(), bob);

        vm.prank(mallory);
        vm.expectRevert(_unauth(mallory));
        ppc.acceptOwnership();
        vm.prank(owner);
        vm.expectRevert(_unauth(owner));
        ppc.acceptOwnership();
        assertEq(ppc.owner(), owner);

        vm.prank(bob);
        ppc.acceptOwnership();
        assertEq(ppc.owner(), bob);
        assertEq(ppc.pendingOwner(), address(0));

        // Old owner lost power; new owner has it.
        vm.prank(owner);
        vm.expectRevert(_unauth(owner));
        ppc.pause();
        vm.prank(bob);
        ppc.pause();
        assertTrue(ppc.paused());
    }

    function test_15_pendingOwnerHasNoOwnerPowersBeforeAccepting() public {
        vm.prank(owner);
        ppc.transferOwnership(bob);
        assertEq(ppc.pendingOwner(), bob);

        address newOp = makeAddr("newOp");
        vm.startPrank(bob);
        vm.expectRevert(_unauth(bob));
        ppc.setOperator(newOp);
        vm.expectRevert(_unauth(bob));
        ppc.pause();
        vm.expectRevert(_unauth(bob));
        ppc.transferOwnership(mallory);
        vm.stopPrank();

        vm.prank(owner);
        ppc.pause();
        vm.prank(bob);
        vm.expectRevert(_unauth(bob));
        ppc.unpause();

        assertEq(ppc.owner(), owner);
        assertEq(ppc.pendingOwner(), bob);
        assertEq(ppc.operator(), operator);
        assertTrue(ppc.paused());

        // The current owner keeps full control until bob accepts.
        vm.startPrank(owner);
        ppc.unpause();
        ppc.setOperator(newOp);
        vm.stopPrank();
        assertFalse(ppc.paused());
        assertEq(ppc.operator(), newOp);
    }

    function test_15_renounceOwnershipReverts() public {
        vm.prank(owner);
        vm.expectRevert(PayPerCall.RenounceDisabled.selector);
        ppc.renounceOwnership();
        vm.prank(mallory);
        vm.expectRevert(PayPerCall.RenounceDisabled.selector);
        ppc.renounceOwnership();
        assertEq(ppc.owner(), owner);
    }

    function test_15_onlyOwnerCanPauseAndUnpause() public {
        vm.prank(mallory);
        vm.expectRevert(_unauth(mallory));
        ppc.pause();
        vm.prank(operator);
        vm.expectRevert(_unauth(operator));
        ppc.pause();
        assertFalse(ppc.paused());

        vm.prank(owner);
        ppc.pause();
        assertTrue(ppc.paused());

        vm.prank(mallory);
        vm.expectRevert(_unauth(mallory));
        ppc.unpause();
        assertTrue(ppc.paused());

        vm.prank(owner);
        ppc.unpause();
        assertFalse(ppc.paused());
    }

    function test_15_pauseBlocksCreateOnlySettleAndRefundStillWork() public {
        bytes32 idSettle = _create(alice, bytes32(uint256(1)), PARAMS);
        bytes32 idRefund = _create(alice, bytes32(uint256(2)), PARAMS);
        vm.prank(owner);
        ppc.pause();

        vm.prank(bob);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        ppc.createRequest(NONCE, PARAMS);

        _settle(idSettle); // still works while paused
        assertEq(uint8(_status(idSettle)), uint8(PayPerCall.Status.Settled));
        assertEq(usdc.balanceOf(treasury), PRICE);

        skip(DELAY);
        _refund(alice, idRefund, alice); // still works while paused
        assertEq(uint8(_status(idRefund)), uint8(PayPerCall.Status.Refunded));
        assertEq(usdc.balanceOf(address(ppc)), 0);

        vm.prank(owner);
        ppc.unpause();
        _create(bob, NONCE, PARAMS); // creation resumes
        assertEq(usdc.balanceOf(address(ppc)), PRICE);
    }
}
