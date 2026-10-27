import { useCallback, useRef, useState } from 'react'
import { erc20Abi, type Address, type Hex } from 'viem'
import { useConfig, useSwitchChain, useWriteContract } from 'wagmi'
import { getAccount, readContract, waitForTransactionReceipt } from 'wagmi/actions'
import { payPerCallAbi, ONCHAIN_STATUS } from '../../shared/abi'
import { PRICE_RAW, PRODUCTION_CHAIN_ID, parseAddress, productionFacts, type CreateRequestResponse } from '../../shared/protocol'
import { api, ApiError } from '../lib/api'
import { contractConfig } from '../lib/env'
import { describeTxError } from '../lib/errors'
import { saveEntry, type HistoryEntry } from '../lib/history'
import { paymentBlockedReason, paymentWindowOpen } from '../lib/stages'

const EXPIRED_MESSAGE = 'This request expires too soon to pay safely. Start a new request instead.'

export type Phase =
  | 'idle'
  | 'creating'
  | 'checking'
  | 'approving'
  | 'approve-confirming'
  | 'paying'
  | 'pay-confirming'
  | 'submitted'
  | 'error'

export interface FlowState {
  phase: Phase
  message: string | null
  approveHash: Hex | null
  payHash: Hex | null
}

const INITIAL: FlowState = { phase: 'idle', message: null, approveHash: null, payHash: null }

/** A problem we detected ourselves; its message is safe to show as is. */
class FlowError extends Error {}

export interface StartInput {
  token: string
  tradeSizeUsd: string
}

/**
 * Drives create request, approve, pay. Each step reflects a real wallet or receipt result.
 * Payment is never considered complete here: the server confirms it from contract state.
 */
