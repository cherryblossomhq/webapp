import { Component, type ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import { log } from "@/utils/logger";

interface Props {
  children: ReactNode;
  // Human label for the panel — shown in the fallback UI ("Properties panel crashed")
  label: string;
}

interface State {
  error: Error | null;
}

// Scoped error boundary so a render error in one panel doesn't blank the whole
// app. The user sees a small inline crash card and can retry without reloading.
export class PanelErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }): void {
    log.error(`[panel:${this.props.label}] crashed:`, error, info);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <div className="flex-1 flex items-center justify-center p-4 bg-background">
          <div className="max-w-xs text-center">
            <div className="size-9 rounded-lg bg-destructive/10 flex items-center justify-center mx-auto mb-2">
              <AlertCircle className="size-4 text-destructive" />
            </div>
            <p className="text-sm font-medium text-foreground mb-1">
              {this.props.label} crashed
            </p>
            <p className="text-[11px] text-muted-foreground mb-3 font-mono leading-relaxed break-words">
              {this.state.error.message}
            </p>
            <button
              type="button"
              onClick={this.reset}
              className="px-3 py-1 text-[11px] font-medium rounded-md border border-border bg-background hover:bg-accent transition-colors"
            >
              Retry
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
