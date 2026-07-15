/**
 * useContextMenu: Manage context menu state and position
 */

import { useState, useCallback } from "react";

export interface ContextMenuState {
  isOpen: boolean;
  x: number;
  y: number;
  target?: string; // ID of the component/wire being right-clicked
  targetType?: "component" | "wire"; // Distinguish between component and wire
}

export function useContextMenu() {
  const [menu, setMenu] = useState<ContextMenuState>({
    isOpen: false,
    x: 0,
    y: 0,
  });

  const openMenu = useCallback(
    (x: number, y: number, target?: string, targetType?: "component" | "wire") => {
      setMenu({ isOpen: true, x, y, target, targetType });
    },
    []
  );

  const closeMenu = useCallback(() => {
    setMenu((prev) => ({ ...prev, isOpen: false }));
  }, []);

  return { menu, openMenu, closeMenu };
}
