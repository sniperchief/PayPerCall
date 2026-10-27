import type { ReactNode } from 'react'
import { ArrowRight, Lock } from 'lucide-react'
import { PRICE_RAW, PRODUCTION_CHAIN_ID, REFUND_DELAY_SECONDS } from '../../shared/protocol'
import { describeStage } from '../lib/stages'
import { APP_HREF } from '../lib/route'
import { USDC_DECIMALS } from '../onchain-facts'
import { formatUnitsFixed } from '../onchain-money'
import { Reveal } from './Reveal'
import { PreviewTag, SAMPLE, StepMark, sampleView, shorten } from './samples'

const price = formatUnitsFixed(PRICE_RAW, USDC_DECIMALS, 2)
const refundMinutes = (REFUND_DELAY_SECONDS / 60).toString()

const FACTS = [
  { value: `${price} USDC`, label: 'per report request' },
  { value: `${refundMinutes} min`, label: 'refund window if undelivered' },
  { value: 'Arc mainnet', label: `USDC, chain ${PRODUCTION_CHAIN_ID.toString()}` },
] as const

export function HeroMain() {
  return (
    <section className="relative overflow-hidden border-b bg-white" style={{ borderColor: 'var(--border)' }} aria-labelledby="hero-title">
      <div className="mx-auto grid grid-cols-1 w-full max-w-6xl items-center gap-12 px-4 pb-16 pt-12 sm:px-6 sm:pt-16 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:gap-16 lg:px-8 lg:pb-24 lg:pt-24">
        <Reveal>
          <div className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold" style={{ borderColor: 'var(--border)', color: 'var(--ink-2)', background: 'var(--surface-strong)' }}>
            <span className="size-1.5 rounded-full" style={{ background: 'var(--accent)' }} aria-hidden />
            Pay-per-request token risk reports on Arc
          </div>
          <h1 id="hero-title" className="display mt-5 text-[2.125rem] font-semibold leading-[1.1] text-balance sm:text-5xl lg:text-[3.25rem]" style={{ color: 'var(--navy)' }}>
            Check a token before you trade it. Pay {price} USDC per report.
          </h1>
          <p className="mt-5 max-w-xl text-base leading-relaxed text-pretty sm:text-lg" style={{ color: 'var(--muted)' }}>
            PayPerCall gives traders and trading agents a risk report on an Arc token for a single USDC payment. The payment is held by a
            contract, the report is released only after its settlement is recorded onchain, and an undelivered request can be refunded.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <a href={APP_HREF} className="btn btn-primary btn-lg">
              Get started
              <ArrowRight className="size-4" aria-hidden />
            </a>
            <a href="#how-it-works" className="btn btn-ghost btn-lg">How it works</a>
          </div>
          <dl className="mt-10 grid max-w-xl grid-cols-1 gap-4 border-t pt-6 sm:grid-cols-3" style={{ borderColor: 'var(--border)' }}>
            {FACTS.map((fact) => (
              <div key={fact.label}>
                <dt className="sr-only">{fact.label}</dt>
                <dd>
                  <div className="text-lg font-semibold tabular-nums" style={{ color: 'var(--ink)' }}>{fact.value}</div>
                  <div className="mt-0.5 text-sm" style={{ color: 'var(--subtle)' }}>{fact.label}</div>
                </dd>
              </div>
            ))}
          </dl>
        </Reveal>

        <Reveal delay={120}>
          <ProductPreview />
        </Reveal>
      </div>
    </section>
  )
}

/** Static rendition of the app's request form and status panel. Status copy comes from the app's describeStage. */
function ProductPreview() {
  const stage = describeStage(sampleView('SETTLING', 'paid'))
  return (
    <div className="relative">
      <div className="absolute -inset-x-3 -bottom-3 top-6 hidden rounded-xl bg-mist sm:block" aria-hidden />
      <figure className="card card-raised relative overflow-hidden" aria-label="PayPerCall request preview">
        <div className="flex items-center justify-between gap-3 border-b px-5 py-3.5" style={{ borderColor: 'var(--border)' }}>
          <div className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>New report</div>
          <PreviewTag />
        </div>

        <div className="space-y-4 p-5">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
            <PreviewField label="Token address on Arc">
              <span className="mono block truncate text-sm">{shorten(SAMPLE.token, 10, 6)}</span>
            </PreviewField>
            <PreviewField label="Intended trade size">
              <span className="text-sm font-semibold tabular-nums">{SAMPLE.tradeSizeUsd} USD</span>
            </PreviewField>
          </div>

          <dl className="inner divide-y text-sm" style={{ borderColor: 'var(--border)' }}>
            <PreviewRow label="Price" value={`${price} USDC`} strong />
            <PreviewRow label="Network" value="Arc mainnet" />
            <PreviewRow label="If no report is settled" value={`Refund after ${refundMinutes} minutes`} />
          </dl>

          <div className="rounded-lg border p-4" style={{ borderColor: 'var(--border)' }}>
            <div className="flex items-center justify-between gap-3">
              <div className="label">Request status</div>
              <span className="mono text-[0.6875rem]" style={{ color: 'var(--subtle)' }}>{shorten(SAMPLE.requestId)}</span>
            </div>
            <div className="mt-1.5 text-base font-semibold" style={{ color: 'var(--accent)' }}>{stage.headline}</div>
            <p className="mt-1 text-[0.8125rem] leading-relaxed" style={{ color: 'var(--muted)' }}>{stage.detail}</p>
            <ol className="mt-3.5 grid gap-2 sm:grid-cols-2">
              {stage.steps.map((step) => (
                <li key={step.key} className="flex items-center gap-2 text-[0.8125rem]" style={{ color: step.state === 'pending' ? 'var(--subtle)' : 'var(--ink-2)' }}>
                  <StepMark state={step.state} />
                  {step.label}
                </li>
              ))}
            </ol>
          </div>
        </div>

        <figcaption className="flex items-center gap-2 border-t px-5 py-3 text-xs" style={{ borderColor: 'var(--border)', color: 'var(--subtle)', background: 'var(--surface-strong)' }}>
          <Lock className="size-3.5" aria-hidden />
          The report stays locked until the contract shows the request settled.
        </figcaption>
      </figure>
    </div>
  )
}

function PreviewField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="label">{label}</div>
      <div className="mt-1.5 rounded-lg border px-3 py-2.5" style={{ borderColor: 'var(--border-strong)', color: 'var(--ink)' }}>{children}</div>
    </div>
  )
}

function PreviewRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3.5 py-2.5" style={{ borderColor: 'var(--border)' }}>
      <dt style={{ color: 'var(--subtle)' }}>{label}</dt>
      <dd className={`text-right tabular-nums ${strong ? 'font-semibold' : ''}`} style={{ color: 'var(--ink)' }}>{value}</dd>
    </div>
  )
}
