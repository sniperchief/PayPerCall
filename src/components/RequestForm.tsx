import { useState } from 'react'
import { ConnectKitButton } from 'connectkit'
import { Loader2, ScanSearch } from 'lucide-react'
import { erc20Abi } from 'viem'
import { useAccount, useReadContract, useSwitchChain } from 'wagmi'
import { PRICE_RAW, PRODUCTION_CHAIN_ID, parseAddress, parseTradeSizeUsd, productionFacts, REFUND_DELAY_SECONDS } from '../../shared/protocol'
import { type FlowState, type StartInput } from '../hooks/usePayFlow'
import { USDC_DECIMALS } from '../onchain-facts'
import { formatUnitsFixed } from '../onchain-money'

const PHASE_COPY: Record<FlowState['phase'], string | null> = {
  idle: null,
  creating: 'Creating your request...',
  checking: 'Checking the contract and your balance...',
  approving: 'Approve 0.10 USDC in your wallet...',
  'approve-confirming': 'Waiting for the approval to confirm...',
  paying: 'Confirm the payment in your wallet...',
  'pay-confirming': 'Waiting for the payment to confirm...',
  submitted: null,
  error: null,
}

const price = formatUnitsFixed(PRICE_RAW, USDC_DECIMALS, 2)

interface Props {
  ready: boolean
  flow: FlowState
  onSubmit: (input: StartInput) => void
}

export function RequestForm({ ready, flow, onSubmit }: Props) {
  const [token, setToken] = useState('')
  const [size, setSize] = useState('')
  const { address, isConnected, chainId } = useAccount()
  const { switchChain, isPending: switching } = useSwitchChain()
  const usdc = productionFacts().usdc

  const balance = useReadContract({
    address: usdc,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: PRODUCTION_CHAIN_ID,
    query: { enabled: Boolean(address) },
  })

  const tokenValid = parseAddress(token) !== null
  const sizeValid = parseTradeSizeUsd(size) !== null
  const busy = PHASE_COPY[flow.phase] !== null
  const lowBalance = balance.data !== undefined && balance.data < PRICE_RAW
  const wrongChain = isConnected && chainId !== PRODUCTION_CHAIN_ID
  const canSubmit = ready && tokenValid && sizeValid && !busy && !lowBalance

  const submit = () => {
    if (canSubmit) onSubmit({ token: token.trim(), tradeSizeUsd: size.trim() })
  }

  return (
    <section className="card p-5 sm:p-6">
      <div className="label">New report</div>
      <h2 className="display mt-1 text-2xl font-semibold text-balance">Check a token before you trade it</h2>

      <div className="mt-5 space-y-3">
        <label className="block">
          <span className="label">Token address on Arc</span>
          <div className="field-wrap inner mt-1.5 px-4" style={tokenValid || token === '' ? undefined : { borderColor: 'var(--danger)' }}>
            <input
              className="field mono text-sm"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="0x..."
              spellCheck={false}
              autoComplete="off"
              aria-invalid={token !== '' && !tokenValid}
            />
          </div>
          {token !== '' && !tokenValid && <span className="mt-1 block text-xs" style={{ color: 'var(--danger)' }}>Enter a valid 0x address.</span>}
        </label>

        <label className="block">
          <span className="label">Intended trade size (USD)</span>
          <div className="field-wrap inner mt-1.5 flex items-center gap-2 px-4" style={sizeValid || size === '' ? undefined : { borderColor: 'var(--danger)' }}>
            <input
              className="field display text-2xl font-semibold tabular-nums"
              inputMode="decimal"
              value={size}
              onChange={(e) => /^\d{0,8}(\.\d{0,2})?$/.test(e.target.value) && setSize(e.target.value)}
              placeholder="0.00"
              aria-invalid={size !== '' && !sizeValid}
            />
            <span className="text-sm" style={{ color: 'var(--subtle)' }}>USD</span>
          </div>
          {size !== '' && !sizeValid && <span className="mt-1 block text-xs" style={{ color: 'var(--danger)' }}>Between 1 and 10,000,000 USD.</span>}
        </label>
      </div>

      <dl className="inner mt-4 divide-y text-sm" style={{ borderColor: 'var(--border)' }}>
        <Row label="Price" value={`${price} USDC`} strong />
        <Row label="Your USDC balance" value={balance.data !== undefined ? `${formatUnitsFixed(balance.data, USDC_DECIMALS, 2)} USDC` : isConnected ? 'Loading...' : 'Connect to view'} />
        <Row label="Network" value="Arc mainnet" />
        <Row label="If no report is settled" value={`Refund after ${(REFUND_DELAY_SECONDS / 60).toString()} minutes`} />
      </dl>

      {!isConnected ? (
        <ConnectKitButton.Custom>
          {({ show }) => (
            <button type="button" className="btn btn-primary mt-4 w-full" onClick={show}>Connect wallet</button>
          )}
        </ConnectKitButton.Custom>
      ) : wrongChain ? (
        <button type="button" className="btn btn-primary mt-4 w-full" disabled={switching} onClick={() => switchChain({ chainId: PRODUCTION_CHAIN_ID })}>
          {switching ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          Switch to Arc
        </button>
      ) : (
        <button type="button" className="btn btn-primary mt-4 w-full" disabled={!canSubmit} onClick={submit}>
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <ScanSearch className="size-4" aria-hidden />}
          {PHASE_COPY[flow.phase] ?? (lowBalance ? 'Not enough USDC' : `Pay ${price} USDC and get report`)}
        </button>
      )}

      {flow.message && (
        <p role="status" className="mt-3 text-sm text-pretty" style={{ color: flow.phase === 'error' ? 'var(--danger)' : 'var(--muted)' }}>
          {flow.message}
        </p>
      )}
    </section>
  )
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5" style={{ borderColor: 'var(--border)' }}>
      <dt style={{ color: 'var(--subtle)' }}>{label}</dt>
      <dd className={`tabular-nums ${strong ? 'font-semibold' : ''}`}>{value}</dd>
    </div>
  )
}
