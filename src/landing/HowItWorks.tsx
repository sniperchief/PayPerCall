import type { ReactNode } from 'react'
import { CornerDownRight, Info, ListChecks } from 'lucide-react'
import type { RequestStatus } from '../../shared/protocol'
import { Reveal } from './Reveal'

const STEPS = [
  {
    title: 'Create the request',
    body: 'Enter a token address on Arc and the trade size you are considering. The API binds them to your wallet and returns a unique request ID, a nonce and a parameters hash.',
    detail: 'POST /api/v1/requests',
  },
  {
    title: 'Pay 0.10 USDC into escrow',
    body: 'Your wallet approves 0.10 USDC (only if the allowance is not already in place) and calls createRequest on the PayPerCall contract, which holds the payment.',
    detail: 'approve  →  createRequest(nonce, paramsHash)',
  },
  {
    title: 'Payment verified from the contract',
    body: 'Before any work starts, the server reads the request from the contract: paid, same payer, same parameters, correct refund window. A transaction hash from the browser is never taken as proof.',
    detail: 'requests(requestId)',
  },
  {
    title: 'Settled onchain, then unlocked',
    body: 'The report is hashed and the operator records that hash with settle. The report is released only when the contract shows the request settled and the stored report still matches the recorded hash.',
    detail: 'settle(requestId, reportHash)',
  },
] as const

const LIFECYCLE: { status: RequestStatus; text: string }[] = [
  { status: 'CREATED', text: 'Request stored, waiting for the onchain payment' },
  { status: 'PAYMENT_VERIFIED', text: 'Contract shows the 0.10 USDC as paid' },
  { status: 'PROCESSING', text: 'Report is being built from Arc mainnet data' },
  { status: 'REPORT_READY', text: 'Report stored and hashed' },
  { status: 'SETTLING', text: 'Settlement sent with the report hash' },
  { status: 'COMPLETED', text: 'Settlement confirmed, report released' },
]

const EXITS: { status: RequestStatus; text: string }[] = [
  { status: 'FAILED', text: 'Not delivered. Payment stays in escrow and is refundable after the deadline.' },
  { status: 'EXPIRED', text: 'No payment arrived within 30 minutes. Nothing was charged.' },
  { status: 'REFUNDED', text: 'The contract returned the 0.10 USDC to the payer.' },
]

const PREREQUISITES = [
  'A browser wallet such as MetaMask, connected to Arc mainnet',
  '0.10 USDC per request, plus network fees for the approval and payment transactions',
  'The address of a token deployed on Arc',
  'An intended trade size between 1 and 10,000,000 USD',
]

const LIMITS = [
  'The token section is built from direct Arc RPC reads. Wallet activity and liquidity analysis are not available yet and are marked as unavailable in each report.',
  'Every report lists what it could not establish and the limits of its data.',
  'Requests unpaid after 30 minutes expire. A paid request that is not settled within 30 minutes can only end in a refund.',
]

