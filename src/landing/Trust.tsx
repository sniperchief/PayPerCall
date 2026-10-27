import { ArrowRight, ArrowUpRight, Banknote, Clock, Lock, PauseCircle, Undo2 } from 'lucide-react'
import { useReadiness } from '../components/ConfigNotice'
import { describeStage, type Tone } from '../lib/stages'
import { APP_HREF, LINKS } from '../lib/route'
import { Reveal } from './Reveal'
import { PreviewTag, StepMark, sampleView } from './samples'

const RULES = [
  {
    icon: Banknote,
    title: 'A fixed price',
    body: 'PRICE is a constant in the contract: exactly 0.10 USDC per request. A payment that does not arrive as exactly that amount is rejected.',
  },
  {
    icon: Lock,
    title: 'Escrow until settled or refunded',
    body: 'The payment sits in the contract. Settlement can move it only to the treasury fixed at deployment. The owner cannot move escrow or change the treasury.',
  },
  {
    icon: Clock,
    title: 'A settlement deadline',
    body: 'The operator can settle only before the 30 minute deadline, and only with a non-empty report hash.',
  },
  {
    icon: Undo2,
    title: 'A refund path for the payer',
    body: 'After the deadline, only the paying wallet can refund an unsettled request, to a recipient it chooses.',
  },
  {
    icon: PauseCircle,
    title: 'Pausing stops new requests only',
    body: 'A pause blocks createRequest. It cannot block settlement or refunds of requests that are already paid.',
  },
] as const

const STATES = [
  describeStage(sampleView('SETTLING', 'paid')),
  describeStage(sampleView('COMPLETED', 'settled', { reportAvailable: true })),
  describeStage(sampleView('FAILED', 'paid', { failure: 'DEADLINE_MARGIN' })),
  describeStage(sampleView('REFUNDED', 'refunded')),
]

const TONE: Record<Tone, { color: string; background: string; label: string }> = {
  progress: { color: 'var(--accent)', background: 'var(--accent-soft)', label: 'In progress' },
  success: { color: 'var(--success)', background: 'var(--success-soft)', label: 'Delivered' },
  danger: { color: 'var(--danger)', background: 'var(--danger-soft)', label: 'Not delivered' },
  neutral: { color: 'var(--ink-2)', background: 'var(--surface-muted)', label: 'Closed' },
}

