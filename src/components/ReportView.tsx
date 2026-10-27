import { ExternalLink, FileCheck2 } from 'lucide-react'
import { PRODUCTION_CHAIN_ID } from '../../shared/protocol'
import type { ReportResponse } from '../lib/api'
import { buildAddressExplorerUrl, buildTxExplorerUrl } from '../onchain-facts'

const SECTION_TITLES = { token: 'Token', wallet: 'Wallet activity', liquidity: 'Liquidity' } as const
const STATUS_COPY = { ok: 'Complete', partial: 'Partial', unavailable: 'Unavailable' } as const

export function ReportView({ data }: { data: ReportResponse }) {
  const { report } = data
  return (
    <div className="mt-5 space-y-4">
      <div className="inner flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          <div className="label">Subject</div>
          <a className="link mono mt-1 block truncate text-sm" href={buildAddressExplorerUrl(PRODUCTION_CHAIN_ID, report.subject.token)} target="_blank" rel="noreferrer">
            {report.subject.token}
          </a>
          <div className="mt-1 text-xs tabular-nums" style={{ color: 'var(--subtle)' }}>
            Trade size {report.subject.tradeSizeUsd} USD. Read at block {report.chainState.blockNumber}.
          </div>
        </div>
        <a className="btn btn-ghost" href={buildTxExplorerUrl(PRODUCTION_CHAIN_ID, data.settleTxHash)} target="_blank" rel="noreferrer">
          <FileCheck2 className="size-4" aria-hidden />
          Settlement tx
          <ExternalLink className="size-3.5" aria-hidden />
        </a>
      </div>

      {report.sections.map((section) => (
        <section key={section.id} className="inner p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="display text-lg font-semibold">{SECTION_TITLES[section.id]}</h3>
            <span className="text-xs font-semibold" style={{ color: section.status === 'unavailable' ? 'var(--warn)' : 'var(--success)' }}>
              {STATUS_COPY[section.status]}
            </span>
          </div>

          {section.findings.length > 0 && (
            <ul className="mt-3 space-y-2.5">
              {section.findings.map((finding) => (
                <li key={finding.id} className="text-sm text-pretty">
                  <span className={`label sev-${finding.severity} mr-2`}>{finding.severity}</span>
                  {finding.text}
                  <span className="mono ml-1.5 text-xs" style={{ color: 'var(--subtle)' }}>[{finding.evidenceRefs.join(', ')}]</span>
                </li>
              ))}
            </ul>
          )}

          {section.evidence.length > 0 && (
            <details className="mt-3 text-xs" style={{ color: 'var(--muted)' }}>
              <summary className="cursor-pointer font-semibold">Evidence ({section.evidence.length})</summary>
              <ul className="mt-2 space-y-1.5">
                {section.evidence.map((item) => (
                  <li key={item.id} className="mono break-all">
                    {item.id}: {item.type} {item.ref} = {item.value} (observed {item.observedAt})
                  </li>
                ))}
              </ul>
            </details>
          )}

          <ul className="mt-3 space-y-1 text-xs text-pretty" style={{ color: 'var(--subtle)' }}>
            {section.limitations.map((limit) => (
              <li key={limit}>Limit: {limit}</li>
            ))}
          </ul>
        </section>
      ))}

      <section className="inner p-4">
        <h3 className="display text-lg font-semibold">Not established by this report</h3>
        <ul className="mt-2 space-y-1 text-sm text-pretty" style={{ color: 'var(--muted)' }}>
          {report.notEstablished.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <p className="mono break-all text-xs" style={{ color: 'var(--subtle)' }}>Report hash {data.reportHash}</p>
    </div>
  )
}
