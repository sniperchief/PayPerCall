import { useQuery } from '@tanstack/react-query'
import { ShieldAlert } from 'lucide-react'
import { api, ApiError } from '../lib/api'
import { contractConfig } from '../lib/env'

export interface Readiness {
  ready: boolean
  reasons: string[]
  loading: boolean
}

/** Combines the frontend's own config check with the server's preflight. Both must pass before any payment. */
export function useReadiness(): Readiness {
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 30_000, retry: 1 })
  const reasons: string[] = []
  if (!contractConfig.ok) reasons.push(contractConfig.reason)
  if (health.isError) {
    reasons.push(health.error instanceof ApiError && health.error.status === 0 ? 'The PayPerCall API is not reachable.' : 'The PayPerCall API returned an error.')
  } else if (health.data && !health.data.ready) {
    reasons.push(...(health.data.reasons ?? ['The API reports it is not ready.']))
  } else if (health.data?.paused) {
    reasons.push('New requests are paused by the contract owner.')
  }
  return { ready: !health.isLoading && reasons.length === 0, reasons, loading: health.isLoading }
}

export function ConfigNotice({ readiness }: { readiness: Readiness }) {
  if (readiness.loading || readiness.ready) return null
  return (
    <section className="card p-5" role="alert">
      <div className="flex items-center gap-2">
        <ShieldAlert className="size-5" style={{ color: 'var(--warn)' }} aria-hidden />
        <h2 className="display text-lg font-semibold">Payments are disabled</h2>
      </div>
      <p className="mt-2 text-sm text-pretty" style={{ color: 'var(--muted)' }}>
        PayPerCall fails closed: it will not take a payment until the contract and API are configured for Arc mainnet.
      </p>
      <ul className="mt-3 space-y-1.5 text-sm" style={{ color: 'var(--ink-2)' }}>
        {readiness.reasons.map((reason) => (
          <li key={reason} className="flex gap-2">
            <span aria-hidden style={{ color: 'var(--warn)' }}>-</span>
            <span>{reason}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