export function Trust() {
  return (
    <section id="trust" className="bg-white py-20 sm:py-24" aria-labelledby="trust-title">
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8">
        <Reveal className="max-w-3xl">
          <div className="eyebrow">Payment safety and transparency</div>
          <h2 id="trust-title" className="display mt-2 text-3xl font-semibold leading-tight text-balance sm:text-4xl" style={{ color: 'var(--navy)' }}>
            Clear rules for your 0.10 USDC, written into the contract.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-pretty" style={{ color: 'var(--muted)' }}>
            The payment, settlement and refund rules live in the PayPerCall contract on Arc, not in the server. Every payment, settlement and
            refund is a transaction you can open in the Arc explorer, and the app links each one.
          </p>
        </Reveal>

        <div className="mt-12 grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:gap-14">
          <Reveal className="min-w-0">
            <ul className="divide-y rounded-xl border" style={{ borderColor: 'var(--border)' }}>
              {RULES.map(({ icon: Icon, title, body }) => (
                <li key={title} className="flex gap-4 p-5" style={{ borderColor: 'var(--border)' }}>
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                    <Icon className="size-[1.125rem]" aria-hidden />
                  </span>
                  <div className="min-w-0">
                    <h3 className="text-[0.9375rem] font-semibold" style={{ color: 'var(--ink)' }}>{title}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-pretty" style={{ color: 'var(--muted)' }}>{body}</p>
                  </div>
                </li>
              ))}
            </ul>

            <div className="mt-5 rounded-xl p-5" style={{ background: 'var(--surface-muted)' }}>
              <h3 className="text-[0.9375rem] font-semibold" style={{ color: 'var(--ink)' }}>What the contract does not do</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-pretty" style={{ color: 'var(--muted)' }}>
                It does not judge report quality. Settlement is the operator's onchain record of the report hash, and the API re-checks the stored
                report against that hash before releasing it. The contract is tested with Foundry unit, invariant and fork tests. It has not had
                an external audit.
              </p>
              <a href={LINKS.security} target="_blank" rel="noreferrer" className="link mt-3 inline-flex items-center gap-1 text-sm font-medium">
                Read the security notes
                <ArrowUpRight className="size-3.5" aria-hidden />
              </a>
            </div>
          </Reveal>

          <Reveal delay={100} className="min-w-0 space-y-5">
            <figure className="card card-raised overflow-hidden" aria-label="Payment states">
              <div className="flex items-center justify-between gap-3 border-b px-5 py-3.5" style={{ borderColor: 'var(--border)' }}>
                <figcaption className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>What you see in the app</figcaption>
                <PreviewTag>Example states</PreviewTag>
              </div>
              <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
                {STATES.map((stage) => {
                  const tone = TONE[stage.tone]
                  return (
                    <li key={stage.headline} className="px-5 py-4" style={{ borderColor: 'var(--border)' }}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-[0.9375rem] font-semibold" style={{ color: 'var(--ink)' }}>{stage.headline}</span>
                        <span className="rounded-md px-2 py-0.5 text-[0.6875rem] font-semibold" style={{ color: tone.color, background: tone.background }}>{tone.label}</span>
                      </div>
                      <div className="mt-2.5 flex items-center gap-1.5" aria-label={stage.steps.map((step) => `${step.label}: ${step.state}`).join(', ')}>
                        {stage.steps.map((step) => <StepMark key={step.key} state={step.state} />)}
                      </div>
                    </li>
                  )
                })}
              </ul>
              <dl className="grid grid-cols-1 gap-px border-t sm:grid-cols-3" style={{ borderColor: 'var(--border)', background: 'var(--border)' }}>
                <Cost label="You pay" value="0.10 USDC + network fees" />
                <Cost label="On settlement" value="Paid to treasury" />
                <Cost label="On refund" value="0.10 USDC returned" />
              </dl>
            </figure>

            <ServiceStatus />
          </Reveal>
        </div>

        <Reveal className="mt-20">
          <div className="grid grid-cols-1 gap-8 rounded-2xl bg-navy px-6 py-10 sm:px-10 sm:py-12 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
            <div>
              <h2 className="display text-2xl font-semibold leading-tight text-balance text-white sm:text-3xl">Check your next token before you trade it.</h2>
              <p className="mt-3 max-w-xl text-base leading-relaxed text-pretty text-[#c9d5ea]">
                Connect a wallet on Arc mainnet, enter the token and trade size, and pay 0.10 USDC. If the report is not delivered, the refund is yours to claim.
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <a href={APP_HREF} className="btn btn-primary btn-lg">
                Get started
                <ArrowRight className="size-4" aria-hidden />
              </a>
              <a href={LINKS.apiDocs} target="_blank" rel="noreferrer" className="btn btn-lg btn-on-dark">Read the docs</a>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  )
}

function Cost({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white px-5 py-3">
      <dt className="text-xs" style={{ color: 'var(--subtle)' }}>{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold" style={{ color: 'var(--ink)' }}>{value}</dd>
    </div>
  )
}

/** Real readiness from the app's own checks and GET /api/v1/health. */
function ServiceStatus() {
  const readiness = useReadiness()
  const state = readiness.loading
    ? { title: 'Checking service status...', color: 'var(--subtle)', background: 'var(--surface-muted)' }
    : readiness.ready
      ? { title: 'Accepting requests', color: 'var(--success)', background: 'var(--success-soft)' }
      : { title: 'Payments are disabled', color: 'var(--warn)', background: 'var(--warn-soft)' }

  return (
    <div className="card p-5" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="label">Service status</div>
        <span className="mono text-[0.6875rem]" style={{ color: 'var(--subtle)' }}>live · GET /api/v1/health</span>
      </div>
      <div className="mt-2.5 flex items-center gap-2.5">
        <span className="size-2.5 rounded-full" style={{ background: state.color, boxShadow: `0 0 0 4px ${state.background}` }} aria-hidden />
        <span className="text-[0.9375rem] font-semibold" style={{ color: 'var(--ink)' }}>{state.title}</span>
      </div>
      {!readiness.loading && !readiness.ready && (
        <>
          <p className="mt-2 text-sm leading-relaxed text-pretty" style={{ color: 'var(--muted)' }}>
            PayPerCall fails closed. It takes no payment until the contract and API are configured for Arc mainnet.
          </p>
          <ul className="mt-2 space-y-1 text-xs" style={{ color: 'var(--subtle)' }}>
            {readiness.reasons.map((reason) => <li key={reason} className="break-words">{reason}</li>)}
          </ul>
        </>
      )}
    </div>
  )
}
