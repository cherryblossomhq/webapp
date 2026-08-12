import { useEffect } from "react";

/** Keeps the browser tab title in sync with the currently-open project. */
export function useWindowTitle(projectTitle: string) {
  useEffect(() => {
    document.title = `${projectTitle} — Cherry Blossom`;
  }, [projectTitle]);
}
