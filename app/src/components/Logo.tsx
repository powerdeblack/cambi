// Logo em linha: "camb" acompanha a cor do tema (legível no claro e no escuro), "I" sempre verde.
export function Logo({ height = 32 }: { height?: number }) {
  return (
    <svg viewBox="0 0 220 80" height={height} role="img" aria-label="cambI">
      <text
        x="0"
        y="60"
        fontFamily="Inter, 'Helvetica Neue', Arial, sans-serif"
        fontSize="64"
        fontWeight="800"
        letterSpacing="-2"
        fill="currentColor"
      >
        camb
      </text>
      <g fill="var(--green)">
        <rect x="168" y="12" width="44" height="10" rx="3" />
        <rect x="183" y="12" width="14" height="56" rx="3" />
        <rect x="168" y="58" width="44" height="10" rx="3" />
      </g>
    </svg>
  );
}
