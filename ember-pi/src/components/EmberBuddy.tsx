import { useEffect, useState } from 'react';

export type EmberMode =
  | 'idle'       // gentle sway, eyes wander/blink/wink
  | 'thinking'   // pupils orbit, sparks above
  | 'streaming'  // eyes scan left-right (reading)
  | 'happy'      // arch eyes ^_^, flame pops
  | 'error'      // × eyes, flame shakes
  | 'excited';   // pupils up, big rapid flicker

// ── Pixel grid ───────────────────────────────────────────────────────────────
const W = 12;
const H = 16;

const FLAME: Record<number, string> = {
  1: '#8B1500',
  2: '#CC3300',
  3: '#FF5B1B',
  4: '#FF8C42',
  5: '#FFD166',
  6: '#FFF0A0',
};

// 0 = transparent; rows 6-8 cols 2-4 and 7-9 = eye region (overdrawn)
const GRID: number[][] = [
  [0,0,0,0,0,5,6,0,0,0,0,0],
  [0,0,0,0,5,5,5,5,0,0,0,0],
  [0,0,0,5,5,6,6,5,5,0,0,0],
  [0,0,4,4,5,6,6,5,4,4,0,0],
  [0,3,4,4,5,5,5,5,4,4,3,0],
  [3,3,3,4,4,5,5,4,4,3,3,0],
  [0,3,3,3,3,4,4,3,3,3,3,0],
  [0,3,3,3,3,4,4,3,3,3,3,0],
  [0,3,3,3,4,4,4,4,3,3,3,0],
  [3,3,4,4,4,4,4,4,4,3,3,0],
  [2,3,3,3,3,4,4,3,3,3,2,0],
  [2,2,3,2,3,3,3,2,3,2,2,0],
  [2,2,2,1,2,2,2,1,2,2,2,0],
  [0,2,2,2,1,2,1,2,2,2,0,0],
  [0,0,1,1,1,1,1,1,1,0,0,0],
  [0,0,0,1,1,1,1,1,0,0,0,0],
];

const isEyePixel = (cx: number, cy: number) =>
  ((cx >= 2 && cx <= 4) || (cx >= 7 && cx <= 9)) && cy >= 6 && cy <= 8;

// ── Eye centres ───────────────────────────────────────────────────────────────
// L = col 3, R = col 8, shared cy = 7
const EL = { cx: 3, cy: 7 };
const ER = { cx: 8, cy: 7 };

// ── Idle sequence (independent per eye) ──────────────────────────────────────
interface EyeFrame {
  ldx: number; ldy: number; lblink?: true;
  rdx: number; rdy: number; rblink?: true;
}
const IDLE: EyeFrame[] = [
  { ldx:0, ldy:0,  rdx:0, rdy:0  },  // center
  { ldx:0, ldy:0,  rdx:0, rdy:0  },
  { ldx:-1,ldy:0,  rdx:-1,rdy:0  },  // both left
  { ldx:-1,ldy:0,  rdx:-1,rdy:0  },
  { ldx:0, ldy:0,  rdx:0, rdy:0  },
  { ldx:0, ldy:0,  rdx:0, rdy:0,  rblink:true },  // wink right
  { ldx:0, ldy:0,  rdx:0, rdy:0  },
  { ldx:1, ldy:0,  rdx:1, rdy:0  },  // both right
  { ldx:1, ldy:0,  rdx:1, rdy:0  },
  { ldx:0, ldy:0,  rdx:0, rdy:0  },
  { ldx:0, ldy:0,  rdx:0, rdy:0  },  // placeholder — overridden below
  { ldx:0, ldy:0,  rdx:0, rdy:0  },
  { ldx:0, ldy:0,  rdx:0, rdy:0,  lblink:true, rblink:true },  // both blink
  { ldx:0, ldy:0,  rdx:0, rdy:0  },
  { ldx:0, ldy:0,  rdx:0, rdy:0  },
  { ldx:1, ldy:0,  rdx:-1,rdy:0  },  // cross-eyed!
  { ldx:0, ldy:0,  rdx:0, rdy:0  },
  { ldx:0, ldy:0,  rdx:0, rdy:0,  lblink:true },  // wink left
  { ldx:0, ldy:0,  rdx:0, rdy:0  },
  { ldx:0, ldy:0,  rdx:0, rdy:0  },
];
// Fix the "both up" frame (TypeScript doesn't like the inline overwrite above)
IDLE[10] = { ldx:0, ldy:-1, rdx:0, rdy:-1 };

