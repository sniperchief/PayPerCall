/**
 * Protocol constants and pure helpers shared by the frontend and the Vercel Functions backend.
 * Chain and USDC facts are imported from Arc Studio's registry (src/onchain-facts.ts), which was
 * cross-checked against docs.arc.io and the live RPC: Arc mainnet is chain 5042 and USDC is the
 * 6-decimal ERC-20 interface at 0x3600000000000000000000000000000000000000.
 */
import { encodeAbiParameters, getAddress, isAddress, keccak256, type Address, type Hex } from 'viem'
import { getChain, getUsdc } from '../src/onchain-facts'

/** Production network. Phase 3 targets Arc mainnet only. */
export const PRODUCTION_CHAIN_ID = 5042

/** 0.10 USDC at the ERC-20 view's 6 decimals. Mirrors PayPerCall.PRICE. */
export const PRICE_RAW = 100_000n
/** Mirrors PayPerCall.REFUND_DELAY. */
export const REFUND_DELAY_SECONDS = 1800
/** The backend refuses to start report work, or to settle, with less than this left before the refund deadline. */
export const SETTLE_SAFETY_MARGIN_SECONDS = 300
/** Version of the paramsHash preimage layout. */
export const PARAMS_VERSION = 1

export const MIN_TRADE_SIZE_MICRO_USD = 1_000_000n // 1 USD
export const MAX_TRADE_SIZE_MICRO_USD = 10_000_000_000_000n // 10,000,000 USD

export const REQUEST_STATUSES = [
  'CREATED',
  'PAYMENT_VERIFIED',
  'PROCESSING',
  'REPORT_READY',
  'SETTLING',
  'COMPLETED',
  'FAILED',
  'REFUNDED',
  'EXPIRED',
] as const
export type RequestStatus = (typeof REQUEST_STATUSES)[number]

export type PaymentState = 'none' | 'paid' | 'settled' | 'refunded'

export interface CreateRequestBody {
  token: string
  tradeSizeUsd: string
  payer: string
}

export interface CreateRequestResponse {
  requestId: Hex
  nonce: Hex
  paramsHash: Hex
  chainId: number
  contract: Address
  usdc: Address
  priceRaw: string
  refundDelaySeconds: number
  expiresAt: number
  /** Shown once. Only its hash is stored server side. */
  accessToken: string
}

export interface RequestView {
  requestId: Hex
  status: RequestStatus
  token: Address
  tradeSizeUsd: string
  payer: Address
  payment: { state: PaymentState; createdAt: number | null; refundableAt: number | null }
  settleTxHash: Hex | null
  reportAvailable: boolean
  failure: string | null
  settlementEnabled: boolean
}

export interface ApiErrorBody {
  error: string
  message: string
  reasons?: string[]
}

export function isHash32(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)
}

/** Parses "1234.56" style input into micro-USD (6 decimals). Returns null when invalid or out of range. */
export function parseTradeSizeUsd(input: unknown): bigint | null {
  if (typeof input !== 'string') return null
  const match = /^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(input.trim())
  if (!match) return null
  const whole = BigInt(match[1])
  const cents = BigInt((match[2] ?? '').padEnd(2, '0'))
  const micro = (whole * 100n + cents) * 10_000n
  if (micro < MIN_TRADE_SIZE_MICRO_USD || micro > MAX_TRADE_SIZE_MICRO_USD) return null
  return micro
}

export function formatTradeSizeUsd(micro: bigint): string {
  const cents = micro / 10_000n
  const whole = cents / 100n
  const frac = (cents % 100n).toString().padStart(2, '0')
  return `${whole.toString()}.${frac}`
}

export function parseAddress(input: unknown): Address | null {
  if (typeof input !== 'string' || !isAddress(input, { strict: false })) return null
  return getAddress(input)
}

export function isZeroAddress(address: string): boolean {
  return /^0x0{40}$/i.test(address)
}

/** keccak256(abi.encode(uint8 version, uint256 chainId, address token, uint256 tradeSizeMicroUsd)) */
export function computeParamsHash(token: Address, tradeSizeMicroUsd: bigint, chainId = PRODUCTION_CHAIN_ID): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'uint8' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }],
      [PARAMS_VERSION, BigInt(chainId), token, tradeSizeMicroUsd],
    ),
  )
}

/** Mirrors PayPerCall.computeRequestId: keccak256(abi.encode(chainid, contract, payer, nonce, paramsHash)). */
export function computeRequestId(
  contract: Address,
  payer: Address,
  nonce: Hex,
  paramsHash: Hex,
  chainId = PRODUCTION_CHAIN_ID,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }, { type: 'bytes32' }],
      [BigInt(chainId), contract, payer, nonce, paramsHash],
    ),
  )
}

export interface ProductionFacts {
  chainId: number
  rpcUrl: string
  explorerBase: string
  usdc: Address
  usdcDecimals: number
}

/** Production chain facts from the registry. Throws if the registry no longer matches the verified values. */
export function productionFacts(): ProductionFacts {
  const chain = getChain(PRODUCTION_CHAIN_ID)
  const usdc = getUsdc(PRODUCTION_CHAIN_ID)
  if (!chain || chain.isTestnet || !usdc || chain.rpcUrls.length === 0) {
    throw new Error('Arc mainnet is missing from the onchain facts registry')
  }
  return {
    chainId: chain.chainId,
    rpcUrl: chain.rpcUrls[0],
    explorerBase: chain.explorerBase,
    usdc: getAddress(usdc.address),
    usdcDecimals: usdc.decimals,
  }
}
