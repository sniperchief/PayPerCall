/**
 * wagmi configuration: Arc mainnet (chain 5042) is the production network for PayPerCall.
 * Built with Arc Studio — https://studio.arc.io
 */

import { http, createConfig } from 'wagmi'
import { arc } from 'viem/chains'
import { injected } from 'wagmi/connectors'
import { registerChain } from './tracing'
import { PRODUCTION_CHAIN_ID, productionFacts } from '../shared/protocol'

const facts = productionFacts()
if (arc.id !== PRODUCTION_CHAIN_ID || facts.chainId !== PRODUCTION_CHAIN_ID) {
  throw new Error('Arc chain configuration does not match the verified production chain ID')
}

// Pre-register chain RPC URLs so trace events show correct chain names immediately
registerChain(arc.id, facts.rpcUrl)

export const config = createConfig({
  chains: [arc],
  connectors: [injected()],
  transports: {
    [arc.id]: http(facts.rpcUrl),
  },
})