const IDLE_DUR = [800,700,450,450,700,110,700,450,450,800,520,700,110,800,900,220,700,110,700,1000];

// Thinking orbit (clockwise)
const ORBIT = [{ dx:0,dy:-1 },{ dx:1,dy:0 },{ dx:0,dy:1 },{ dx:-1,dy:0 }];

// Streaming scan (L L C R R C …)
const SCAN = [-1, -1, 0, 1, 1, 0];

// ── Eye rendering helpers ─────────────────────────────────────────────────────

interface PixelSpec {
  x: number;
  y: number;
  fill: string;
  opacity?: number;
}

const FIRE_FLICKER_FRAMES: PixelSpec[][] = [
  [
    { x: 1, y: 3, fill: '#FFD166', opacity: 0.5 },
    { x: 0, y: 5, fill: '#FF5B1B', opacity: 0.82 },
    { x: 1, y: 4, fill: '#FF8C42', opacity: 0.92 },
    { x: 10, y: 4, fill: '#FFD166', opacity: 0.58 },
    { x: 11, y: 6, fill: '#FF5B1B', opacity: 0.78 },
    { x: 10, y: 5, fill: '#FF8C42', opacity: 0.9 },
    { x: 4, y: 0, fill: '#FFF0A0', opacity: 0.35 },
  ],
  [
    { x: 1, y: 2, fill: '#FFD166', opacity: 0.56 },
    { x: 0, y: 4, fill: '#FF5B1B', opacity: 0.84 },
    { x: 1, y: 3, fill: '#FF8C42', opacity: 0.94 },
    { x: 10, y: 3, fill: '#FFD166', opacity: 0.54 },
    { x: 11, y: 5, fill: '#FF5B1B', opacity: 0.8 },
    { x: 10, y: 4, fill: '#FF8C42', opacity: 0.92 },
    { x: 8, y: 0, fill: '#FFF0A0', opacity: 0.42 },
  ],
  [
    { x: 0, y: 6, fill: '#FF5B1B', opacity: 0.76 },
    { x: 1, y: 5, fill: '#FF8C42', opacity: 0.88 },
    { x: 2, y: 3, fill: '#FFD166', opacity: 0.44 },
    { x: 11, y: 4, fill: '#FF5B1B', opacity: 0.74 },
    { x: 10, y: 3, fill: '#FF8C42', opacity: 0.86 },
    { x: 9, y: 1, fill: '#FFD166', opacity: 0.5 },
    { x: 5, y: 0, fill: '#FFF0A0', opacity: 0.3 },
  ],
  [
    { x: 0, y: 5, fill: '#FF5B1B', opacity: 0.8 },
    { x: 1, y: 4, fill: '#FF8C42', opacity: 0.9 },
    { x: 2, y: 2, fill: '#FFD166', opacity: 0.4 },
    { x: 11, y: 5, fill: '#FF5B1B', opacity: 0.82 },
    { x: 10, y: 4, fill: '#FF8C42', opacity: 0.9 },
    { x: 9, y: 2, fill: '#FFD166', opacity: 0.46 },
    { x: 7, y: 0, fill: '#FFF0A0', opacity: 0.32 },
  ],
];

const EMBER_FRAMES: PixelSpec[][] = [
  [
    { x: 3, y: -1, fill: '#FFD166', opacity: 0.46 },
    { x: 9, y: -2, fill: '#FFF0A0', opacity: 0.28 },
  ],
  [
    { x: 4, y: -2, fill: '#FFD166', opacity: 0.38 },
    { x: 8, y: -1, fill: '#FFF0A0', opacity: 0.34 },
  ],
  [
    { x: 2, y: -1, fill: '#FF8C42', opacity: 0.34 },
    { x: 8, y: -2, fill: '#FFD166', opacity: 0.3 },
  ],
  [
    { x: 4, y: -1, fill: '#FFD166', opacity: 0.42 },
    { x: 10, y: -1, fill: '#FFF0A0', opacity: 0.26 },
  ],
];

function roundEye(cx: number, cy: number, pdx: number, pdy: number): PixelSpec[] {
  const out: PixelSpec[] = [];
  // 3×3 white
  for (let ex = cx - 1; ex <= cx + 1; ex++)
    for (let ey = cy - 1; ey <= cy + 1; ey++)
      out.push({ x: ex, y: ey, fill: '#FFFFFF' });
  // pupil
  out.push({ x: cx + pdx, y: cy + pdy, fill: '#0D0500' });
  // shine (top-left, always)
  out.push({ x: cx - 1, y: cy - 1, fill: 'rgba(255,255,255,0.7)' });
  return out;
}

