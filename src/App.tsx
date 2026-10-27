import { useCallback, useState } from 'react'
import { ConfigNotice, useReadiness } from './components/ConfigNotice'
import { Header } from './components/Header'
import { History } from './components/History'
import { RequestForm } from './components/RequestForm'
import { RequestPanel } from './components/RequestPanel'
import { usePayFlow } from './hooks/usePayFlow'
import { loadHistory, removeEntry, type HistoryEntry } from './lib/history'

export default function App() {
  const readiness = useReadiness()
  const [entries, setEntries] = useState<HistoryEntry[]>(() => loadHistory())
  const [selectedId, setSelectedId] = useState<string | null>(() => loadHistory()[0]?.created.requestId ?? null)

  const onEntry = useCallback(() => setEntries(loadHistory()), [])
  const { state, start, resume } = usePayFlow(onEntry)

  const selected = entries.find((e) => e.created.requestId === selectedId) ?? null

  return (
    <div className="min-h-dvh pb-16">
      <Header />
      <main className="mx-auto grid w-full max-w-5xl gap-4 px-4 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <div className="space-y-4">
          <ConfigNotice readiness={readiness} />
          <RequestForm
            ready={readiness.ready}
            flow={state}
            onSubmit={(input) => void start(input, (entry) => setSelectedId(entry.created.requestId))}
          />
          <History
            entries={entries}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onRemove={(id) => {
              setEntries(removeEntry(id))
              if (id === selectedId) setSelectedId(null)
            }}
          />
        </div>
        <div>
          {selected ? (
            <RequestPanel entry={selected} flow={state} onResume={(entry) => void resume(entry)} />
          ) : (
            <section className="card p-6">
              <div className="label">How it works</div>
              <ol className="mt-3 space-y-3 text-sm text-pretty" style={{ color: 'var(--muted)' }}>
                <li>1. Enter a token on Arc and the size of the trade you are considering.</li>
                <li>2. Pay 0.10 USDC to the PayPerCall contract. The server reads the contract itself to confirm it.</li>
                <li>3. The report is built, the contract records its hash, and only then is it revealed.</li>
                <li>4. If it is not delivered, you can refund your 0.10 USDC after 30 minutes.</li>
              </ol>
            </section>
          )}
        </div>
      </main>
    </div>
  )
}
