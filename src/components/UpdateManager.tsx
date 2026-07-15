import { useEffect } from "react";
import { toast } from "sonner";
import {
  ArrowUpCircleIcon,
  CircleCheckIcon,
  Loader2Icon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUpdaterStore, type UpdatePhase } from "@/store/updaterStore";
import { useWhatsNewStore } from "@/store/whatsNewStore";

// Delay the startup check so it never competes with the heavy tscircuit bundle
// load or slow the first paint.
const STARTUP_CHECK_DELAY_MS = 4000;

// Stable id so every phase transition (available → downloading → ready) updates
// the same toast in place rather than stacking new ones.
const UPDATE_TOAST_ID = "app-update";

/**
 * Mounted once at the app root. Surfaces updates as a persistent bottom-right
 * toast (driven entirely by the updater store's `phase`) and kicks off the
 * silent startup check.
 *
 * The toast never auto-dismisses — it stays until the user explicitly discards
 * it — and, unlike the old modal, never steals focus from the canvas.
 *
 * The startup check only runs in packaged production builds — never in
 * `npm run dev` / `dev:web`, where `import.meta.env.PROD` is false.
 */
export function UpdateManager() {
  const phase = useUpdaterStore((s) => s.phase);
  const currentVersion = useUpdaterStore((s) => s.currentVersion);
  const newVersion = useUpdaterStore((s) => s.newVersion);
  const progress = useUpdaterStore((s) => s.progress);

  useEffect(() => {
    const loadVersion = useUpdaterStore.getState().loadVersion;
    void loadVersion();

    // Shares the startup version lifecycle: surfaces the one-time "What's New"
    // tab when the installed version changed since the last launch.
    void useWhatsNewStore.getState().init();

    if (!import.meta.env.PROD) return;
    const checkForUpdates = useUpdaterStore.getState().checkForUpdates;
    const timer = setTimeout(() => {
      void checkForUpdates({ silent: true });
    }, STARTUP_CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  // Render (and live-update) the toast straight from the store's phase.
  useEffect(() => {
    if (phase === null) {
      toast.dismiss(UPDATE_TOAST_ID);
      return;
    }

    const { startDownload, restartNow, dismiss } = useUpdaterStore.getState();

    toast.custom(
      () => (
        <UpdateToast
          phase={phase}
          currentVersion={currentVersion}
          newVersion={newVersion}
          progress={progress}
          onUpdate={() => void startDownload()}
          onRestart={() => void restartNow()}
          onDismiss={dismiss}
        />
      ),
      {
        id: UPDATE_TOAST_ID,
        duration: Infinity,
        // Only our own discard button removes it — no swipe / outside dismissal,
        // and nothing auto-closes it mid-download.
        dismissible: false,
      }
    );
  }, [phase, progress, currentVersion, newVersion]);

  return null;
}

interface UpdateToastProps {
  phase: UpdatePhase;
  currentVersion: string;
  newVersion: string | null;
  progress: number;
  onUpdate: () => void;
  onRestart: () => void;
  onDismiss: () => void;
}

function UpdateToast({
  phase,
  currentVersion,
  newVersion,
  progress,
  onUpdate,
  onRestart,
  onDismiss,
}: UpdateToastProps) {
  const percent = Math.round(progress * 100);
  const dismissible = phase !== "downloading";

  const { icon, title, description } = (() => {
    switch (phase) {
      case "available":
        return {
          icon: <ArrowUpCircleIcon className="size-4" />,
          title: "Update available",
          description: `Cherry Blossom v${newVersion} is available. You're on v${currentVersion}.`,
        };
      case "downloading":
        return {
          icon: <Loader2Icon className="size-4 animate-spin" />,
          title: "Downloading update…",
          description: `Fetching Cherry Blossom v${newVersion}. This won't take long.`,
        };
      case "ready":
        return {
          icon: <CircleCheckIcon className="size-4" />,
          title: "Update ready",
          description: `Cherry Blossom v${newVersion} is installed. Restart to start using it.`,
        };
    }
  })();

  return (
    <div className="flex w-full flex-col gap-3 rounded-xl border border-border bg-popover p-3.5 text-popover-foreground shadow-lg">
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          {icon}
        </div>
        <div className="flex flex-1 flex-col gap-0.5">
          <p className="text-sm font-medium leading-tight">{title}</p>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        {dismissible && (
          <Button
            variant="ghost"
            size="icon-xs"
            className="-mt-1 -mr-1 text-muted-foreground"
            onClick={onDismiss}
            aria-label="Dismiss"
          >
            <XIcon />
          </Button>
        )}
      </div>

      {phase === "downloading" && (
        <div className="flex flex-col gap-1.5">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-150"
              style={{ width: `${percent}%` }}
            />
          </div>
          <span className="text-xs text-muted-foreground tabular-nums">
            {percent}%
          </span>
        </div>
      )}

      {phase === "available" && (
        <div className="flex justify-end">
          <Button size="sm" onClick={onUpdate}>
            Update now
          </Button>
        </div>
      )}

      {phase === "ready" && (
        <div className="flex justify-end">
          <Button size="sm" onClick={onRestart}>
            Restart now
          </Button>
        </div>
      )}
    </div>
  );
}
