import { useState } from 'react'
import { ConnectKitButton } from 'connectkit'
import { ArrowRight, Menu, Wallet, X } from 'lucide-react'
import { useAccount } from 'wagmi'
import { PRODUCTION_CHAIN_ID } from '../../shared/protocol'
import { requireChain } from '../onchain-facts'
import { APP_HREF, LINKS, type View } from '../lib/route'
import { Logo } from './Logo'

const NAV = [
  { href: '#how-it-works', label: 'How it works' },
  { href: '#developers', label: 'Developers' },
  { href: '#trust', label: 'Payment safety' },
] as const

export function Header({ view }: { view: View }) {
  const { isConnected, chainId } = useAccount()
  const chain = requireChain(PRODUCTION_CHAIN_ID)
  const wrongChain = isConnected && chainId !== PRODUCTION_CHAIN_ID
  const [open, setOpen] = useState(false)
  const close = () => setOpen(false)

  return (
    <header className="sticky top-0 z-40 border-b bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/85" style={{ borderColor: 'var(--border)' }}>
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
        <a href="#" onClick={close} className="nav-link flex items-center gap-2.5" aria-label="PayPerCall home">
          <Logo />
          <span className="display text-[1.0625rem] font-semibold" style={{ color: 'var(--ink)' }}>PayPerCall</span>
        </a>

        <nav className="hidden items-center gap-7 md:flex" aria-label="Primary">
          {NAV.map((item) => (
            <a key={item.href} href={item.href} className="nav-link">{item.label}</a>
          ))}
          <a href={LINKS.apiDocs} target="_blank" rel="noreferrer" className="nav-link">Docs</a>
        </nav>

        <div className="flex items-center gap-2">
          {view === 'app' ? (
            <>
              <span
                className="hidden rounded-md px-2.5 py-1.5 text-xs font-semibold sm:inline"
                style={{
                  background: wrongChain ? 'var(--danger-soft)' : 'var(--surface-muted)',
                  border: '1px solid var(--border)',
                  color: wrongChain ? 'var(--danger)' : 'var(--ink-2)',
                }}
              >
                {wrongChain ? `Wrong network, use ${chain.name}` : `${chain.name} mainnet`}
              </span>
              <ConnectKitButton.Custom>
                {({ isConnected: connected, isConnecting, show, truncatedAddress }) => (
                  <button type="button" onClick={show} className="btn btn-ghost">
                    <Wallet className="size-4" aria-hidden />
                    {connected ? <span className="mono tabular-nums">{truncatedAddress}</span> : isConnecting ? 'Connecting...' : 'Connect wallet'}
                  </button>
                )}
              </ConnectKitButton.Custom>
            </>
          ) : (
            <a href={APP_HREF} className="btn btn-primary hidden sm:inline-flex">
              Open app
              <ArrowRight className="size-4" aria-hidden />
            </a>
          )}
          <button
            type="button"
            className="btn btn-ghost px-3 md:hidden"
            aria-expanded={open}
            aria-controls="mobile-nav"
            aria-label={open ? 'Close menu' : 'Open menu'}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? <X className="size-4" aria-hidden /> : <Menu className="size-4" aria-hidden />}
          </button>
        </div>
      </div>

      {open && (
        <nav id="mobile-nav" className="border-t bg-white px-4 pb-4 pt-2 md:hidden" style={{ borderColor: 'var(--border)' }} aria-label="Mobile">
          <ul className="space-y-1">
            {NAV.map((item) => (
              <li key={item.href}>
                <a href={item.href} onClick={close} className="nav-link block px-1 py-2.5 text-[0.9375rem]">{item.label}</a>
              </li>
            ))}
            <li>
              <a href={LINKS.apiDocs} target="_blank" rel="noreferrer" onClick={close} className="nav-link block px-1 py-2.5 text-[0.9375rem]">Docs</a>
            </li>
          </ul>
          {view === 'landing' && (
            <a href={APP_HREF} onClick={close} className="btn btn-primary mt-3 w-full">
              Open app
              <ArrowRight className="size-4" aria-hidden />
            </a>
          )}
        </nav>
      )}
    </header>
  )
}
