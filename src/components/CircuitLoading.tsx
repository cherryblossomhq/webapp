import { cn } from "@/lib/utils";
import styles from "./CircuitLoading.module.css";

// The four trace routes, drawn chip-outward with 45° bends like real PCB
// routing. Each is rendered twice: once as the self-drawing copper trace and
// once as the overlay path the glowing pulse travels along.
const TRACES = [
  "M64 50 L48 50 L40 42 L22 42",
  "M96 60 L112 60 L120 68 L138 68",
  "M74 69 L74 80 L66 88 L36 88",
  "M86 41 L86 30 L94 22 L126 22",
];

// SMD pads at each trace end, as [x, y] of the 8×8 rect.
const PADS: Array<[number, number]> = [
  [18, 38],
  [134, 64],
  [32, 84],
  [122, 18],
];

// Vias at two of the 45° bends.
const VIAS: Array<[number, number]> = [
  [40, 42],
  [120, 68],
];

const MOUNTING_HOLES: Array<[number, number]> = [
  [16, 16],
  [144, 16],
  [16, 94],
  [144, 94],
];

/**
 * Branded loading state: a little PCB that routes itself — traces draw in,
 * pads light up as each trace lands, then a glowing pulse runs the trace.
 * Drop-in replacement for the spinner+label loading placeholders.
 */
export function CircuitLoading({
  label,
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cn(
        "flex flex-col items-center gap-3 text-muted-foreground",
        className,
      )}
    >
      <svg
        viewBox="0 0 160 110"
        width={200}
        height={138}
        aria-hidden="true"
        className="overflow-visible"
      >
        {/* Static substrate: board outline, mounting holes, chip. Kept outside
            the fading copper group so the board never blinks between cycles. */}
        <g className="text-border" stroke="currentColor" fill="none">
          <rect x={6} y={6} width={148} height={98} rx={8} strokeWidth={1.5} />
          {MOUNTING_HOLES.map(([cx, cy]) => (
            <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={2.5} strokeWidth={1} />
          ))}
        </g>
        <g className="text-muted-foreground" stroke="currentColor" fill="none">
          <rect x={64} y={41} width={32} height={28} rx={3} strokeWidth={1.5} />
          <circle cx={70} cy={47} r={1.5} fill="currentColor" stroke="none" />
        </g>

        {/* Copper: everything that draws in, pulses, then fades out. */}
        <g className={styles.copper}>
          <g className="text-muted-foreground/60">
            {TRACES.map((d, i) => (
              <path
                key={d}
                d={d}
                pathLength={100}
                className={cn(styles.trace, styles[`trace${i + 1}`])}
              />
            ))}
          </g>
          {VIAS.map(([cx, cy], i) => (
            <circle
              key={`${cx}-${cy}`}
              cx={cx}
              cy={cy}
              r={2.5}
              className={cn(
                "fill-background stroke-muted-foreground",
                styles.via,
                styles[`via${i + 1}`],
              )}
              strokeWidth={1.5}
            />
          ))}
          {PADS.map(([x, y], i) => (
            <rect
              key={`${x}-${y}`}
              x={x}
              y={y}
              width={8}
              height={8}
              rx={2}
              className={cn(styles.pad, styles[`pad${i + 1}`])}
            />
          ))}
          {TRACES.map((d, i) => (
            <path
              key={`pulse-${d}`}
              d={d}
              pathLength={100}
              className={cn(styles.pulse, styles[`pulse${i + 1}`])}
            />
          ))}
        </g>
      </svg>
      {label ? <p className="text-sm font-medium">{label}</p> : null}
    </div>
  );
}

