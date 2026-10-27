import type { Address } from 'viem'
import { isZeroAddress, parseAddress } from '../../shared/protocol'

export type ContractConfig = { ok: true; address: Address } | { ok: false; reason: string }

/** Validates the configured PayPerCall address. Fails closed: empty, malformed, or zero is "not configured". */
export function parseContractAddress(raw: string | undefined): ContractConfig {
  const value = (raw ?? '').trim()
  if (value === '') return { ok: false, reason: 'The PayPerCall contract address is not configured yet (VITE_PAY_PER_CALL_ADDRESS is empty).' }
  const address = parseAddress(value)
  if (!address) return { ok: false, reason: 'VITE_PAY_PER_CALL_ADDRESS is not a valid address.' }
  if (isZeroAddress(address)) return { ok: false, reason: 'VITE_PAY_PER_CALL_ADDRESS is the zero address.' }
  return { ok: true, address }
}

export const contractConfig: ContractConfig = parseContractAddress(import.meta.env.VITE_PAY_PER_CALL_ADDRESS)
