import { useEffect, useState } from 'react'
import { Loader2, Undo2 } from 'lucide-react'
import type { Hex } from 'viem'
import { useAccount, useConfig, useWriteContract } from 'wagmi'
import { waitForTransactionReceipt } from 'wagmi/actions'
import { payPerCallAbi } from '../../shared/abi'
import { PRODUCTION_CHAIN_ID } from '../../shared/protocol'
import { contractConfig } from '../lib/env'
import { describeTxError } from '../lib/errors'
import { formatCountdown, refundCountdownSeconds } from '../lib/stages'
import { buildTxExplorerUrl } from '../onchain-facts'
import type { HistoryEntry } from '../lib/history'

interface Props {
  entry: HistoryEntry
  refundableAt: number | null
  onRefunded: () => void
}

/** Refund is a contract call by the original payer, available once the contract's deadline has passed. */
export function RefundPanel({ entry, refundableAt, onRefunded }: Props) {
  const config = useConfig()
  const { writeContractAsync } = useWriteContract()
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [hash, setHash] = useState<Hex | null>(null)

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const remaining = refundCountdownSeconds(refundableAt, now)
  const available = remaining === 0
  const { address } = useAccount()
  const isPayer = address?.toLowerCase() === entry.payer.toLowerCase()

  const refund = async () => {
    if (!contractConfig.ok) return
    setBusy(true)
    setMessage(null)
    try {
      const txHash = await writeContractAsync({
        address: contractConfig.address,
        abi: payPerCallAbi,
        functionName: 'refund',
        args: [entry.created.requestId, entry.payer],
        chainId: PRODUCTION_CHAIN_ID,
      })
      setHash(txHash)
      const receipt = await waitForTransactionReceipt(config, { hash: txHash, chainId: PRODUCTION_CHAIN_ID })
      if (receipt.status !== 'success') setMessage('The refund transaction failed.')
      else onRefunded()
    } catch (error) {
      setMessage(describeTxError(error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="inner mt-4 p-4">
      <div className="label">Refund</div>
      <p className="mt-1.5 text-sm text-pretty" style={{ color: 'var(--muted)' }}>
        {available
          ? 'The deadline has passed. The contract will return 0.10 USDC to the wallet that paid.'
          : remaining === null
            ? 'Waiting for the contract deadline.'
            : <>Refund opens in <span className="mono tabular-nums">{formatCountdown(remaining)}</span>.</>}
      </p>
      <button type="button" className="btn btn-primary mt-3" disabled={!available || busy || !isPayer} onClick={() => void refund()}>
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Undo2 className="size-4" aria-hidden />}
        {busy ? 'Refunding...' : 'Refund 0.10 USDC'}
      </button>
      {!isPayer && <p className="mt-2 text-xs" style={{ color: 'var(--subtle)' }}>Connect the wallet that paid to refund.</p>}
      {message && <p role="status" className="mt-2 text-sm" style={{ color: 'var(--danger)' }}>{message}</p>}
      {hash && (
        <a className="link mt-2 inline-block text-xs" href={buildTxExplorerUrl(PRODUCTION_CHAIN_ID, hash)} target="_blank" rel="noreferrer">
          View refund transaction
        </a>
      )}
    </div>
  )
}
