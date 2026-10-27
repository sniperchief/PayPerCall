import { useId, useState, type KeyboardEvent } from 'react'
import { ArrowUpRight, FileCode2 } from 'lucide-react'
import { LINKS } from '../lib/route'
import { Reveal } from './Reveal'

/** Each snippet mirrors the real router (server/http.ts) and the app's payment calls (src/hooks/usePayFlow.ts). */
const SNIPPETS = [
  {
    id: 'create',
    tab: '1. Create',
    lang: 'HTTP',
    code: `POST /api/v1/requests
Content-Type: application/json

{
  "token": "0x...",          // token on Arc
  "tradeSizeUsd": "25000.00",
  "payer": "0x..."           // wallet that will pay
}

→ 201 Created
{
  "requestId": "0x...",
  "nonce": "0x...",
  "paramsHash": "0x...",
  "chainId": 5042,
  "contract": "0x...",
  "usdc": "0x3600000000000000000000000000000000000000",
  "priceRaw": "100000",
  "refundDelaySeconds": 1800,
  "expiresAt": 1761552000,
  "accessToken": "ppc_..."   // returned once, stored hashed
}`,
  },
  {
    id: 'pay',
    tab: '2. Pay',
    lang: 'TypeScript · viem',
    code: `// From the payer's wallet on Arc mainnet (chain 5042)
await wallet.writeContract({
  address: created.usdc,
  abi: erc20Abi,
  functionName: 'approve',
  args: [created.contract, 100_000n],   // 0.10 USDC, 6 decimals
})

await wallet.writeContract({
  address: created.contract,
  abi: payPerCallAbi,                   // docs/PayPerCall.abi.json
  functionName: 'createRequest',
  args: [created.nonce, created.paramsHash],
})`,
  },
  {
    id: 'fetch',
    tab: '3. Poll and fetch',
    lang: 'HTTP',
    code: `GET /api/v1/requests/{requestId}
Authorization: Bearer {accessToken}

→ 200 { "status": "SETTLING", "payment": { "state": "paid", ... },
        "reportAvailable": false, ... }

GET /api/v1/requests/{requestId}/report
Authorization: Bearer {accessToken}

→ 200 { "reportHash": "0x...", "settleTxHash": "0x...", "report": { ... } }
→ 409 REPORT_NOT_AVAILABLE   // until settlement is confirmed`,
  },
] as const

const ENDPOINTS = [
  { method: 'GET', path: '/health', note: 'Readiness and configuration problems' },
  { method: 'GET', path: '/quote', note: 'Contract, USDC, price, refund delay' },
  { method: 'POST', path: '/requests', note: 'Create a request, rate limited' },
  { method: 'GET', path: '/requests/:id', note: 'Status and onchain payment state' },
  { method: 'GET', path: '/requests/:id/report', note: 'Report, after confirmed settlement' },
] as const

const POINTS = [
  'No account or API key to create a request. Each request is bound to the wallet that will pay for it.',
  'Status and report reads need the access token. Unknown IDs and wrong tokens get the same 404.',
  'Polling a request advances it, so an agent can pay, poll and collect without a browser.',
]

