import { Component, useEffect, type ReactNode } from "react";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/hooks/useTheme";
import { EditorView } from "@/views/EditorView";
import { useAuthStore } from "@/store/authStore";

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
      return (
        <div style={{ padding: 40, fontFamily: "monospace" }}>
          <h1 style={{ color: "red" }}>App Crash</h1>
          <pre style={{ whiteSpace: "pre-wrap", marginTop: 16 }}>
            {this.state.error.message}
          </pre>
          <pre style={{ whiteSpace: "pre-wrap", marginTop: 8, opacity: 0.6 }}>
            {this.state.error.stack}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  // Restore the WorkOS session (if any) once on launch.
  useEffect(() => {
    void useAuthStore.getState().init();
  }, []);

  return (
    <ErrorBoundary>
      <ThemeProvider>
        <TooltipProvider>
          <EditorView />
          <Toaster richColors position="bottom-right" />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