export function usePayFlow(onEntry: (entry: HistoryEntry) => void) {
  const config = useConfig()
  const { writeContractAsync } = useWriteContract()
  const { switchChainAsync } = useSwitchChain()
  const [state, setState] = useState<FlowState>(INITIAL)
  const busy = useRef(false)

  const patch = useCallback((next: Partial<FlowState>) => setState((prev) => ({ ...prev, ...next })), [])

  const pay = useCallback(
    async (entry: HistoryEntry) => {
      const { created } = entry
      if (!contractConfig.ok) throw new FlowError(contractConfig.reason)
      const usdc = productionFacts().usdc
      const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
      if (created.chainId !== PRODUCTION_CHAIN_ID || !same(created.contract, contractConfig.address) || !same(created.usdc, usdc)) {
        throw new FlowError('The server and this app disagree about the contract or network. Payment cancelled.')
      }
      if (BigInt(created.priceRaw) !== PRICE_RAW) throw new FlowError('The quoted price is not 0.10 USDC. Payment cancelled.')
      // A payment that lands after the server expires the request is never processed, only refundable.
      if (!paymentWindowOpen(created.expiresAt, Date.now())) throw new FlowError(EXPIRED_MESSAGE)
      // Resumed requests skip POST /requests, so confirm here that the server can still settle before any approval.
      const blocked = paymentBlockedReason(await api.health())
      if (blocked) throw new FlowError(blocked)

      const account = getAccount(config)
      if (!account.address) throw new FlowError('Connect your wallet to continue.')
      if (!same(account.address, entry.payer)) throw new FlowError('Connect the wallet this request was created for.')

      patch({ phase: 'checking', message: null })
      const contract = contractConfig.address
      const [onchainPrice, onchainRequest, balance, allowance] = await Promise.all([
        readContract(config, { address: contract, abi: payPerCallAbi, functionName: 'PRICE', chainId: PRODUCTION_CHAIN_ID }),
        readContract(config, { address: contract, abi: payPerCallAbi, functionName: 'requests', args: [created.requestId], chainId: PRODUCTION_CHAIN_ID }),
        readContract(config, { address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [account.address], chainId: PRODUCTION_CHAIN_ID }),
        readContract(config, { address: usdc, abi: erc20Abi, functionName: 'allowance', args: [account.address, contract], chainId: PRODUCTION_CHAIN_ID }),
      ])
      if (onchainPrice !== PRICE_RAW) throw new FlowError('The contract price is not 0.10 USDC. Payment cancelled.')
      if (onchainRequest[3] !== ONCHAIN_STATUS.None) {
        patch({ phase: 'submitted' })
        return
      }
      if (balance < PRICE_RAW) throw new FlowError('Your USDC balance is below 0.10 USDC.')

      if (account.chainId !== PRODUCTION_CHAIN_ID) await switchChainAsync({ chainId: PRODUCTION_CHAIN_ID })

      if (allowance < PRICE_RAW) {
        patch({ phase: 'approving' })
        const approveHash = await writeContractAsync({
          address: usdc,
          abi: erc20Abi,
          functionName: 'approve',
          args: [contract, PRICE_RAW],
          chainId: PRODUCTION_CHAIN_ID,
        })
        patch({ phase: 'approve-confirming', approveHash })
        const approval = await waitForTransactionReceipt(config, { hash: approveHash, chainId: PRODUCTION_CHAIN_ID })
        if (approval.status !== 'success') throw new FlowError('The approval transaction failed.')
      }

      // The approval may have taken a while: check again right before the payment itself.
      if (!paymentWindowOpen(created.expiresAt, Date.now())) throw new FlowError(EXPIRED_MESSAGE)
      patch({ phase: 'paying' })
      const payHash = await writeContractAsync({
        address: contract,
        abi: payPerCallAbi,
        functionName: 'createRequest',
        args: [created.nonce, created.paramsHash],
        chainId: PRODUCTION_CHAIN_ID,
      })
      patch({ phase: 'pay-confirming', payHash })
      const receipt = await waitForTransactionReceipt(config, { hash: payHash, chainId: PRODUCTION_CHAIN_ID })
      if (receipt.status !== 'success') throw new FlowError('The payment transaction failed. Nothing was charged.')
      patch({ phase: 'submitted' })
    },
    [config, patch, switchChainAsync, writeContractAsync],
  )

  const guarded = useCallback(
    async (job: () => Promise<void>) => {
      if (busy.current) return
      busy.current = true
      setState(INITIAL)
      try {
        await job()
      } catch (error) {
        if (error instanceof FlowError) patch({ phase: 'error', message: error.message })
        else if (error instanceof ApiError) patch({ phase: 'error', message: error.status === 503 ? 'The service is not ready for payments yet.' : error.message })
        else {
          const described = describeTxError(error)
          patch(described.kind === 'rejected' ? { phase: 'idle', message: described.message } : { phase: 'error', message: described.message })
        }
      } finally {
        busy.current = false
      }
    },
    [patch],
  )

  /** Creates a request on the server, stores it locally, then runs the payment. */
  const start = useCallback(
    (input: StartInput, onCreated: (entry: HistoryEntry) => void) =>
      guarded(async () => {
        const account = getAccount(config)
        const payer = parseAddress(account.address)
        const token = parseAddress(input.token)
        if (!payer) throw new FlowError('Connect your wallet to continue.')
        if (!token) throw new FlowError('Enter a valid token address.')
        patch({ phase: 'creating' })
        const created: CreateRequestResponse = await api.create({ token, tradeSizeUsd: input.tradeSizeUsd, payer })
        const entry: HistoryEntry = { created, token, tradeSizeUsd: input.tradeSizeUsd, payer, savedAt: Date.now() }
        saveEntry(entry)
        onEntry(entry)
        onCreated(entry)
        await pay(entry)
      }),
    [config, guarded, onEntry, pay, patch],
  )

  /** Retries payment for a request that was created but not paid. */
  const resume = useCallback((entry: HistoryEntry) => guarded(() => pay(entry)), [guarded, pay])

  const reset = useCallback(() => setState(INITIAL), [])

  return { state, start, resume, reset }
}

export type Payer = Address
