import { Check, Circle, CircleDashed, X } from 'lucide-react'
import type { PaymentState, RequestStatus, RequestView } from '../../shared/protocol'
import type { StepState } from '../lib/stages'

/** Illustrative values for static previews. Never shown as live data. */
export const SAMPLE = {
  token: '0x4f1a8c0e2b7d93a6c51e0f8b2d4c7a91e3b609c2',
  requestId: '0x9c3e5a17d0b4f2e86c19a7d3e5f0b2c48a6d1e7f3b905c2a4d8e6f1b3c7a41ab',
  tradeSizeUsd: '25,000.00',
} as const

/** A request view in a given state, fed through the app's own describeStage so previews match the product copy. */
export function sampleView(status: RequestStatus, payment: PaymentState, extra: Partial<RequestView> = {}): RequestView {
  return {
    requestId: SAMPLE.requestId,
    status,
    token: SAMPLE.token,
    tradeSizeUsd: '25000.00',
    payer: '0x0000000000000000000000000000000000000001',
    payment: { state: payment, createdAt: null, refundableAt: null },
    settleTxHash: null,
    reportAvailable: false,
    failure: null,
    settlementEnabled: true,
    ...extra,
  }
}

export function shorten(value: string, head = 6, tail = 4): string {
  return `${value.slice(0, head)}...${value.slice(-tail)}`
}

/** Static step marker. Active steps get a solid dot rather than a spinner: previews never imply live activity. */
export function StepMark({ state }: { state: StepState }) {
  if (state === 'done') {
    return (
      <span className="flex size-5 items-center justify-center rounded-full" style={{ background: 'var(--success-soft)' }}>
        <Check className="size-3.5" style={{ color: 'var(--success)' }} strokeWidth={2.5} aria-hidden />
      </span>
    )
  }
  if (state === 'failed') {
    return (
      <span className="flex size-5 items-center justify-center rounded-full" style={{ background: 'var(--danger-soft)' }}>
        <X className="size-3.5" style={{ color: 'var(--danger)' }} strokeWidth={2.5} aria-hidden />
      </span>
    )
  }
  if (state === 'active') {
    return (
      <span className="flex size-5 items-center justify-center rounded-full" style={{ background: 'var(--accent-soft)' }}>
        <Circle className="size-2.5" style={{ color: 'var(--accent)', fill: 'var(--accent)' }} aria-hidden />
      </span>
    )
  }
  return (
    <span className="flex size-5 items-center justify-center">
      <CircleDashed className="size-4" style={{ color: 'var(--border-strong)' }} aria-hidden />
    </span>
  )
}

export function PreviewTag({ children = 'Preview with sample values' }: { children?: string }) {
  return (
    <span className="inline-flex items-center rounded-md px-2 py-1 text-[0.6875rem] font-semibold" style={{ background: 'var(--surface-muted)', color: 'var(--subtle)', border: '1px solid var(--border)' }}>
      {children}
    </span>
  )
}
