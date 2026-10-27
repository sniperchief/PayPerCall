import { Check, CircleDashed, Loader2, X } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import type { FlowState } from '../hooks/usePayFlow'
import { useReport, useRequestView } from '../hooks/useRequestView'
import { ApiError } from '../lib/api'
import type { HistoryEntry } from '../lib/history'
import { describeStage, type StepState } from '../lib/stages'
import { PRODUCTION_CHAIN_ID } from '../../shared/protocol'
import { buildTxExplorerUrl } from '../onchain-facts'
import { RefundPanel } from './RefundPanel'
import { ReportView } from './ReportView'

interface Props {
  entry: HistoryEntry
  flow: FlowState
  onResume: (entry: HistoryEntry) => void
}

const TONE_COLOR = { progress: 'var(--accent)', success: 'var(--success)', danger: 'var(--danger)', neutral: 'var(--muted)' } as const

function StepIcon({ state }: { state: StepState }) {
  if (state === 'done') return <Check className="size-4" style={{ color: 'var(--success)' }} aria-hidden />
  if (state === 'failed') return <X className="size-4" style={{ color: 'var(--danger)' }} aria-hidden />
  if (state === 'active') return <Loader2 className="size-4 animate-spin" style={{ color: 'var(--accent)' }} aria-hidden />
  return <CircleDashed className="size-4" style={{ color: 'var(--subtle)' }} aria-hidden />
}

export function RequestPanel({ entry, flow, onResume }: Props) {
  const queryClient = useQueryClient()
  const view = useRequestView(entry)
  const report = useReport(entry, view.data?.reportAvailable ?? false)
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['request-view', entry.created.requestId] })

  if (view.isLoading) {
    return <section className="card p-6 text-sm" style={{ color: 'var(--muted)' }}>Loading request...</section>
  }
  if (view.isError || !view.data) {
    const gone = view.error instanceof ApiError && view.error.status === 404
    return (
      <section className="card p-6" role="alert">
        <h2 className="display text-lg font-semibold">{gone ? 'Request not found' : 'Could not load this request'}</h2>
        <p className="mt-1.5 text-sm" style={{ color: 'var(--muted)' }}>
          {gone ? 'The server no longer has this request, or the saved access token does not match.' : 'The API did not respond. This page will retry.'}
        </p>
      </section>
    )
  }

  const data = view.data
  const stage = describeStage(data)
  // pay() refuses to start when the request is close to expiring, so Resume stays a plain status check here.
  const showResume = data.status === 'CREATED' && data.payment.state === 'none' && (flow.phase === 'idle' || flow.phase === 'error')
  const showRefund =
    data.payment.state === 'paid' &&
    (data.status === 'FAILED' || data.status === 'EXPIRED' || (data.status === 'REPORT_READY' && !data.settlementEnabled))

  return (
    <section className="card p-5 sm:p-6" aria-live="polite">
      <div className="label">Request</div>
      <h2 className="display mt-1 text-2xl font-semibold text-balance" style={{ color: TONE_COLOR[stage.tone] }}>{stage.headline}</h2>
      <p className="mt-2 text-sm text-pretty" style={{ color: 'var(--muted)' }}>{stage.detail}</p>

      <ol className="mt-4 space-y-2">
        {stage.steps.map((step) => (
          <li key={step.key} className="flex items-center gap-2.5 text-sm" style={{ color: step.state === 'pending' ? 'var(--subtle)' : 'var(--ink-2)' }}>
            <StepIcon state={step.state} />
            {step.label}
          </li>
        ))}
      </ol>

      <div className="mono mt-4 space-y-1 break-all text-xs" style={{ color: 'var(--subtle)' }}>
        <div>Request {data.requestId}</div>
        {flow.payHash && flow.phase !== 'idle' && (
          <a className="link block" href={buildTxExplorerUrl(PRODUCTION_CHAIN_ID, flow.payHash)} target="_blank" rel="noreferrer">Payment transaction</a>
        )}
        {data.settleTxHash && (
          <a className="link block" href={buildTxExplorerUrl(PRODUCTION_CHAIN_ID, data.settleTxHash)} target="_blank" rel="noreferrer">Settlement transaction</a>
        )}
      </div>

      {showResume && (
        <button type="button" className="btn btn-primary mt-4" onClick={() => onResume(entry)}>Resume payment</button>
      )}
      {showRefund && <RefundPanel entry={entry} refundableAt={data.payment.refundableAt} onRefunded={refresh} />}

      {data.reportAvailable && report.isLoading && <p className="mt-4 text-sm" style={{ color: 'var(--muted)' }}>Fetching report...</p>}
      {data.reportAvailable && report.isError && (
        <p role="alert" className="mt-4 text-sm" style={{ color: 'var(--danger)' }}>
          The report is not available right now. The server re-checks the contract before revealing it; try again shortly.
        </p>
      )}
      {report.data && <ReportView data={report.data} />}
    </section>
  )
}
