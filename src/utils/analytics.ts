import posthog, { type PostHogInterface } from "posthog-js";

const projectToken = import.meta.env.VITE_POSTHOG_PROJECT_TOKEN;

export function initPostHog(loaded: (instance: PostHogInterface) => void) {
  // Keep analytics optional so local builds and forks work without Doppler.
  if (typeof window === "undefined" || !projectToken) return;

  if (posthog.__loaded) {
    loaded(posthog);
    return;
  }

  posthog.init(projectToken, {
    api_host: "/ingest",
    ui_host: import.meta.env.VITE_POSTHOG_HOST ?? "https://us.posthog.com",
    defaults: "2026-01-30",
    capture_exceptions: true,
    debug: import.meta.env.DEV,
    loaded,
  });
}

/**
 * The browser's current PostHog distinct id, or undefined when PostHog is
 * unavailable (no token, blocked, not yet initialized) or holds no id. Sent as
 * `X-Posthog-Distinct-Id` on managed AI requests so the server's
 * `$ai_generation` events join this browser's person profile — never an empty
 * value, and never a thrown error.
 */
export function getPostHogDistinctId(): string | undefined {
  try {
    if (!posthog.__loaded) return undefined;
    const id = posthog.get_distinct_id();
    return typeof id === "string" && id !== "" ? id : undefined;
  } catch {
    return undefined;
  }
}
