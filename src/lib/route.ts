/** Hash routes keep the static Vercel deployment working without SPA rewrites. */
export const APP_HREF = '#/app'

export type View = 'landing' | 'app'

export function currentView(): View {
  return window.location.hash.startsWith(APP_HREF) ? 'app' : 'landing'
}

const REPO = 'https://github.com/sniperchief/PayPerCall'

/** Public project destinations. All of them exist in the repository. */
export const LINKS = {
  repo: REPO,
  apiDocs: `${REPO}/blob/main/docs/phase3-frontend-backend.md`,
  contract: `${REPO}/blob/main/contracts/PayPerCall.sol`,
  abi: `${REPO}/blob/main/docs/PayPerCall.abi.json`,
  integration: `${REPO}/blob/main/docs/payper-call-integration.md`,
  security: `${REPO}/blob/main/docs/phase2-security-handoff.md`,
  arcDocs: 'https://docs.arc.io',
  arcStudio: 'https://studio.arc.io',
} as const
