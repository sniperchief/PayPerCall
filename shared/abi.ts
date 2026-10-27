/**
 * Typed fragments of the reviewed PayPerCall ABI (docs/PayPerCall.abi.json).
 * A test asserts every fragment here exists in that JSON file, so drift fails CI.
 */
import { parseAbi } from 'viem'

export const payPerCallAbi = parseAbi([
  'function PRICE() view returns (uint256)',
  'function REFUND_DELAY() view returns (uint64)',
  'function USDC() view returns (address)',
  'function TREASURY() view returns (address)',
  'function operator() view returns (address)',
  'function paused() view returns (bool)',
  'function computeRequestId(address payer, bytes32 nonce, bytes32 paramsHash) view returns (bytes32)',
  'function requests(bytes32 requestId) view returns (address payer, uint64 createdAt, uint64 refundableAt, uint8 status, bytes32 paramsHash)',
  'function createRequest(bytes32 nonce, bytes32 paramsHash) returns (bytes32 requestId)',
  'function settle(bytes32 requestId, bytes32 reportHash)',
  'function refund(bytes32 requestId, address recipient)',
  'event RequestCreated(bytes32 indexed requestId, address indexed payer, bytes32 paramsHash, bytes32 nonce, uint256 amount, uint64 createdAt, uint64 refundableAt)',
  'event RequestSettled(bytes32 indexed requestId, address indexed payer, bytes32 reportHash, uint256 amount, uint64 settledAt)',
  'event RequestRefunded(bytes32 indexed requestId, address indexed payer, address recipient, uint256 amount)',
  'error ZeroAddress()',
  'error WrongToken()',
  'error InvalidTreasury()',
  'error InvalidRecipient()',
  'error EmptyParamsHash()',
  'error EmptyReportHash()',
  'error RequestAlreadyExists()',
  'error UnexpectedReceivedAmount()',
  'error NotPaid(uint8 currentStatus)',
  'error SettlementWindowClosed()',
  'error NotPayer()',
  'error RefundNotYetAvailable(uint64 refundableAt)',
  'error NotOperator()',
  'error SameOperator()',
  'error RenounceDisabled()',
  'error EnforcedPause()',
])

/** Onchain `Status` enum of PayPerCall. */
export const ONCHAIN_STATUS = { None: 0, Paid: 1, Settled: 2, Refunded: 3 } as const
export type OnchainStatus = (typeof ONCHAIN_STATUS)[keyof typeof ONCHAIN_STATUS]
