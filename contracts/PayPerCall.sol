// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title PayPerCall
 * @notice Pay-per-request intelligence escrow: exactly 0.10 USDC per request.
 * @dev State machine: None -> Paid by the payer through createRequest while
 * unpaused, with nonzero paramsHash, an unused ID, and receipt of exactly PRICE.
 * Paid -> Settled by the operator with a nonzero reportHash before refundableAt;
 * Paid -> Refunded by the original payer at or after refundableAt to a chosen
 * recipient that is not the zero address, this contract, or the USDC token contract.
 * Terminal IDs are never reusable. Pause affects creation only.
 *
 * The operator can send escrow only to the immutable treasury. A stolen operator
 * key can falsely mark a request complete, costing its payer 0.10 USDC paid to
 * treasury, but cannot steal the escrow. The owner can change the operator and
 * pause creation, but cannot move escrow funds or redirect the treasury.
 *
 * USDC blocklisting this contract, the treasury, or a recipient makes affected
 * transfers revert atomically with state unchanged. If this contract itself is
 * blocklisted, funds are stuck and no contract logic can fix it. A blocked payer
 * can refund to another recipient. Native USDC force-sent to this contract is
 * unrecoverable; escrow accounting uses request state, never balance equality.
 *
 * Intended for Arc Testnet (5042002), where six-decimal NativeFiatToken USDC at
 * 0x3600000000000000000000000000000000000000 reflects native USDC balances.
 * Payers use approve + transferFrom; no permit or transfer authorization assumed.
 * Arc USDC Transfer logs come from both the USDC contract and system emitter
 * 0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE. Integrators must rely on this
 * contract's own events and request state, not USDC Transfer logs. Timestamps may
 * repeat across blocks; IDs do not depend on timestamps, and the refund boundary
 * is exclusive of settlement even when successive blocks share a timestamp.
 */
contract PayPerCall is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant PRICE = 100_000; // 0.10 USDC at 6 decimals.
    uint64 public constant REFUND_DELAY = 30 minutes;

    IERC20 public immutable USDC;
    address public immutable TREASURY;
    address public operator;

    enum Status { None, Paid, Settled, Refunded }

    struct Request {
        address payer;
        uint64 createdAt;
        uint64 refundableAt;
        Status status;
        bytes32 paramsHash;
    }

    mapping(bytes32 => Request) public requests;

    error ZeroAddress();
    error WrongToken();
    error InvalidTreasury();
    error InvalidRecipient();
    error EmptyParamsHash();
    error EmptyReportHash();
    error RequestAlreadyExists();
    error UnexpectedReceivedAmount();
    error NotPaid(Status currentStatus);
    error SettlementWindowClosed();
    error NotPayer();
    error RefundNotYetAvailable(uint64 refundableAt);
    error NotOperator();
    error SameOperator();
    error RenounceDisabled();

    event OperatorUpdated(address indexed oldOperator, address indexed newOperator);
    event RequestCreated(
        bytes32 indexed requestId, address indexed payer, bytes32 paramsHash,
        bytes32 nonce, uint256 amount, uint64 createdAt, uint64 refundableAt
    );
    event RequestSettled(
        bytes32 indexed requestId, address indexed payer, bytes32 reportHash,
        uint256 amount, uint64 settledAt
    );
    event RequestRefunded(
        bytes32 indexed requestId, address indexed payer, address recipient, uint256 amount
    );

    constructor(address usdc, address initialOwner, address initialOperator, address treasury)
        Ownable(initialOwner)
    {
        if (usdc == address(0) || initialOperator == address(0) || treasury == address(0)) {
            revert ZeroAddress();
        }
        if (treasury == address(this)) revert InvalidTreasury();
        if (usdc.code.length == 0) revert WrongToken();
        try IERC20Metadata(usdc).decimals() returns (uint8 tokenDecimals) {
            if (tokenDecimals != 6) revert WrongToken();
        } catch {
            revert WrongToken();
        }
        USDC = IERC20(usdc);
        TREASURY = treasury;
        operator = initialOperator;
        emit OperatorUpdated(address(0), initialOperator);
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    function computeRequestId(address payer, bytes32 nonce, bytes32 paramsHash)
        public view returns (bytes32)
    {
        return keccak256(abi.encode(block.chainid, address(this), payer, nonce, paramsHash));
    }

    function createRequest(bytes32 nonce, bytes32 paramsHash)
        external whenNotPaused nonReentrant returns (bytes32 requestId)
    {
        if (paramsHash == bytes32(0)) revert EmptyParamsHash();
        requestId = computeRequestId(msg.sender, nonce, paramsHash);
        if (requests[requestId].status != Status.None) revert RequestAlreadyExists();
        uint64 createdAt = SafeCast.toUint64(block.timestamp);
        uint64 refundableAt = SafeCast.toUint64(block.timestamp + REFUND_DELAY);
        requests[requestId] = Request(msg.sender, createdAt, refundableAt, Status.Paid, paramsHash);
        uint256 balanceBefore = USDC.balanceOf(address(this));
        USDC.safeTransferFrom(msg.sender, address(this), PRICE);
        uint256 balanceAfter = USDC.balanceOf(address(this));
        if (balanceAfter < balanceBefore || balanceAfter - balanceBefore != PRICE) {
            revert UnexpectedReceivedAmount();
        }
        emit RequestCreated(requestId, msg.sender, paramsHash, nonce, PRICE, createdAt, refundableAt);
    }

    function settle(bytes32 requestId, bytes32 reportHash) external onlyOperator nonReentrant {
        Request storage request = requests[requestId];
        if (request.status != Status.Paid) revert NotPaid(request.status);
        if (reportHash == bytes32(0)) revert EmptyReportHash();
        if (block.timestamp >= request.refundableAt) revert SettlementWindowClosed();
        request.status = Status.Settled;
        USDC.safeTransfer(TREASURY, PRICE);
        emit RequestSettled(requestId, request.payer, reportHash, PRICE, uint64(block.timestamp));
    }

    function refund(bytes32 requestId, address recipient) external nonReentrant {
        Request storage request = requests[requestId];
        if (msg.sender != request.payer) revert NotPayer();
        if (request.status != Status.Paid) revert NotPaid(request.status);
        if (block.timestamp < request.refundableAt) revert RefundNotYetAvailable(request.refundableAt);
        if (recipient == address(0)) revert ZeroAddress();
        // A refund to this contract would mark the request Refunded while the escrow stays locked here;
        // a refund to the USDC token contract would strand it on the token.
        if (recipient == address(this) || recipient == address(USDC)) revert InvalidRecipient();
        request.status = Status.Refunded;
        USDC.safeTransfer(recipient, PRICE);
        emit RequestRefunded(requestId, request.payer, recipient, PRICE);
    }

    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert ZeroAddress();
        if (newOperator == operator) revert SameOperator();
        address oldOperator = operator;
        operator = newOperator;
        emit OperatorUpdated(oldOperator, newOperator);
    }

    function pause() public onlyOwner { _pause(); }
    function unpause() public onlyOwner { _unpause(); }
    function renounceOwnership() public pure override { revert RenounceDisabled(); }
}
