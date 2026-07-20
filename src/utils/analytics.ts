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