export function HowItWorks() {
  return (
    <section id="how-it-works" className="bg-mist py-20 sm:py-24" aria-labelledby="how-title">
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8">
        <Reveal className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-end lg:gap-16">
          <div>
            <div className="eyebrow">How it works</div>
            <h2 id="how-title" className="display mt-2 text-3xl font-semibold leading-tight text-balance sm:text-4xl" style={{ color: 'var(--navy)' }}>
              One request, one payment, one report you can match to the chain.
            </h2>
          </div>
          <p className="text-base leading-relaxed text-pretty" style={{ color: 'var(--muted)' }}>
            Every report is tied to a single paid request. The payment, the settlement and any refund are transactions on Arc mainnet that
            you can open in the explorer, and the server only acts on what the contract itself reports.
          </p>
        </Reveal>

        <div className="mt-14 grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
          <Reveal>
            <ol className="relative">
              {STEPS.map((step, index) => (
                <li key={step.title} className="relative flex gap-5 pb-9 last:pb-0">
                  {index < STEPS.length - 1 && (
                    <span className="absolute left-[1.0625rem] top-10 h-[calc(100%-2.75rem)] w-px" style={{ background: 'var(--border-strong)' }} aria-hidden />
                  )}
                  <span
                    className="relative flex size-[2.125rem] shrink-0 items-center justify-center rounded-full border bg-white text-sm font-semibold tabular-nums"
                    style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}
                    aria-hidden
                  >
                    {index + 1}
                  </span>
                  <div className="min-w-0 pt-1">
                    <h3 className="text-[1.0625rem] font-semibold" style={{ color: 'var(--ink)' }}>
                      <span className="sr-only">Step {index + 1}: </span>
                      {step.title}
                    </h3>
                    <p className="mt-1.5 text-[0.9375rem] leading-relaxed text-pretty" style={{ color: 'var(--muted)' }}>{step.body}</p>
                    <code className="mono mt-2.5 inline-block max-w-full truncate rounded-md border bg-white px-2 py-1 text-xs" style={{ borderColor: 'var(--border)', color: 'var(--ink-2)' }}>
                      {step.detail}
                    </code>
                  </div>
                </li>
              ))}
            </ol>
          </Reveal>

          <Reveal delay={100}>
            <figure className="card card-raised overflow-hidden" aria-label="Request lifecycle">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-3.5" style={{ borderColor: 'var(--border)' }}>
                <figcaption className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Request lifecycle</figcaption>
                <span className="mono text-[0.6875rem]" style={{ color: 'var(--subtle)' }}>GET /api/v1/requests/:id → status</span>
              </div>
              <ol className="px-5 py-4">
                {LIFECYCLE.map((item, index) => (
                  <li key={item.status} className="flex gap-3.5">
                    <div className="flex flex-col items-center" aria-hidden>
                      <span
                        className="mt-1.5 size-2.5 shrink-0 rounded-full"
                        style={{ background: index === LIFECYCLE.length - 1 ? 'var(--success)' : 'var(--accent)' }}
                      />
                      {index < LIFECYCLE.length - 1 && <span className="w-px flex-1" style={{ background: 'var(--border-strong)' }} />}
                    </div>
                    <div className="min-w-0 pb-3.5">
                      <div className="mono text-xs font-medium" style={{ color: 'var(--ink)' }}>{item.status}</div>
                      <div className="mt-0.5 text-sm" style={{ color: 'var(--muted)' }}>{item.text}</div>
                    </div>
                  </li>
                ))}
              </ol>
              <div className="border-t px-5 py-4" style={{ borderColor: 'var(--border)', background: 'var(--surface-strong)' }}>
                <div className="label">Other outcomes</div>
                <ul className="mt-2.5 space-y-2.5">
                  {EXITS.map((item) => (
                    <li key={item.status} className="flex gap-2.5 text-sm">
                      <CornerDownRight className="mt-0.5 size-4 shrink-0" style={{ color: 'var(--subtle)' }} aria-hidden />
                      <span>
                        <span className="mono text-xs font-medium" style={{ color: 'var(--ink)' }}>{item.status}</span>
                        <span style={{ color: 'var(--muted)' }}> · {item.text}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </figure>
          </Reveal>
        </div>

        <Reveal className="mt-12 grid gap-5 md:grid-cols-2">
          <InfoList icon={<ListChecks className="size-4" aria-hidden />} title="Before you start" items={PREREQUISITES} />
          <InfoList icon={<Info className="size-4" aria-hidden />} title="Current scope and limits" items={LIMITS} />
        </Reveal>
      </div>
    </section>
  )
}

function InfoList({ icon, title, items }: { icon: ReactNode; title: string; items: string[] }) {
  return (
    <div className="card p-6">
      <div className="flex items-center gap-2" style={{ color: 'var(--accent)' }}>
        {icon}
        <h3 className="text-[0.9375rem] font-semibold" style={{ color: 'var(--ink)' }}>{title}</h3>
      </div>
      <ul className="mt-4 space-y-2.5">
        {items.map((item) => (
          <li key={item} className="flex gap-2.5 text-sm leading-relaxed text-pretty" style={{ color: 'var(--muted)' }}>
            <span className="mt-2 size-1 shrink-0 rounded-full" style={{ background: 'var(--subtle)' }} aria-hidden />
            {item}
          </li>
        ))}
      </ul>
    </div>
  )
}
