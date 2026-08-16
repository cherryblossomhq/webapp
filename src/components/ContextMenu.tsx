import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export interface MenuItem {
  label?: string;
  icon?: string;
  action?: () => void;
  divider?: boolean;
  disabled?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

/** Gap kept between the menu and the viewport edge when it has to be nudged. */
const EDGE_MARGIN = 8;

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  // Starts at the raw anchor and is corrected before paint. The menu is `fixed`
  // in a shell that never scrolls, so a menu opened near the right or bottom
  // edge used to hang off-screen with no way to reach the clipped items.
  const [position, setPosition] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    // Measured, not estimated: item count and label length both move these.
    const { width, height } = el.getBoundingClientRect();
    const maxLeft = window.innerWidth - width - EDGE_MARGIN;
    const maxTop = window.innerHeight - height - EDGE_MARGIN;
    setPosition({
      left: Math.max(EDGE_MARGIN, Math.min(x, maxLeft)),
      top: Math.max(EDGE_MARGIN, Math.min(y, maxTop)),
    });
  }, [x, y, items]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node))
        onClose();
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // The menu is anchored to a point that was measured once, so anything that
    // moves the world under it leaves it pointing at nothing: a resize (or a
    // phone rotating) shifts the target, and a blur means the next click lands
    // in another window entirely and never reaches handleClickOutside.
    const handleDismiss = () => onClose();
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    window.addEventListener("resize", handleDismiss);
    window.addEventListener("blur", handleDismiss);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
      window.removeEventListener("resize", handleDismiss);
      window.removeEventListener("blur", handleDismiss);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      style={{ top: position.top, left: position.left }}
      className="fixed z-50 min-w-36 max-w-[calc(100vw-1rem)] rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 animate-in fade-in-0 zoom-in-95 duration-100"
    >
      {items.map((item, idx) =>
        item.divider ? (
          <div key={idx} className="h-px bg-border mx-1 my-1" />
        ) : (
          <button
            key={idx}
            disabled={item.disabled}
            onClick={() => {
              if (!item.disabled && item.action) {
                item.action();
                onClose();
              }
            }}
            className={cn(
              "relative flex w-full cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none transition-colors",
              // Rows are full-width so they're easy to hit horizontally; 30px is
              // the part that isn't, and the menu sizes to its own content.
              "pointer-coarse:min-h-11 pointer-coarse:px-3",
              "hover:bg-accent hover:text-accent-foreground",
              "disabled:pointer-events-none disabled:opacity-50"
            )}
          >
            {item.icon && (
              <span className="text-primary min-w-4 text-center">
                {item.icon}
              </span>
            )}
            {item.label}
          </button>
        )
      )}
    </div>
  );
}
