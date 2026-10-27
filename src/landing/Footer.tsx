import { PRODUCTION_CHAIN_ID, productionFacts } from '../../shared/protocol'
import { Logo } from '../components/Logo'
import { APP_HREF, LINKS } from '../lib/route'

const facts = productionFacts()

const COLUMNS = [
  {
    title: 'Product',
    links: [
      { label: 'Open app', href: APP_HREF },
      { label: 'How it works', href: '#how-it-works' },
      { label: 'Developers', href: '#developers' },
      { label: 'Payment safety', href: '#trust' },
    ],
  },
  {
    title: 'Resources',
    links: [
      { label: 'API documentation', href: LINKS.apiDocs, external: true },
      { label: 'Contract integration', href: LINKS.integration, external: true },
      { label: 'Contract source', href: LINKS.contract, external: true },
      { label: 'Security notes', href: LINKS.security, external: true },
      { label: 'GitHub repository', href: LINKS.repo, external: true },
    ],
  },
  {
    title: 'Arc network',
    links: [
      { label: 'Arc explorer', href: facts.explorerBase, external: true },
      { label: 'Arc documentation', href: LINKS.arcDocs, external: true },
      { label: 'Arc Studio', href: LINKS.arcStudio, external: true },
    ],
  },
] as const

export function Footer() {
  return (
    <footer className="border-t bg-mist" style={{ borderColor: 'var(--border)' }}>
      <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-14 sm:px-6 md:grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))] lg:px-8">
        <div className="max-w-xs">
          <div className="flex items-center gap-2.5">
            <Logo />
            <span className="display text-[1.0625rem] font-semibold" style={{ color: 'var(--ink)' }}>PayPerCall</span>
          </div>
          <p className="mt-3 text-sm leading-relaxed" style={{ color: 'var(--muted)' }}>
            Pay-per-request token risk reports, paid in USDC and settled on Arc.
          </p>
        </div>
        {COLUMNS.map((column) => (
          <nav key={column.title} aria-label={column.title}>
            <h2 className="text-xs font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--subtle)' }}>{column.title}</h2>
            <ul className="mt-3 space-y-2">
              {column.links.map((link) => (
                <li key={link.label}>
                  <a
                    href={link.href}
                    className="nav-link"
                    {...('external' in link ? { target: '_blank', rel: 'noreferrer' } : {})}
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className="border-t" style={{ borderColor: 'var(--border)' }}>
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-1 px-4 py-5 text-xs sm:flex-row sm:justify-between sm:px-6 lg:px-8" style={{ color: 'var(--subtle)' }}>
          <span>Arc mainnet, chain {PRODUCTION_CHAIN_ID.toString()}</span>
          <span className="mono break-all">USDC {facts.usdc}</span>
        </div>
      </div>
    </footer>
  )
}