function blinkEye(cx: number, cy: number): PixelSpec[] {
  // Single horizontal line (3×1)
  return [cx-1,cx,cx+1].map(x => ({ x, y: cy, fill: '#FFFFFF' }));
}

function archEye(cx: number, cy: number): PixelSpec[] {
  // ^ shape: top row full, middle row sides only — happy/closed
  return [
    { x: cx-1, y: cy-1, fill: '#FFFFFF' },
    { x: cx,   y: cy-1, fill: '#FFFFFF' },
    { x: cx+1, y: cy-1, fill: '#FFFFFF' },
    { x: cx-1, y: cy,   fill: '#FFFFFF' },
    { x: cx+1, y: cy,   fill: '#FFFFFF' },
  ];
}

function xEye(cx: number, cy: number): PixelSpec[] {
  // × shape in reddish colour
  const c = '#FF5555';
  return [
    { x: cx-1, y: cy-1, fill: c },
    { x: cx+1, y: cy-1, fill: c },
    { x: cx,   y: cy,   fill: c },
    { x: cx-1, y: cy+1, fill: c },
    { x: cx+1, y: cy+1, fill: c },
  ];
}

function excitedEye(cx: number, cy: number): PixelSpec[] {
  // Big open — pupil looking up (eager)
  return roundEye(cx, cy, 0, -1);
}

