import { ConnectKitButton } from 'connectkit'
import { Radar, Wallet } from 'lucide-react'
import { useAccount } from 'wagmi'
import { PRODUCTION_CHAIN_ID } from '../../shared/protocol'
import { requireChain } from '../onchain-facts'

export function Header() {
  const { isConnected, chainId } = useAccount()
  const chain = requireChain(PRODUCTION_CHAIN_ID)
  const wrongChain = isConnected && chainId !== PRODUCTION_CHAIN_ID

  return (
    <header className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-4 py-5">
      <div className="flex items-center gap-2.5">
        <div className="flex size-9 items-center justify-center rounded-xl" style={{ background: 'var(--surface-strong)' }}>
          <Radar className="size-5" style={{ color: 'var(--accent)' }} aria-hidden />
        </div>
        <div>
          <div className="display text-lg font-semibold leading-none">PayPerCall</div>
          <div className="mt-1 text-xs" style={{ color: 'var(--subtle)' }}>Pay-per-request token risk reports</div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span
          className="hidden rounded-full px-3 py-1.5 text-xs font-semibold sm:inline"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: wrongChain ? 'var(--danger)' : 'var(--ink-2)' }}
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
      </div>
    </header>
  )
}
