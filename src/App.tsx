import { Component, type ReactNode } from "react";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/hooks/useTheme";
import { EditorView } from "@/views/EditorView";
import { useIsCompact } from "@/hooks/useViewport";

// Top-level error boundary to catch render crashes
class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      // The shell is `overflow: hidden`, so this needs its own scroll container
      // or a stack trace longer than the viewport is unreadable — and
      // `break-words` keeps minified frames from widening the page sideways.
      return (
        <div className="h-full overflow-auto p-6 font-mono text-sm sm:p-10">
          <h1 className="text-lg font-semibold text-destructive">App Crash</h1>
          <pre className="mt-4 whitespace-pre-wrap break-words">
            {this.state.error.message}
          </pre>
          <pre className="mt-2 whitespace-pre-wrap break-words opacity-60">
            {this.state.error.stack}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const isCompact = useIsCompact();

  return (
    <ErrorBoundary>
      <ThemeProvider>
        <TooltipProvider>
          <EditorView />
          {/* A bottom-right toast is a cramped sliver on a phone. Centre it and
              lift it clear of the home indicator. */}
          <Toaster
            richColors
            position={isCompact ? "bottom-center" : "bottom-right"}
            offset={isCompact ? "calc(0.75rem + var(--safe-bottom))" : undefined}
          />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
