// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {PayPerCall} from "../PayPerCall.sol";
import {PayPerCallBase} from "./PayPerCall.Base.t.sol";

/// Required tests 9-13 and 16 (refund timing, terminal states, failing tokens, boundaries).
contract PayPerCallLifecycleTest is PayPerCallBase {
    function _refundNotYet(uint64 refundableAt) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(PayPerCall.RefundNotYetAvailable.selector, refundableAt);
    }

    // ---------------------------------------------------------------- 9
    function test_09_refundBeforeDeadlineFails() public {
        bytes32 id = _create(alice, NONCE, PARAMS);
        (, , uint64 r, , ) = ppc.requests(id);
        vm.prank(alice);
        vm.expectRevert(_refundNotYet(r));
        ppc.refund(id, alice);
        vm.warp(r - 1);
        vm.prank(alice);
        vm.expectRevert(_refundNotYet(r));
        ppc.refund(id, alice);
        assertEq(uint8(_status(id)), uint8(PayPerCall.Status.Paid));
        assertEq(usdc.balanceOf(address(ppc)), PRICE);
    }

    // ---------------------------------------------------------------- 10
    function test_10_refundAfterDeadlineToPayer() public {
        bytes32 id = _create(alice, NONCE, PARAMS);
        skip(DELAY);
        vm.expectEmit(true, true, false, true, address(ppc));
        emit PayPerCall.RequestRefunded(id, alice, alice, PRICE);
        _refund(alice, id, alice);
        assertEq(usdc.balanceOf(alice), START_BAL);
        assertEq(usdc.balanceOf(address(ppc)), 0);
        assertEq(uint8(_status(id)), uint8(PayPerCall.Status.Refunded));
        // second refund is rejected
        vm.prank(alice);
        vm.expectRevert(_notPaid(PayPerCall.Status.Refunded));
        ppc.refund(id, alice);
    }

    function test_10_refundAfterDeadlineToDifferentRecipient() public {
        bytes32 id = _create(alice, NONCE, PARAMS);
        skip(DELAY + 5 hours);
        vm.expectEmit(true, true, false, true, address(ppc));
        emit PayPerCall.RequestRefunded(id, alice, bob, PRICE);
        _refund(alice, id, bob);
        assertEq(usdc.balanceOf(bob), START_BAL + PRICE);
        assertEq(usdc.balanceOf(alice), START_BAL - PRICE);
        assertEq(usdc.balanceOf(address(ppc)), 0);
        assertEq(uint8(_status(id)), uint8(PayPerCall.Status.Refunded));
    }

    function test_10_zeroRecipientReverts() public {
        bytes32 id = _create(alice, NONCE, PARAMS);
        skip(DELAY);
        vm.prank(alice);
        vm.expectRevert(PayPerCall.ZeroAddress.selector);
        ppc.refund(id, address(0));
        assertEq(uint8(_status(id)), uint8(PayPerCall.Status.Paid));
    }

    function test_10_selfRecipientRefundReverts() public {
        bytes32 id = _create(alice, NONCE, PARAMS);
        skip(DELAY);
        vm.prank(alice);
        vm.expectRevert(PayPerCall.InvalidRecipient.selector);
        ppc.refund(id, address(ppc));
        assertEq(uint8(_status(id)), uint8(PayPerCall.Status.Paid));
        assertEq(usdc.balanceOf(address(ppc)), PRICE);
        assertEq(usdc.balanceOf(alice), START_BAL - PRICE);
        // The payer can still recover the escrow to a valid recipient.
        _refund(alice, id, alice);
        assertEq(uint8(_status(id)), uint8(PayPerCall.Status.Refunded));
        assertEq(usdc.balanceOf(alice), START_BAL);
    }

    function test_10_usdcTokenRecipientRefundReverts() public {
        bytes32 id = _create(alice, NONCE, PARAMS);
        skip(DELAY);
        vm.prank(alice);
        vm.expectRevert(PayPerCall.InvalidRecipient.selector);
        ppc.refund(id, address(usdc));
        assertEq(uint8(_status(id)), uint8(PayPerCall.Status.Paid));
        assertEq(usdc.balanceOf(address(ppc)), PRICE);
        assertEq(usdc.balanceOf(address(usdc)), 0);
        assertEq(usdc.balanceOf(alice), START_BAL - PRICE);
        // The payer can still recover the escrow to a valid recipient.
        _refund(alice, id, bob);
        assertEq(uint8(_status(id)), uint8(PayPerCall.Status.Refunded));
        assertEq(usdc.balanceOf(bob), START_BAL + PRICE);
        assertEq(usdc.balanceOf(address(ppc)), 0);
    }

    // ---------------------------------------------------------------- 11
    function test_11_settleAfterRefundFails() public {
        bytes32 id = _create(alice, NONCE, PARAMS);
        skip(DELAY);
        _refund(alice, id, alice);
        vm.prank(operator);
        vm.expectRevert(_notPaid(PayPerCall.Status.Refunded));
        ppc.settle(id, REPORT);
        assertEq(usdc.balanceOf(treasury), 0);
    }

    // ---------------------------------------------------------------- 12
    function test_12_refundAfterSettleFails() public {
        bytes32 id = _create(alice, NONCE, PARAMS);
        _settle(id);
        skip(DELAY);
        vm.prank(alice);
        vm.expectRevert(_notPaid(PayPerCall.Status.Settled));
        ppc.refund(id, alice);
        assertEq(usdc.balanceOf(treasury), PRICE);
        assertEq(usdc.balanceOf(alice), START_BAL - PRICE);
    }

    function test_12_settleAfterWindowClosedFails() public {
        bytes32 id = _create(alice, NONCE, PARAMS);
        skip(DELAY);
        vm.prank(operator);
        vm.expectRevert(PayPerCall.SettlementWindowClosed.selector);
        ppc.settle(id, REPORT);
        skip(1 days);
        vm.prank(operator);
        vm.expectRevert(PayPerCall.SettlementWindowClosed.selector);
        ppc.settle(id, REPORT);
        assertEq(uint8(_status(id)), uint8(PayPerCall.Status.Paid));
        assertEq(usdc.balanceOf(treasury), 0);
    }

    // ---------------------------------------------------------------- 13
    function test_13_transferFromFailingInCreateLeavesStatusNone() public {
        bytes32 id = ppc.computeRequestId(alice, NONCE, PARAMS);
        usdc.setFailTransfers(true);
        vm.prank(alice);
        vm.expectRevert("MockUSDC: transfers disabled");
        ppc.createRequest(NONCE, PARAMS);
        assertEq(uint8(_status(id)), uint8(PayPerCall.Status.None));
        assertEq(usdc.balanceOf(address(ppc)), 0);
        usdc.setFailTransfers(false);
        // ID not burned: creation now works with the same inputs.
        assertEq(_create(alice, NONCE, PARAMS), id);
        assertEq(uint8(_status(id)), uint8(PayPerCall.Status.Paid));
    }

    function test_13_transferFailingInSettleKeepsPaidThenRecovers() public {
        bytes32 id = _create(alice, NONCE, PARAMS);
        usdc.setFailTransfers(true);
        vm.prank(operator);
        vm.expectRevert("MockUSDC: transfers disabled");
        ppc.settle(id, REPORT);
        assertEq(uint8(_status(id)), uint8(PayPerCall.Status.Paid));
        assertEq(usdc.balanceOf(address(ppc)), PRICE);
        usdc.setFailTransfers(false);
        _settle(id);
        assertEq(uint8(_status(id)), uint8(PayPerCall.Status.Settled));
        assertEq(usdc.balanceOf(treasury), PRICE);
    }

    function test_13_blocklistedTreasuryBlocksSettleButRefundStillWorks() public {
        bytes32 id = _create(alice, NONCE, PARAMS);
        usdc.setBlocked(treasury, true);
        vm.prank(operator);
        vm.expectRevert("MockUSDC: blocklisted");
        ppc.settle(id, REPORT);
        assertEq(uint8(_status(id)), uint8(PayPerCall.Status.Paid));
        assertEq(usdc.balanceOf(address(ppc)), PRICE);

        skip(DELAY);
        _refund(alice, id, alice);
        assertEq(uint8(_status(id)), uint8(PayPerCall.Status.Refunded));
        assertEq(usdc.balanceOf(alice), START_BAL);
    }

    function test_13_blocklistedPayerRefundsToDifferentRecipient() public {
        bytes32 id = _create(alice, NONCE, PARAMS);
        usdc.setBlocked(alice, true);
        skip(DELAY);
        // Refund to the blocked payer itself fails atomically...
        vm.prank(alice);
        vm.expectRevert("MockUSDC: blocklisted");
        ppc.refund(id, alice);
        assertEq(uint8(_status(id)), uint8(PayPerCall.Status.Paid));
        // ...but a different recipient works.
        _refund(alice, id, bob);
        assertEq(usdc.balanceOf(bob), START_BAL + PRICE);
        assertEq(uint8(_status(id)), uint8(PayPerCall.Status.Refunded));
    }

    function test_13_blocklistedRecipientRevertsRefundStatePaid() public {
        bytes32 id = _create(alice, NONCE, PARAMS);
        skip(DELAY);
        usdc.setBlocked(bob, true);
        vm.prank(alice);
        vm.expectRevert("MockUSDC: blocklisted");
        ppc.refund(id, bob);
        assertEq(uint8(_status(id)), uint8(PayPerCall.Status.Paid));
        assertEq(usdc.balanceOf(address(ppc)), PRICE);
        // Retry to a clean recipient works.
        _refund(alice, id, alice);
        assertEq(uint8(_status(id)), uint8(PayPerCall.Status.Refunded));
    }

    function test_13_usdcPausedCreateRevertsStatusNone() public {
        bytes32 id = ppc.computeRequestId(alice, NONCE, PARAMS);
        usdc.setPaused(true);
        vm.prank(alice);
        vm.expectRevert("MockUSDC: paused");
        ppc.createRequest(NONCE, PARAMS);
        assertEq(uint8(_status(id)), uint8(PayPerCall.Status.None));
        assertEq(usdc.balanceOf(address(ppc)), 0);
        assertEq(usdc.balanceOf(alice), START_BAL);
        usdc.setPaused(false);
        assertEq(_create(alice, NONCE, PARAMS), id);
        assertEq(uint8(_status(id)), uint8(PayPerCall.Status.Paid));
    }

    function test_13_usdcPausedSettleRevertsThenRecovers() public {
        bytes32 id = _create(alice, NONCE, PARAMS);
        usdc.setPaused(true);
        vm.prank(operator);
        vm.expectRevert("MockUSDC: paused");
        ppc.settle(id, REPORT);
        assertEq(uint8(_status(id)), uint8(PayPerCall.Status.Paid));
        assertEq(usdc.balanceOf(address(ppc)), PRICE);
        assertEq(usdc.balanceOf(treasury), 0);
        usdc.setPaused(false);
        _settle(id);
        assertEq(uint8(_status(id)), uint8(PayPerCall.Status.Settled));
        assertEq(usdc.balanceOf(treasury), PRICE);
    }

    /// A USDC pause that outlasts the settlement window leaves only the refund path once lifted.
    function test_13_usdcPausedPastDeadlineLeavesOnlyRefund() public {
        bytes32 id = _create(alice, NONCE, PARAMS);
        usdc.setPaused(true);
        skip(DELAY);
        vm.prank(alice);
        vm.expectRevert("MockUSDC: paused");
        ppc.refund(id, alice);
        assertEq(uint8(_status(id)), uint8(PayPerCall.Status.Paid));
        assertEq(usdc.balanceOf(address(ppc)), PRICE);

        usdc.setPaused(false);
        vm.prank(operator);
        vm.expectRevert(PayPerCall.SettlementWindowClosed.selector);
        ppc.settle(id, REPORT);
        _refund(alice, id, alice);
        assertEq(uint8(_status(id)), uint8(PayPerCall.Status.Refunded));
        assertEq(usdc.balanceOf(alice), START_BAL);
    }

    // ---------------------------------------------------------------- 16
    function test_16_boundaryAroundRefundableAt() public {
        bytes32 idA = _create(alice, bytes32(uint256(1)), PARAMS);
        bytes32 idB = _create(alice, bytes32(uint256(2)), PARAMS);
        (, , uint64 r, , ) = ppc.requests(idA);

        // refundableAt - 1: settle works, refund reverts.
        vm.warp(r - 1);
        vm.prank(alice);
        vm.expectRevert(_refundNotYet(r));
        ppc.refund(idB, alice);
        _settle(idA);
        assertEq(uint8(_status(idA)), uint8(PayPerCall.Status.Settled));

        // exactly refundableAt: settle reverts, refund works.
        vm.warp(r);
        vm.prank(operator);
        vm.expectRevert(PayPerCall.SettlementWindowClosed.selector);
        ppc.settle(idB, REPORT);
        _refund(alice, idB, alice);
        assertEq(uint8(_status(idB)), uint8(PayPerCall.Status.Refunded));
    }

    function test_16_sameTimestampBlockRollsChangeNothing() public {
        bytes32 idA = _create(alice, bytes32(uint256(1)), PARAMS);
        bytes32 idB = _create(alice, bytes32(uint256(2)), PARAMS);
        (, , uint64 r, , ) = ppc.requests(idA);

        // Before deadline: many new blocks, same timestamp.
        vm.warp(r - 1);
        vm.roll(vm.getBlockNumber() + 1000);
        vm.prank(alice);
        vm.expectRevert(_refundNotYet(r));
        ppc.refund(idA, alice);
        _settle(idA); // still settleable

        // At deadline: more blocks, same timestamp, still closed for settle / open for refund.
        vm.warp(r);
        vm.roll(vm.getBlockNumber() + 1000);
        vm.prank(operator);
        vm.expectRevert(PayPerCall.SettlementWindowClosed.selector);
        ppc.settle(idB, REPORT);
        vm.roll(vm.getBlockNumber() + 1000);
        vm.prank(operator);
        vm.expectRevert(PayPerCall.SettlementWindowClosed.selector);
        ppc.settle(idB, REPORT);
        _refund(alice, idB, alice);
        assertEq(uint8(_status(idB)), uint8(PayPerCall.Status.Refunded));
    }

    function test_16_noTimestampWhereBothPossible_loop() public {
        bytes32 id = _create(alice, NONCE, PARAMS);
        (, uint64 c, uint64 r, , ) = ppc.requests(id);
        for (uint256 off = 0; off <= 2 * DELAY; off += (off > DELAY - 5 && off < DELAY + 5) ? 1 : 97) {
            _checkExclusive(id, c, r, off);
        }
    }

    function testFuzz_16_noTimestampWhereBothPossible(uint256 off) public {
        off = bound(off, 0, 10 * DELAY);
        bytes32 id = _create(alice, NONCE, PARAMS);
        (, uint64 c, uint64 r, , ) = ppc.requests(id);
        _checkExclusive(id, c, r, off);
    }

    function _checkExclusive(bytes32 id, uint64 c, uint64 r, uint256 off) internal {
        uint256 snap = vm.snapshotState();
        vm.warp(uint256(c) + off);

        vm.prank(operator);
        (bool settleOk,) = address(ppc).call(abi.encodeCall(ppc.settle, (id, REPORT)));
        vm.revertToState(snap);
        vm.warp(uint256(c) + off);
        vm.prank(alice);
        (bool refundOk,) = address(ppc).call(abi.encodeCall(ppc.refund, (id, alice)));

        assertFalse(settleOk && refundOk, "both settle and refund possible");
        assertEq(settleOk, uint256(c) + off < r, "settle window");
        assertEq(refundOk, uint256(c) + off >= r, "refund window");
        vm.revertToState(snap);
    }
}
