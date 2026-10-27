import type { RequestView } from '../../shared/protocol'

export type StepState = 'done' | 'active' | 'pending' | 'failed'
export type Tone = 'progress' | 'success' | 'danger' | 'neutral'

export interface StageStep {
  key: 'payment' | 'report' | 'settle' | 'unlock'
  label: string
  state: StepState
}

export interface Stage {
  headline: string
  detail: string
  tone: Tone
  steps: StageStep[]
  /** True while the page should keep polling the server. */
  polling: boolean
}

const FAILURE_COPY: Record<string, string> = {
  PAYMENT_MISMATCH: 'The onchain payment did not match this request.',
  DEADLINE_MARGIN: 'There was not enough time left before the refund deadline to deliver safely.',
  REPORT_GENERATION_FAILED: 'The report could not be generated.',
  PROCESSING_TIMEOUT: 'Report processing timed out.',
  SETTLE_REVERTED: 'The settlement transaction was rejected by the contract.',
  SETTLEMENT_WINDOW_CLOSED: 'Settlement did not finish before the refund deadline.',
  SETTLEMENT_MISMATCH: 'The settlement did not match the stored report, so the report stays locked.',
  SETTLE_BROADCAST_FAILED: 'The settlement transaction could not be sent.',
  UNEXPECTED_ONCHAIN_STATE: 'The onchain request is in an unexpected state.',
}

const LABELS = { payment: 'Payment confirmed', report: 'Report generated', settle: 'Settled onchain', unlock: 'Report unlocked' } as const
const ORDER = ['payment', 'report', 'settle', 'unlock'] as const

function steps(done: number, active: number | null, failedAt: number | null = null): StageStep[] {
  return ORDER.map((key, index) => ({
    key,
    label: LABELS[key],
    state: failedAt === index ? 'failed' : index < done ? 'done' : active === index ? 'active' : 'pending',
  }))
}

/** Maps the server's view of a request to what the user sees. Only states the server reported are shown. */
export function describeStage(view: RequestView): Stage {
  switch (view.status) {
    case 'CREATED':
      return {
        headline: 'Waiting for the onchain payment',
        detail: 'Nothing has been paid yet. The server checks the contract for your payment; a wallet callback is never trusted.',
        tone: 'progress',
        steps: steps(0, 0),
        polling: true,
      }
    case 'PAYMENT_VERIFIED':
    case 'PROCESSING':
      return {
        headline: 'Payment verified. Generating your report',
        detail: 'The contract shows your 0.10 USDC as paid. The report is being built from Arc mainnet data.',
        tone: 'progress',
        steps: steps(1, 1),
        polling: true,
      }
    case 'REPORT_READY':
    case 'SETTLING':
      return {
        headline: view.settlementEnabled ? 'Settling onchain' : 'Report ready, settlement is not enabled',
        detail: view.settlementEnabled
          ? 'Your report is released only after the contract records the settlement.'
          : 'This server has no settlement key configured, so the report stays locked. You can refund after the 30 minute deadline.',
        tone: view.settlementEnabled ? 'progress' : 'danger',
        steps: steps(2, view.settlementEnabled ? 2 : null, view.settlementEnabled ? null : 2),
        polling: view.settlementEnabled,
      }
    case 'COMPLETED':
      return view.reportAvailable
        ? { headline: 'Report unlocked', detail: 'Settlement is confirmed onchain.', tone: 'success', steps: steps(4, null), polling: false }
        : {
            headline: 'Settled, verifying the report',
            detail: 'Waiting for the contract state to confirm the settlement before revealing the report.',
            tone: 'progress',
            steps: steps(3, 3),
            polling: true,
          }
    case 'FAILED': {
      const detail = (view.failure && FAILURE_COPY[view.failure]) || 'The request could not be completed.'
      const refundable = view.payment.state === 'paid'
      return {
        headline: 'Report not delivered',
        detail: refundable ? `${detail} Your 0.10 USDC is still held by the contract and can be refunded after the deadline.` : detail,
        tone: 'danger',
        steps: steps(view.payment.state === 'none' ? 0 : 1, null, view.payment.state === 'none' ? 0 : 1),
        polling: refundable,
      }
    }
    case 'REFUNDED':
      return { headline: 'Refunded', detail: 'The contract returned your 0.10 USDC.', tone: 'neutral', steps: steps(1, null, 1), polling: false }
    case 'EXPIRED':
      // A payment can still land after the server expired the request; it is never processed, only refundable.
      if (view.payment.state === 'paid') {
        return {
          headline: 'Payment arrived after the request expired',
          detail: 'The request expired before the server saw your payment, so no report will be generated. Your 0.10 USDC is still held by the contract and can be refunded after the deadline.',
          tone: 'danger',
          steps: steps(1, null, 1),
          polling: true,
        }
      }
      if (view.payment.state === 'refunded') {
        return { headline: 'Refunded', detail: 'The contract returned your 0.10 USDC.', tone: 'neutral', steps: steps(1, null, 1), polling: false }
      }
      return {
        headline: 'Request expired',
        detail: 'No payment was found within 30 minutes, so nothing was charged.',
        tone: 'neutral',
        steps: steps(0, null, 0),
        polling: false,
      }
  }
}

/** The parts of GET /health that decide whether a payment can be serviced. */
export interface ServiceHealth {
  ready: boolean
  settlementEnabled?: boolean
  paused?: boolean
}

/** Why a payment must not start right now, or null when the server can verify and settle it. */
export function paymentBlockedReason(health: ServiceHealth): string | null {
  if (!health.ready) return 'The service is not ready for payments yet. Nothing was charged.'
  if (health.paused) return 'New payments are paused. Nothing was charged.'
  if (health.settlementEnabled !== true) return 'Settlement is not configured on the server, so a payment could not be delivered. Nothing was charged.'
  return null
}

/** Seconds kept free before a request's server-side expiry so a payment started now still lands in time. */
export const PAYMENT_START_MARGIN_SECONDS = 300

/** Whether a new payment may start for a request that expires at `expiresAt` (unix seconds). */
export function paymentWindowOpen(expiresAt: number, nowMs: number): boolean {
  return Math.floor(nowMs / 1000) + PAYMENT_START_MARGIN_SECONDS < expiresAt
}

export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`
}

/** Seconds until the contract allows a refund, or 0 when it already does. Uses the caller's clock. */
export function refundCountdownSeconds(refundableAt: number | null, nowMs: number): number | null {
  return refundableAt === null ? null : Math.max(0, refundableAt - Math.floor(nowMs / 1000))
}