export function Developers() {
  const [active, setActive] = useState(0)
  const baseId = useId()
  const snippet = SNIPPETS[active]

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    event.preventDefault()
    const next = (active + (event.key === 'ArrowRight' ? 1 : SNIPPETS.length - 1)) % SNIPPETS.length
    setActive(next)
    document.getElementById(`${baseId}-tab-${next.toString()}`)?.focus()
  }

  return (
    <section id="developers" className="bg-navy py-20 text-white sm:py-24" aria-labelledby="dev-title">
      <div className="mx-auto grid grid-cols-1 w-full max-w-6xl gap-12 px-4 sm:px-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-14 lg:px-8">
        <Reveal className="min-w-0">
          <div className="text-[0.8125rem] font-semibold text-[#9ec1ff]">For developers and trading agents</div>
          <h2 id="dev-title" className="display mt-2 text-3xl font-semibold leading-tight text-balance sm:text-4xl">
            Three HTTP calls and one contract payment.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-pretty text-[#c9d5ea]">
            Agents use the same flow as the app. Create a request over HTTP, pay from your own wallet on Arc, then poll with the access
            token until the report is released.
          </p>

          <ul className="mt-6 space-y-3">
            {POINTS.map((point) => (
              <li key={point} className="flex gap-3 text-sm leading-relaxed text-[#dbe4f3]">
                <span className="mt-[0.5625rem] h-px w-3 shrink-0 bg-[#9ec1ff]" aria-hidden />
                {point}
              </li>
            ))}
          </ul>

          <div className="mt-8 overflow-hidden rounded-lg border border-white/15">
            <div className="border-b border-white/15 px-4 py-2.5 text-xs font-semibold text-[#c9d5ea]">Endpoints under /api/v1</div>
            <ul className="divide-y divide-white/10">
              {ENDPOINTS.map((endpoint) => (
                <li key={`${endpoint.method} ${endpoint.path}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2.5">
                  <span className="mono w-10 shrink-0 text-[0.6875rem] font-medium text-[#9ec1ff]">{endpoint.method}</span>
                  <span className="mono min-w-0 text-[0.8125rem] text-white">{endpoint.path}</span>
                  <span className="w-full pl-[3.25rem] text-xs text-[#a9b8d1] sm:ml-auto sm:w-auto sm:pl-0 sm:text-right">{endpoint.note}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <a href={LINKS.apiDocs} target="_blank" rel="noreferrer" className="btn btn-lg bg-white text-[#142c52] hover:bg-[#edf2fd]">
              Read the API docs
              <ArrowUpRight className="size-4" aria-hidden />
            </a>
            <a href={LINKS.contract} target="_blank" rel="noreferrer" className="btn btn-lg btn-on-dark">
              <FileCode2 className="size-4" aria-hidden />
              View the contract
            </a>
          </div>
        </Reveal>

        <Reveal delay={100} className="min-w-0 lg:pt-1">
          <div className="overflow-hidden rounded-xl border border-white/15 bg-[#0b1a33] shadow-[0_24px_48px_-24px_rgba(0,0,0,0.5)]">
            <div className="flex items-center justify-between gap-2 border-b border-white/10 pl-2 pr-4">
              <div role="tablist" aria-label="Integration steps" className="flex min-w-0 overflow-x-auto">
                {SNIPPETS.map((item, index) => (
                  <button
                    key={item.id}
                    id={`${baseId}-tab-${index.toString()}`}
                    type="button"
                    role="tab"
                    aria-selected={index === active}
                    aria-controls={`${baseId}-panel`}
                    tabIndex={index === active ? 0 : -1}
                    onClick={() => setActive(index)}
                    onKeyDown={onKeyDown}
                    className={`relative shrink-0 whitespace-nowrap px-3 py-3.5 text-[0.8125rem] font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#9ec1ff] ${
                      index === active ? 'text-white' : 'text-[#a9b8d1] hover:text-white'
                    }`}
                  >
                    {item.tab}
                    {index === active && <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-[#5b8cff]" aria-hidden />}
                  </button>
                ))}
              </div>
              <span className="hidden shrink-0 text-[0.6875rem] text-[#a9b8d1] sm:block">{snippet.lang}</span>
            </div>
            <div id={`${baseId}-panel`} role="tabpanel" aria-labelledby={`${baseId}-tab-${active.toString()}`} tabIndex={0} className="overflow-x-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#9ec1ff]">
              <pre className="mono min-h-[22rem] p-5 text-[0.78125rem] leading-[1.7] text-[#dbe4f3]">
                <code>{snippet.code.split('\n').map((line, index) => <CodeLine key={index} line={line} />)}</code>
              </pre>
            </div>
            <div className="border-t border-white/10 px-5 py-3 text-xs text-[#a9b8d1]">
              Placeholders shown as <span className="mono text-[#dbe4f3]">0x...</span>. Responses abbreviated.
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  )
}

/** Minimal highlighting: HTTP verbs, response lines, strings and trailing comments. */
function CodeLine({ line }: { line: string }) {
  const commentAt = line.indexOf('//')
  const code = commentAt >= 0 ? line.slice(0, commentAt) : line
  const comment = commentAt >= 0 ? line.slice(commentAt) : ''
  const isResponse = code.trimStart().startsWith('→')
  const verb = /^(GET|POST)\s/.exec(code)

  return (
    <span className="block">
      {verb ? (
        <>
          <span className="font-medium text-[#9ec1ff]">{verb[1]}</span>
          <span className="text-white">{code.slice(verb[1].length)}</span>
        </>
      ) : isResponse ? (
        <span className="text-[#86d6ae]">{code}</span>
      ) : (
        code.split(/("[^"]*"|'[^']*')/).map((part, index) =>
          index % 2 === 1 ? <span key={index} className="text-[#f2cc8f]">{part}</span> : <span key={index}>{part}</span>,
        )
      )}
      {comment && <span className="text-[#8796b0]">{comment}</span>}
      {line === '' && ' '}
    </span>
  )
}