// ── Component ─────────────────────────────────────────────────────────────────
export function EmberBuddy({
  mode,
  pixelScale = 3,
}: {
  mode: EmberMode;
  pixelScale?: number;
}) {
  const [idleIdx,  setIdleIdx]  = useState(0);
  const [orbitIdx, setOrbitIdx] = useState(0);
  const [scanIdx,  setScanIdx]  = useState(0);
  const [flareIdx, setFlareIdx] = useState(0);

  // Idle cycling
  useEffect(() => {
    if (mode !== 'idle') return;
    let cancelled = false;
    const step = (i: number) => {
      setTimeout(() => {
        if (cancelled) return;
        const next = (i + 1) % IDLE.length;
        setIdleIdx(next);
        step(next);
      }, IDLE_DUR[i % IDLE_DUR.length]);
    };
    step(idleIdx);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Thinking orbit
  useEffect(() => {
    if (mode !== 'thinking') return;
    const id = setInterval(() => setOrbitIdx(i => (i + 1) % 4), 190);
    return () => clearInterval(id);
  }, [mode]);

  // Streaming scan
  useEffect(() => {
    if (mode !== 'streaming') return;
    const id = setInterval(() => setScanIdx(i => (i + 1) % SCAN.length), 280);
    return () => clearInterval(id);
  }, [mode]);

  // Detached flame bits keep the silhouette lively even when the body is still.
  useEffect(() => {
    const interval =
      mode === 'excited' ? 120 :
      mode === 'thinking' ? 150 :
      mode === 'streaming' ? 180 :
      mode === 'happy' ? 170 :
      mode === 'error' ? 220 :
      260;
    const id = setInterval(() => setFlareIdx(i => (i + 1) % FIRE_FLICKER_FRAMES.length), interval);
    return () => clearInterval(id);
  }, [mode]);

  // ── Derive eye pixels ────────────────────────────────────────────────────
  let leftPx: PixelSpec[], rightPx: PixelSpec[];

  switch (mode) {
    case 'happy':
      leftPx  = archEye(EL.cx, EL.cy);
      rightPx = archEye(ER.cx, ER.cy);
      break;
    case 'error':
      leftPx  = xEye(EL.cx, EL.cy);
      rightPx = xEye(ER.cx, ER.cy);
      break;
    case 'excited':
      leftPx  = excitedEye(EL.cx, EL.cy);
      rightPx = excitedEye(ER.cx, ER.cy);
      break;
    case 'thinking': {
      const o = ORBIT[orbitIdx];
      leftPx  = roundEye(EL.cx, EL.cy, o.dx, o.dy);
      rightPx = roundEye(ER.cx, ER.cy, o.dx, o.dy);
      break;
    }
    case 'streaming': {
      const sdx = SCAN[scanIdx];
      leftPx  = roundEye(EL.cx, EL.cy, sdx, 0);
      rightPx = roundEye(ER.cx, ER.cy, sdx, 0);
      break;
    }
    default: { // idle
      const f = IDLE[idleIdx % IDLE.length];
      leftPx  = f.lblink ? blinkEye(EL.cx, EL.cy) : roundEye(EL.cx, EL.cy, f.ldx, f.ldy);
      rightPx = f.rblink ? blinkEye(ER.cx, ER.cy) : roundEye(ER.cx, ER.cy, f.rdx, f.rdy);
    }
  }

  // ── Flame animation per mode ─────────────────────────────────────────────
  const flameAnim =
    mode === 'thinking'  ? 'flameThink 0.65s ease-in-out infinite'  :
    mode === 'streaming' ? 'flameFlicker 0.32s ease-in-out infinite' :
    mode === 'happy'     ? 'flameHappy 0.5s ease-out forwards'       :
    mode === 'error'     ? 'flameError 0.12s linear infinite'        :
    mode === 'excited'   ? 'flameFlicker 0.22s ease-in-out infinite' :
                           'flameSway 2.8s ease-in-out infinite';

  // ── Thinking sparks above flame ──────────────────────────────────────────
  const sparks = mode === 'thinking' ? (
    <>
      <rect x={orbitIdx % 2 === 0 ? 4 : 6} y={-1} width={1} height={1} fill="#FFF0A0" opacity={0.9} />
      <rect x={orbitIdx % 2 === 0 ? 7 : 3} y={-2} width={1} height={1} fill="#FFD166" opacity={0.65} />
    </>
  ) : null;

  // ── Happy sparkles (small bursts in corners) ─────────────────────────────
  const happySparkles = mode === 'happy' ? (
    <>
      <rect x={0}  y={3} width={1} height={1} fill="#FFD166" opacity={0.8} />
      <rect x={11} y={3} width={1} height={1} fill="#FFD166" opacity={0.8} />
      <rect x={1}  y={1} width={1} height={1} fill="#FFF0A0" opacity={0.6} />
      <rect x={10} y={1} width={1} height={1} fill="#FFF0A0" opacity={0.6} />
    </>
  ) : null;

  const flameFlicker = FIRE_FLICKER_FRAMES[flareIdx % FIRE_FLICKER_FRAMES.length];
  const emberTrail = EMBER_FRAMES[flareIdx % EMBER_FRAMES.length];
  const accentOpacity =
    mode === 'error' ? 0.55 :
    mode === 'thinking' ? 0.9 :
    mode === 'excited' ? 1 :
    mode === 'happy' ? 0.95 :
    0.78;

  // ── Error flicker: dim the top of the flame ──────────────────────────────
  // (achieved by CSS animation + reduced core brightness)

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width={W * pixelScale}
      height={H * pixelScale}
      style={{ imageRendering: 'pixelated', display: 'block', overflow: 'visible' }}
    >
      <g
        style={{
          transformBox: 'fill-box',
          transformOrigin: 'center bottom',
          animation: flameAnim,
        }}
      >
        {/* Detached side licks keep the ember from reading as one solid mass. */}
        {flameFlicker.map((p, i) => (
          <rect
            key={`a${i}`}
            x={p.x}
            y={p.y}
            width={1}
            height={1}
            fill={mode === 'error' && p.fill === '#FFF0A0' ? '#FF8C42' : p.fill}
            opacity={(p.opacity ?? 1) * accentOpacity}
          />
        ))}

        {/* Flame body */}
        {GRID.flatMap((row, ry) =>
          row.map((c, cx) => {
            if (c === 0 || isEyePixel(cx, ry)) return null;
            // In error mode, dim the bright core pixels
            const fill = mode === 'error' && c >= 5 ? FLAME[4] : FLAME[c];
            return <rect key={`f${ry}-${cx}`} x={cx} y={ry} width={1} height={1} fill={fill} />;
          })
        )}

        {/* Eyes */}
        {[...leftPx, ...rightPx].map((p, i) => (
          <rect
            key={`e${i}`}
            x={p.x}
            y={p.y}
            width={1}
            height={1}
            fill={p.fill}
            opacity={p.opacity}
          />
        ))}

        {sparks}
        {happySparkles}
        {mode !== 'error' &&
          emberTrail.map((p, i) => (
            <rect
              key={`r${i}`}
              x={p.x}
              y={p.y}
              width={1}
              height={1}
              fill={p.fill}
              opacity={p.opacity}
            />
          ))}
      </g>
    </svg>
  );
}
