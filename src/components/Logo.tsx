/** PayPerCall mark: a navy tile with a report sheet and a settled check. */
export function Logo({ size = 28, inverted = false }: { size?: number; inverted?: boolean }) {
  const tile = inverted ? '#ffffff' : '#142c52'
  const sheet = inverted ? '#142c52' : '#ffffff'
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden focusable="false">
      <rect width="28" height="28" rx="6" fill={tile} />
      <path d="M9 7.5h7l3 3v10H9z" fill="none" stroke={sheet} strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M11.5 15.2l2 2 3.5-3.7" fill="none" stroke={inverted ? '#2459d3' : '#8fb0ff'} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
