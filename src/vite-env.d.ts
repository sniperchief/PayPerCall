/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Deployed PayPerCall contract on Arc mainnet. Empty until deployment. */
  readonly VITE_PAY_PER_CALL_ADDRESS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
