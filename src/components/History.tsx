import { History as HistoryIcon, Trash2 } from 'lucide-react'
import type { HistoryEntry } from '../lib/history'

interface Props {
  entries: HistoryEntry[]
  selectedId: string | null
  onSelect: (id: string) => void
  onRemove: (id: string) => void
}

export function History({ entries, selectedId, onSelect, onRemove }: Props) {
  if (entries.length === 0) return null
  return (
    <section className="card p-5">
      <div className="flex items-center gap-2">
        <HistoryIcon className="size-4" style={{ color: 'var(--subtle)' }} aria-hidden />
        <h2 className="label">Your requests</h2>
      </div>
      <ul className="mt-3 space-y-2">
        {entries.map((entry) => {
          const id = entry.created.requestId
          const selected = id === selectedId
          return (
            <li key={id} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onSelect(id)}
                className="inner min-h-11 flex-1 truncate px-3 text-left text-sm"
                style={selected ? { borderColor: 'var(--accent)' } : undefined}
                aria-current={selected}
              >
                <span className="mono">{entry.token.slice(0, 8)}...{entry.token.slice(-4)}</span>
                <span className="ml-2 tabular-nums" style={{ color: 'var(--subtle)' }}>{entry.tradeSizeUsd} USD</span>
              </button>
              <button type="button" className="btn btn-ghost px-3" onClick={() => onRemove(id)} aria-label="Remove from this device">
                <Trash2 className="size-4" aria-hidden />
              </button>
            </li>
          )
        })}
      </ul>
      <p className="mt-3 text-xs text-pretty" style={{ color: 'var(--subtle)' }}>
        Access tokens are kept in this browser only. Removing a request here does not cancel or refund anything.
      </p>
    </section>
  )
}
