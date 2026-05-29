export function AetherisLogo({ className }: { className?: string }) {
  return (
    <svg
      width="1200"
      height="1200"
      viewBox="0 0 1200 1200"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <defs>
        <linearGradient id="aetheris-spire" x1="344" y1="220" x2="856" y2="978" gradientUnits="userSpaceOnUse">
          <stop stopColor="#EFFFFF" />
          <stop offset="0.4" stopColor="#20E6FF" />
          <stop offset="1" stopColor="#4D8DFF" />
        </linearGradient>
        <linearGradient id="aetheris-orbit" x1="192" y1="346" x2="1008" y2="834" gradientUnits="userSpaceOnUse">
          <stop stopColor="#EFFFFF" stopOpacity="0.92" />
          <stop offset="0.5" stopColor="#15E7FF" stopOpacity="0.82" />
          <stop offset="1" stopColor="#4D8DFF" stopOpacity="0.7" />
        </linearGradient>
        <filter id="aetheris-soft-glow" x="120" y="120" width="960" height="960" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feDropShadow dx="0" dy="0" stdDeviation="14" floodColor="#14E8FF" floodOpacity="0.28" />
          <feDropShadow dx="0" dy="14" stdDeviation="22" floodColor="#4D8DFF" floodOpacity="0.12" />
        </filter>
      </defs>

      <path
        d="M206 714C378 598 624 548 994 598"
        fill="none"
        stroke="url(#aetheris-orbit)"
        strokeWidth="32"
        strokeLinecap="round"
        filter="url(#aetheris-soft-glow)"
      />
      <path
        d="M358 938L600 236L842 938"
        fill="none"
        stroke="url(#aetheris-spire)"
        strokeWidth="74"
        strokeLinecap="round"
        strokeLinejoin="round"
        filter="url(#aetheris-soft-glow)"
      />
      <path
        d="M486 742H714"
        fill="none"
        stroke="url(#aetheris-spire)"
        strokeWidth="66"
        strokeLinecap="round"
        filter="url(#aetheris-soft-glow)"
      />
      <path
        d="M600 236L746 938"
        fill="none"
        stroke="#EFFFFF"
        strokeWidth="18"
        strokeLinecap="round"
        strokeOpacity="0.28"
      />
      <circle cx="994" cy="598" r="26" fill="#EFFFFF" fillOpacity="0.92" filter="url(#aetheris-soft-glow)" />
      <path d="M600 116L622 176L682 198L622 220L600 280L578 220L518 198L578 176L600 116Z" fill="#EFFFFF" fillOpacity="0.9" />
    </svg>
  )
}
