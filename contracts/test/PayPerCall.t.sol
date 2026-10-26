// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {PayPerCall} from "../PayPerCall.sol";
import {PayPerCallBase} from "./PayPerCall.Base.t.sol";
import {
    MockUSDC,
    Mock18Token,
    RevertingDecimalsToken,
    NotAToken,
    FeeOnTransferToken,
    ReturnsFalseToken,
    BalanceDecreasingToken
} from "./mocks/Mocks.sol";

/// Required tests 1-8 (creation, payment validation, token validation, ID uniqueness,
/// impersonation, operator auth, settle, double settle).
contract PayPerCallTest is PayPerCallBase {
    // ---------------------------------------------------------------- 1
    function test_01_exactPaymentSucceeds() public {
        bytes32 expectedId = ppc.computeRequestId(alice, NONCE, PARAMS);
        uint64 t = uint64(block.timestamp);
        uint256 aliceBefore = usdc.balanceOf(alice);

        vm.expectEmit(true, true, false, true, address(ppc));
        emit PayPerCall.RequestCreated(expectedId, alice, PARAMS, NONCE, PRICE, t, t + 1800);
        bytes32 id = _create(alice, NONCE, PARAMS);

        assertEq(id, expectedId);
        assertEq(usdc.balanceOf(alice), aliceBefore - PRICE);
        assertEq(usdc.balanceOf(address(ppc)), PRICE);
        assertEq(usdc.balanceOf(treasury), 0);

        (address payer, uint64 createdAt, uint64 refundableAt, PayPerCall.Status status, bytes32 ph) =
            ppc.requests(id);
        assertEq(payer, alice);
        assertEq(createdAt, t);
        assertEq(refundableAt, createdAt + 1800);
        assertEq(uint8(status), uint8(PayPerCall.Status.Paid));
        assertEq(ph, PARAMS);
    }

    // ---------------------------------------------------------------- 2
    function test_02_noAllowanceRejected() public {
        address carol = makeAddr("carol");
        usdc.mint(carol, START_BAL); // balance but no approval
        bytes32 id = ppc.computeRequestId(carol, NONCE, PARAMS);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(ppc), 0, PRICE));
        ppc.createRequest(NONCE, PARAMS);
        assertEq(uint8(_status(id)), uint8(PayPerCall.Status.None));
        assertEq(usdc.balanceOf(address(ppc)), 0);
        assertEq(usdc.balanceOf(carol), START_BAL);
    }

    function test_02_allowanceBelowPriceRejected() public {
        address carol = makeAddr("carol");
        usdc.mint(carol, START_BAL);
        vm.prank(carol);
        usdc.approve(address(ppc), PRICE - 1);
        bytes32 id = ppc.computeRequestId(carol, NONCE, PARAMS);
        vm.prank(carol);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(ppc), PRICE - 1, PRICE)
        );
        ppc.createRequest(NONCE, PARAMS);
        assertEq(uint8(_status(id)), uint8(PayPerCall.Status.None));
        assertEq(usdc.balanceOf(address(ppc)), 0);
    }

    function test_02_insufficientBalanceRejected() public {
        address carol = makeAddr("carol");
        usdc.mint(carol, PRICE - 1);
        vm.prank(carol);
        usdc.approve(address(ppc), type(uint256).max);
        bytes32 id = ppc.computeRequestId(carol, NONCE, PARAMS);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, carol, PRICE - 1, PRICE));
        ppc.createRequest(NONCE, PARAMS);
        assertEq(uint8(_status(id)), uint8(PayPerCall.Status.None));
        assertEq(usdc.balanceOf(address(ppc)), 0);
        assertEq(usdc.balanceOf(carol), PRICE - 1);
    }

    function test_02_feeOnTransferTokenRejected() public {
        FeeOnTransferToken fee = new FeeOnTransferToken();
        PayPerCall p = new PayPerCall(address(fee), owner, operator, treasury);
        fee.mint(alice, START_BAL);
        vm.prank(alice);
        fee.approve(address(p), type(uint256).max);
        bytes32 id = p.computeRequestId(alice, NONCE, PARAMS);

        vm.prank(alice);
        vm.expectRevert(PayPerCall.UnexpectedReceivedAmount.selector);
        p.createRequest(NONCE, PARAMS);

        (address payer,,, PayPerCall.Status st,) = p.requests(id);
        assertEq(payer, address(0));
        assertEq(uint8(st), uint8(PayPerCall.Status.None));
        assertEq(fee.balanceOf(address(p)), 0);
        assertEq(fee.balanceOf(alice), START_BAL);
    }

    /// Exercises the `balanceAfter < balanceBefore` half of the received-amount check. Without that
    /// guard the subtraction would underflow and revert with a panic instead of UnexpectedReceivedAmount.
    function test_02_balanceDecreaseDuringPullRejected() public {
        BalanceDecreasingToken shrink = new BalanceDecreasingToken();
        PayPerCall p = new PayPerCall(address(shrink), owner, operator, treasury);
        shrink.mint(address(p), 2 * PRICE); // balance the token can claw back
        shrink.mint(alice, START_BAL);
        vm.prank(alice);
        shrink.approve(address(p), type(uint256).max);
        bytes32 id = p.computeRequestId(alice, NONCE, PARAMS);

        vm.prank(alice);
        vm.expectRevert(PayPerCall.UnexpectedReceivedAmount.selector);
        p.createRequest(NONCE, PARAMS);

        (address payer,,, PayPerCall.Status st,) = p.requests(id);
        assertEq(payer, address(0));
        assertEq(uint8(st), uint8(PayPerCall.Status.None));
        assertEq(shrink.balanceOf(address(p)), 2 * PRICE);
        assertEq(shrink.balanceOf(alice), START_BAL);
    }

    function test_02_zeroParamsHashRejected() public {
        vm.prank(alice);
        vm.expectRevert(PayPerCall.EmptyParamsHash.selector);
        ppc.createRequest(NONCE, bytes32(0));
        assertEq(usdc.balanceOf(address(ppc)), 0);
        assertEq(usdc.balanceOf(alice), START_BAL);
    }

    function test_02_amountIsFixedByContract() public {
        assertEq(ppc.PRICE(), 100_000);
        // No overload accepting an amount exists: such a call hits no selector and reverts.
        vm.prank(alice);
        (bool ok,) = address(ppc).call(abi.encodeWithSignature("createRequest(bytes32,bytes32,uint256)", NONCE, PARAMS, 1));
        assertFalse(ok);
        // Extra trailing calldata cannot change the amount either: exactly PRICE moves.
        bytes memory data = abi.encodePacked(abi.encodeCall(ppc.createRequest, (NONCE, PARAMS)), uint256(1));
        vm.prank(alice);
        (ok,) = address(ppc).call(data);
        assertTrue(ok);
        assertEq(usdc.balanceOf(address(ppc)), PRICE);
        assertEq(usdc.balanceOf(alice), START_BAL - PRICE);
    }

    // ---------------------------------------------------------------- 3
    function test_03_wrongTokenRejectedInConstructor() public {
        address dec18 = address(new Mock18Token());
        address badDec = address(new RevertingDecimalsToken());
        address notToken = address(new NotAToken());
        address eoa = makeAddr("eoa");

        vm.expectRevert(PayPerCall.WrongToken.selector);
        new PayPerCall(dec18, owner, operator, treasury);
        vm.expectRevert(PayPerCall.WrongToken.selector);
        new PayPerCall(badDec, owner, operator, treasury);
        vm.expectRevert(PayPerCall.WrongToken.selector);
        new PayPerCall(eoa, owner, operator, treasury);
        vm.expectRevert(PayPerCall.WrongToken.selector);
        new PayPerCall(notToken, owner, operator, treasury);
    }

    function test_03_zeroAddressArgsRejected() public {
        address u = address(usdc);
        vm.expectRevert(PayPerCall.ZeroAddress.selector);
        new PayPerCall(address(0), owner, operator, treasury);
        vm.expectRevert(PayPerCall.ZeroAddress.selector);
        new PayPerCall(u, owner, address(0), treasury);
        vm.expectRevert(PayPerCall.ZeroAddress.selector);
        new PayPerCall(u, owner, operator, address(0));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new PayPerCall(u, address(0), operator, treasury);
    }

    function test_03_treasuryCannotBeContractItself() public {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        address u = address(usdc);
        vm.expectRevert(PayPerCall.InvalidTreasury.selector);
        new PayPerCall(u, owner, operator, predicted);
    }

    function test_03_constructorAcceptsSixDecimalTokenAndEmits() public {
        vm.expectEmit(true, true, false, false);
        emit PayPerCall.OperatorUpdated(address(0), operator);
        PayPerCall p = new PayPerCall(address(usdc), owner, operator, treasury);
        assertEq(address(p.USDC()), address(usdc));
        assertEq(p.TREASURY(), treasury);
        assertEq(p.operator(), operator);
        assertEq(p.owner(), owner);
    }

    function test_03_unrelatedTokenSentDirectlyIsNotAccounted() public {
        MockUSDC other = new MockUSDC();
        other.mint(alice, PRICE);
        vm.prank(alice);
        other.transfer(address(ppc), PRICE);
        // Contract holds it, but no request exists and the real token balance is untouched.
        assertEq(other.balanceOf(address(ppc)), PRICE);
        assertEq(usdc.balanceOf(address(ppc)), 0);
        bytes32 id = ppc.computeRequestId(alice, NONCE, PARAMS);
        assertEq(uint8(_status(id)), uint8(PayPerCall.Status.None));
        // Cannot be turned into a settle / refund of anything.
        vm.prank(operator);
        vm.expectRevert(_notPaid(PayPerCall.Status.None));
        ppc.settle(id, REPORT);
        vm.prank(alice);
        vm.expectRevert(PayPerCall.NotPayer.selector);
        ppc.refund(id, alice);
    }

    function test_03_returnsFalseTokenCannotCreatePaidRequest() public {
        ReturnsFalseToken rf = new ReturnsFalseToken();
        PayPerCall p = new PayPerCall(address(rf), owner, operator, treasury);
        rf.mint(alice, START_BAL);
        vm.prank(alice);
        rf.approve(address(p), type(uint256).max);
        bytes32 id = p.computeRequestId(alice, NONCE, PARAMS);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(rf)));
        p.createRequest(NONCE, PARAMS);

        (,,, PayPerCall.Status st,) = p.requests(id);
        assertEq(uint8(st), uint8(PayPerCall.Status.None));
        assertEq(rf.balanceOf(address(p)), 0);
    }

    function test_03_treasuryAsPayerSettleNetsToZero() public {
        _fund(treasury);
        bytes32 id = _create(treasury, NONCE, PARAMS);
        assertEq(usdc.balanceOf(treasury), START_BAL - PRICE);
        _settle(id);
        assertEq(uint8(_status(id)), uint8(PayPerCall.Status.Settled));
        assertEq(usdc.balanceOf(treasury), START_BAL);
        assertEq(usdc.balanceOf(address(ppc)), 0);
    }

    function test_03_treasuryAsPayerRefundsAfterDeadline() public {
        _fund(treasury);
        bytes32 id = _create(treasury, NONCE, PARAMS);
        skip(DELAY);
        _refund(treasury, id, treasury);
        assertEq(uint8(_status(id)), uint8(PayPerCall.Status.Refunded));
        assertEq(usdc.balanceOf(treasury), START_BAL);
        assertEq(usdc.balanceOf(address(ppc)), 0);
    }

    function test_03_refundRecipientMayBeTreasury() public {
        bytes32 id = _create(alice, NONCE, PARAMS);
        skip(DELAY);
        _refund(alice, id, treasury);
        assertEq(uint8(_status(id)), uint8(PayPerCall.Status.Refunded));
        assertEq(usdc.balanceOf(treasury), PRICE);
        assertEq(usdc.balanceOf(alice), START_BAL - PRICE);
        assertEq(usdc.balanceOf(address(ppc)), 0);
    }

    /// Holding both the payer and operator roles grants no extra path: refund still waits for the
    /// deadline and settlement still closes at it.
    function test_03_operatorAsPayerGetsNoShortcut() public {
        _fund(operator);
        bytes32 id = _create(operator, NONCE, PARAMS);
        (, , uint64 r, , ) = ppc.requests(id);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(PayPerCall.RefundNotYetAvailable.selector, r));
        ppc.refund(id, operator);

        vm.warp(r);
        vm.prank(operator);
        vm.expectRevert(PayPerCall.SettlementWindowClosed.selector);
        ppc.settle(id, REPORT);

        _refund(operator, id, operator);
        assertEq(uint8(_status(id)), uint8(PayPerCall.Status.Refunded));
        assertEq(usdc.balanceOf(operator), START_BAL);
        assertEq(usdc.balanceOf(treasury), 0);
    }

    // ---------------------------------------------------------------- 4
    function test_04_duplicateIdRejected() public {
        _create(alice, NONCE, PARAMS);
        vm.prank(alice);
        vm.expectRevert(PayPerCall.RequestAlreadyExists.selector);
        ppc.createRequest(NONCE, PARAMS);
        assertEq(usdc.balanceOf(address(ppc)), PRICE); // second payment never pulled
    }

    function test_04_idStaysUnusableAfterSettled() public {
        bytes32 id = _create(alice, NONCE, PARAMS);
        _settle(id);
        vm.prank(alice);
        vm.expectRevert(PayPerCall.RequestAlreadyExists.selector);
        ppc.createRequest(NONCE, PARAMS);
    }

    function test_04_idStaysUnusableAfterRefunded() public {
        bytes32 id = _create(alice, NONCE, PARAMS);
        skip(DELAY);
        _refund(alice, id, alice);
        vm.prank(alice);
        vm.expectRevert(PayPerCall.RequestAlreadyExists.selector);
        ppc.createRequest(NONCE, PARAMS);
    }

    function test_04_sameNonceDifferentParamsGivesDifferentId() public {
        bytes32 id1 = _create(alice, NONCE, PARAMS);
        bytes32 id2 = _create(alice, NONCE, keccak256("other params"));
        bytes32 id3 = _create(alice, keccak256("other nonce"), PARAMS);
        assertTrue(id1 != id2 && id1 != id3 && id2 != id3);
        assertEq(usdc.balanceOf(address(ppc)), 3 * PRICE);
    }

    // ---------------------------------------------------------------- 5
    function test_05_attackerCannotRefundVictimRequest() public {
        bytes32 id = _create(alice, NONCE, PARAMS);
        vm.prank(mallory);
        vm.expectRevert(PayPerCall.NotPayer.selector);
        ppc.refund(id, mallory); // before deadline
        skip(DELAY);
        vm.prank(mallory);
        vm.expectRevert(PayPerCall.NotPayer.selector);
        ppc.refund(id, mallory); // after deadline
        assertEq(usdc.balanceOf(address(ppc)), PRICE);
        assertEq(usdc.balanceOf(mallory), START_BAL);
        assertEq(uint8(_status(id)), uint8(PayPerCall.Status.Paid));
    }

    function test_05_attackerCannotCollideWithVictimId() public {
        bytes32 victimId = _create(alice, NONCE, PARAMS);
        bytes32 attackerId = _create(mallory, NONCE, PARAMS); // identical nonce/params
        assertTrue(victimId != attackerId);
        (address vp,,, PayPerCall.Status vs,) = ppc.requests(victimId);
        (address ap,,, PayPerCall.Status as_,) = ppc.requests(attackerId);
        assertEq(vp, alice);
        assertEq(ap, mallory);
        assertEq(uint8(vs), uint8(PayPerCall.Status.Paid));
        assertEq(uint8(as_), uint8(PayPerCall.Status.Paid));
        assertEq(usdc.balanceOf(address(ppc)), 2 * PRICE);
        assertEq(usdc.balanceOf(alice), START_BAL - PRICE);
        // Victim can still refund their own money; attacker's refund of victim id fails.
        skip(DELAY);
        vm.prank(mallory);
        vm.expectRevert(PayPerCall.NotPayer.selector);
        ppc.refund(victimId, mallory);
        _refund(alice, victimId, alice);
        assertEq(usdc.balanceOf(alice), START_BAL);
    }

    function test_05_unknownRequestIdRefundReverts() public {
        bytes32 unknown = keccak256("unknown");
        skip(DELAY);
        vm.prank(mallory);
        vm.expectRevert(PayPerCall.NotPayer.selector);
        ppc.refund(unknown, mallory);
        vm.prank(address(0));
        // A zero-address caller trivially matches the unset payer (0) but still cannot refund: NotPaid(None).
        vm.expectRevert(_notPaid(PayPerCall.Status.None));
        ppc.refund(unknown, bob);
    }

    // ---------------------------------------------------------------- 6
    function test_06_unauthorizedCannotSettle() public {
        bytes32 id = _create(alice, NONCE, PARAMS);
        address[3] memory callers = [mallory, owner, alice];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(PayPerCall.NotOperator.selector);
            ppc.settle(id, REPORT);
        }
        assertEq(uint8(_status(id)), uint8(PayPerCall.Status.Paid));
        assertEq(usdc.balanceOf(treasury), 0);
    }

    function test_06_oldOperatorCannotSettleAfterRotation() public {
        bytes32 id = _create(alice, NONCE, PARAMS);
        address newOp = makeAddr("newOp");
        vm.prank(owner);
        ppc.setOperator(newOp);
        vm.prank(operator);
        vm.expectRevert(PayPerCall.NotOperator.selector);
        ppc.settle(id, REPORT);
        assertEq(uint8(_status(id)), uint8(PayPerCall.Status.Paid));
    }

    // ---------------------------------------------------------------- 7
    function test_07_settleSucceedsOnce() public {
        bytes32 id = _create(alice, NONCE, PARAMS);
        skip(100);
        vm.expectEmit(true, true, false, true, address(ppc));
        emit PayPerCall.RequestSettled(id, alice, REPORT, PRICE, uint64(block.timestamp));
        _settle(id);
        assertEq(usdc.balanceOf(treasury), PRICE);
        assertEq(usdc.balanceOf(address(ppc)), 0);
        assertEq(uint8(_status(id)), uint8(PayPerCall.Status.Settled));
    }

    function test_07_zeroReportHashRejected() public {
        bytes32 id = _create(alice, NONCE, PARAMS);
        vm.prank(operator);
        vm.expectRevert(PayPerCall.EmptyReportHash.selector);
        ppc.settle(id, bytes32(0));
        assertEq(uint8(_status(id)), uint8(PayPerCall.Status.Paid));
        assertEq(usdc.balanceOf(treasury), 0);
    }

    // ---------------------------------------------------------------- 8
    function test_08_doubleSettlementFails() public {
        bytes32 id = _create(alice, NONCE, PARAMS);
        _settle(id);
        vm.prank(operator);
        vm.expectRevert(_notPaid(PayPerCall.Status.Settled));
        ppc.settle(id, REPORT);
        assertEq(usdc.balanceOf(treasury), PRICE);
    }
}
