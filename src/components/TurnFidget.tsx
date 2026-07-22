import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import styles from "./TurnFidget.module.css";

const DOTS = Array.from({ length: 9 }, (_, i) => i);

// Isolated so the 100ms tick only re-renders this tiny readout, never the
// streaming message trail above it.
function ElapsedTime() {
  const start = useRef(Date.now());
  const [now, setNow] = useState(start.current);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="text-xs tabular-nums">
      {((now - start.current) / 1000).toFixed(1)}s
    </span>
  );
}

// "An AI turn is in flight" fidget — not tied to reasoning specifically: a
// 3×3 dot matrix flickering pseudo-randomly plus an elapsed-time counter. It
// covers the dead air the activity trail can't — waiting on first tokens,
// tool round-trips — so it stays mounted from send until the turn settles.
export function TurnFidget({ className }: { className?: string }) {
  return (
    <div
      role="status"
      aria-label="Assistant is working"
      className={cn("flex items-center gap-2 text-muted-foreground", className)}
    >
      <span className={styles.matrix} aria-hidden="true">
        {DOTS.map((i) => (
          <span key={i} className={styles.dot} />
        ))}
      </span>
      <ElapsedTime />
    </div>
  );
}
