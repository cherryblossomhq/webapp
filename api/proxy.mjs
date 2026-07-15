// Vercel serverless mount of the shared proxy handler. Dev/preview use the
// same handler via a Vite middleware (see vite.config.ts).
export { default } from "../server/proxy.mjs";
