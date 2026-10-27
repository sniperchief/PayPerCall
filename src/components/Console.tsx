import { useCallback, useState } from 'react'
import { ConfigNotice, useReadiness } from './ConfigNotice'
import { History } from './History'
import { RequestForm } from './RequestForm'
import { RequestPanel } from './RequestPanel'
import { usePayFlow } from '../hooks/usePayFlow'
import { loadHistory, removeEntry, type HistoryEntry } from '../lib/history'

/** The working application: request form, payment flow, status, refunds and reports. */
export function Console() {
  const readiness = useReadiness()
  const [entries, setEntries] = useState<HistoryEntry[]>(() => loadHistory())
  const [selectedId, setSelectedId] = useState<string | null>(() => loadHistory()[0]?.created.requestId ?? null)

  const onEntry = useCallback(() => setEntries(loadHistory()), [])
  const { state, start, resume } = usePayFlow(onEntry)

  const selected = entries.find((e) => e.created.requestId === selectedId) ?? null

  return (
    <div className="min-h-[calc(100dvh-4rem)] bg-mist pb-20">
      <div className="mx-auto w-full max-w-6xl px-4 pb-6 pt-8 sm:px-6 lg:px-8">
        <div className="eyebrow">Token risk report</div>
        <h1 className="display mt-1 text-2xl font-semibold sm:text-3xl">New request</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-pretty" style={{ color: 'var(--muted)' }}>
          Connect a wallet on Arc mainnet, enter the token and trade size, and pay 0.10 USDC. Your report appears here once settlement is confirmed onchain.
        </p>
      </div>
      <main className="mx-auto grid grid-cols-1 w-full max-w-6xl gap-5 px-4 sm:px-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:px-8">
        <div className="min-w-0 space-y-5">
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
        <div className="min-w-0">
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
