import { useState, useEffect, useRef } from "react";
import { useCircuitStore } from "@/store/circuitStore";

const DEBOUNCE_MS = 200;

export function useCircuitRenderer() {
  const tsxCode = useCircuitStore((s) => s.tsxCode);

  const [debouncedTsx, setDebouncedTsx] = useState(() => tsxCode);
  const [isGenerating, setIsGenerating] = useState(false);

  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    setIsGenerating(true);

    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    timerRef.current = setTimeout(() => {
      setDebouncedTsx(tsxCode);
      setIsGenerating(false);
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [tsxCode]);

  return {
    tsx: debouncedTsx,
    isGenerating,
  };
}
