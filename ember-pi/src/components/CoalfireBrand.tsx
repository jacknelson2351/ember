// Coalfire hex mark — extracted from coalfire-federal-logo.svg (double hexagon only)
export function CoalfireBrand({ compact = false }: { compact?: boolean }) {
  const size = compact ? 28 : 36;
  return (
    <svg
      width={size}
      height={size}
      viewBox="24 0 23 23"
      fill="none"
      aria-label="Coalfire"
    >
      {/* Orange inner hex */}
      <path
        d="M26.81 16.3967V10.0914L32.2174 6.93878L37.6247 10.0914V16.3967L32.2174 19.5542L26.81 16.3967ZM24.2148 8.57601V17.9072L32.2174 22.5753L40.2199 17.9072V8.57601L32.2174 3.90796L24.2148 8.57601Z"
        fill="#DC502A"
      />
      {/* White outer hex */}
      <path
        d="M33.5104 12.4887V6.18346L38.9178 3.03082L44.3252 6.18346V12.4887L38.9178 15.6414L33.5104 12.4887ZM38.9178 0L30.9153 4.66805V13.9993L38.9178 18.6673L46.9203 13.9993V4.66805L38.9178 0Z"
        fill="white"
      />
    </svg>
  );
}
