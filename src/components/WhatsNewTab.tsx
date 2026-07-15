import { useCallback, useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useWhatsNewStore } from "@/store/whatsNewStore";
import { openExternal } from "@/utils/openExternal";

marked.setOptions({ breaks: true, gfm: true });

// The post-update release notes, rendered as an editor tab (see EditorShell).
// Mirrors the chat panel's marked + DOMPurify + `prose-chat` markdown pipeline.
export function WhatsNewTab() {
  const version = useWhatsNewStore((s) => s.version);
  const notes = useWhatsNewStore((s) => s.notes);
  const status = useWhatsNewStore((s) => s.status);
  const retry = useWhatsNewStore((s) => s.retry);

  const html = useMemo(() => {
    if (!notes) return "";
    const raw = marked.parse(notes) as string;
    return DOMPurify.sanitize(raw, { ADD_ATTR: ["class"] });
  }, [notes]);

  const hasNotes = status === "ready" && html.length > 0;

  // Release bodies can contain links (PRs, docs). Intercept clicks so they open
  // in the system browser instead of navigating the app's webview away.
  const handleLinkClick = useCallback((e: React.MouseEvent<HTMLElement>) => {
    const anchor = (e.target as HTMLElement).closest("a");
    const href = anchor?.getAttribute("href");
    if (!href) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(href)) openExternal(href);
  }, []);

  return (
    <div className="absolute inset-0 overflow-auto bg-background">
      <div className="mx-auto flex max-w-2xl flex-col gap-6 px-8 py-10">
        <header className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-primary">
            <Sparkles className="size-5" />
            <h1 className="font-heading text-xl font-semibold leading-none">
              What's New
            </h1>
          </div>
          {version && (
            <p className="text-sm text-muted-foreground">
              You've updated to Cherry Blossom{" "}
              <span className="font-medium text-foreground">v{version}</span>.
              Here's what changed.
            </p>
          )}
        </header>

        {status === "loading" && (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading release notes…
          </div>
        )}

        {hasNotes && (
          <article
            className="text-sm text-foreground prose-chat"
            onClick={handleLinkClick}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}

        {/* Empty notes (release exists but no body) or a failed/absent release. */}
        {(status === "error" || (status === "ready" && !hasNotes)) && (
          <div className="flex flex-col items-start gap-3 py-4">
            <p className="text-sm text-muted-foreground">
              {status === "error"
                ? "Couldn't load the release notes right now."
                : "Release notes aren't available for this version yet."}
            </p>
            {status === "error" && (
              <Button variant="outline" size="sm" onClick={() => void retry()}>
                Try again
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
