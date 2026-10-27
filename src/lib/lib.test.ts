import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BaseError, UserRejectedRequestError } from 'viem'
import type { RequestView } from '../../shared/protocol'
import { describeTxError } from './errors'
import { loadHistory, removeEntry, saveEntry, type HistoryEntry } from './history'
import { parseContractAddress } from './env'
import {
  PAYMENT_START_MARGIN_SECONDS,
  describeStage,
  formatCountdown,
  paymentBlockedReason,
  paymentWindowOpen,
  refundCountdownSeconds,
} from './stages'

const A = `0x${'11'.repeat(20)}` as const
const B = `0x${'22'.repeat(20)}` as const
const H = `0x${'33'.repeat(32)}` as const

function view(overrides: Partial<RequestView> = {}): RequestView {
  return {
    requestId: H,
    status: 'CREATED',
    token: A,
    tradeSizeUsd: '100.00',
    payer: B,
    payment: { state: 'none', createdAt: null, refundableAt: null },
    settleTxHash: null,
    reportAvailable: false,
    failure: null,
    settlementEnabled: true,
    ...overrides,
  }
}

test('the contract address placeholder fails closed', () => {
  assert.equal(parseContractAddress(undefined).ok, false)
  assert.equal(parseContractAddress('').ok, false)
  assert.equal(parseContractAddress('   ').ok, false)
  assert.equal(parseContractAddress('0x12').ok, false)
  assert.equal(parseContractAddress(`0x${'00'.repeat(20)}`).ok, false)
  assert.equal(parseContractAddress(A).ok, true)
})

test('the UI shows only what the server reported: a report is never unlocked before settlement', () => {
  assert.equal(describeStage(view({ status: 'CREATED' })).steps[0].state, 'active')
  assert.equal(describeStage(view({ status: 'PROCESSING' })).steps[1].state, 'active')
  const settling = describeStage(view({ status: 'SETTLING', payment: { state: 'paid', createdAt: 1, refundableAt: 1801 } }))
  assert.equal(settling.steps[2].state, 'active')
  assert.equal(settling.steps[3].state, 'pending')
  const settledNotRevealed = describeStage(view({ status: 'COMPLETED', reportAvailable: false }))
  assert.notEqual(settledNotRevealed.tone, 'success')
  assert.equal(settledNotRevealed.steps[3].state, 'active')
  const unlocked = describeStage(view({ status: 'COMPLETED', reportAvailable: true }))
  assert.equal(unlocked.tone, 'success')
  assert.ok(unlocked.steps.every((s) => s.state === 'done'))
})

test('failed requests explain the refund path only while the contract still holds the payment', () => {
  const held = describeStage(view({ status: 'FAILED', failure: 'REPORT_GENERATION_FAILED', payment: { state: 'paid', createdAt: 1, refundableAt: 1801 } }))
  assert.equal(held.tone, 'danger')
  assert.ok(held.detail.includes('refunded'))
  assert.equal(held.polling, true)
  const refunded = describeStage(view({ status: 'REFUNDED', payment: { state: 'refunded', createdAt: 1, refundableAt: 1801 } }))
  assert.equal(refunded.polling, false)
})

test('without a settlement key the stage says the report stays locked', () => {
  const stage = describeStage(view({ status: 'REPORT_READY', settlementEnabled: false, payment: { state: 'paid', createdAt: 1, refundableAt: 1801 } }))
  assert.equal(stage.tone, 'danger')
  assert.equal(stage.polling, false)
})

test('a payment that lands after expiry is shown as held and refundable, never as "nothing was charged"', () => {
  const paidLate = describeStage(view({ status: 'EXPIRED', payment: { state: 'paid', createdAt: 1, refundableAt: 1801 } }))
  assert.equal(paidLate.tone, 'danger')
  assert.ok(paidLate.detail.includes('refunded'))
  assert.ok(!paidLate.detail.includes('nothing was charged'))
  assert.equal(paidLate.polling, true)
  const refundedLate = describeStage(view({ status: 'EXPIRED', payment: { state: 'refunded', createdAt: 1, refundableAt: 1801 } }))
  assert.equal(refundedLate.headline, 'Refunded')
  assert.equal(refundedLate.polling, false)
  const unpaid = describeStage(view({ status: 'EXPIRED' }))
  assert.ok(unpaid.detail.includes('nothing was charged'))
})

test('a payment may start only while the request is comfortably before its expiry', () => {
  const expiresAt = 10_000
  assert.equal(paymentWindowOpen(expiresAt, (expiresAt - PAYMENT_START_MARGIN_SECONDS - 1) * 1000), true)
  assert.equal(paymentWindowOpen(expiresAt, (expiresAt - PAYMENT_START_MARGIN_SECONDS) * 1000), false)
  assert.equal(paymentWindowOpen(expiresAt, expiresAt * 1000), false)
})

test('a payment never starts unless the server is ready, unpaused and able to settle', () => {
  assert.equal(paymentBlockedReason({ ready: true, settlementEnabled: true, paused: false }), null)
  assert.ok(paymentBlockedReason({ ready: false })?.includes('Nothing was charged'))
  assert.ok(paymentBlockedReason({ ready: true, settlementEnabled: true, paused: true })?.includes('paused'))
  assert.ok(paymentBlockedReason({ ready: true, settlementEnabled: false, paused: false })?.includes('Settlement is not configured'))
  // A missing field fails closed rather than assuming settlement works.
  assert.notEqual(paymentBlockedReason({ ready: true }), null)
})

test('refund countdown uses the contract deadline and the local clock', () => {
  assert.equal(refundCountdownSeconds(null, 0), null)
  assert.equal(refundCountdownSeconds(1000, 400_000), 600)
  assert.equal(refundCountdownSeconds(1000, 2_000_000), 0)
  assert.equal(formatCountdown(125), '02:05')
})

test('wallet rejection is reported as a cancel, not an error', () => {
  const rejected = new BaseError('wrapper', { cause: new UserRejectedRequestError(new Error('no')) })
  assert.equal(describeTxError(rejected).kind, 'rejected')
  assert.equal(describeTxError(new Error('insufficient funds for gas')).kind, 'reverted')
  assert.equal(describeTxError(new Error('boom')).kind, 'other')
})

test('local history round-trips, dedupes by request, and ignores corrupt data', () => {
  const store = new Map<string, string>()
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
  const entry: HistoryEntry = {
    created: {
      requestId: H,
      nonce: H,
      paramsHash: H,
      chainId: 5042,
      contract: A,
      usdc: B,
      priceRaw: '100000',
      refundDelaySeconds: 1800,
      expiresAt: 1,
      accessToken: 'ppc_token',
    },
    token: A,
    tradeSizeUsd: '100.00',
    payer: B,
    savedAt: 1,
  }
  assert.equal(saveEntry(entry, storage).length, 1)
  assert.equal(saveEntry({ ...entry, savedAt: 2 }, storage).length, 1)
  assert.equal(loadHistory(storage)[0].savedAt, 2)
  store.set('payper-call:requests:v1', '[{"created":{}}]')
  assert.deepEqual(loadHistory(storage), [])
  store.set('payper-call:requests:v1', 'not json')
  assert.deepEqual(loadHistory(storage), [])
  saveEntry(entry, storage)
  assert.deepEqual(removeEntry(H, storage), [])
})
