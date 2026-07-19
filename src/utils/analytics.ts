import posthog from "posthog-js";

const projectToken = import.meta.env.VITE_POSTHOG_PROJECT_TOKEN;

// Keep analytics optional so local builds and forks work without Doppler.
// Production requests use the same-origin /ingest reverse proxy configured in
// vercel.json; Vite mirrors those rewrites for dev and preview.
if (typeof window !== "undefined" && projectToken) {
  posthog.init(projectToken, {
    api_host: "/ingest",
    ui_host: import.meta.env.VITE_POSTHOG_HOST ?? "https://us.posthog.com",
    defaults: "2026-01-30",
    capture_exceptions: true,
    debug: import.meta.env.DEV,
  });
}
