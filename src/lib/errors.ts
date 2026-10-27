import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from 'viem'

export type TxErrorKind = 'rejected' | 'reverted' | 'network' | 'other'

export interface TxError {
  kind: TxErrorKind
  message: string
}

const REVERT_MESSAGES: Record<string, string> = {
  RequestAlreadyExists: 'This request was already paid for.',
  EnforcedPause: 'New requests are paused right now.',
  UnexpectedReceivedAmount: 'The USDC transfer did not deliver exactly 0.10 USDC.',
  RefundNotYetAvailable: 'The refund is not available yet. Wait for the 30 minute deadline to pass.',
  NotPayer: 'Only the wallet that paid can refund this request.',
  NotPaid: 'This request is no longer in a refundable state.',
  InvalidRecipient: 'That refund recipient is not allowed.',
}

/** Turns a wagmi/viem error into text safe to show. User rejection is not a failure. */
export function describeTxError(error: unknown): TxError {
  if (error instanceof BaseError) {
    if (error.walk((e) => e instanceof UserRejectedRequestError)) return { kind: 'rejected', message: 'Transaction cancelled in your wallet.' }
    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError)
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName
      return { kind: 'reverted', message: (name && REVERT_MESSAGES[name]) || 'The transaction was rejected by the contract.' }
    }
  }
  const text = error instanceof Error ? error.message.toLowerCase() : ''
  if (text.includes('user rejected') || text.includes('user denied')) return { kind: 'rejected', message: 'Transaction cancelled in your wallet.' }
  if (text.includes('insufficient funds') || text.includes('exceeds balance')) {
    return { kind: 'reverted', message: 'Insufficient USDC for this transaction, including network fees.' }
  }
  if (text.includes('network') || text.includes('timeout') || text.includes('fetch')) {
    return { kind: 'network', message: 'Network issue. Check your connection and try again.' }
  }
  return { kind: 'other', message: 'Something went wrong. Please try again.' }
}
