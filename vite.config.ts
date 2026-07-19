import path from "path";
import { readFileSync } from "fs";
import { defineConfig, type Plugin, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// The same handler Vercel mounts as the /api/proxy function in production —
// one implementation for dev, preview, and deploy.
import handleProxyRequest from "./server/proxy.mjs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

// Serve /api/proxy from the dev + preview servers, mirroring the deployed
// serverless function (see api/proxy.mjs).
function proxyEndpoint(): Plugin {
  return {
    name: "cherryblossom-proxy-endpoint",
    configureServer(server) {
      server.middlewares.use("/api/proxy", handleProxyRequest);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/api/proxy", handleProxyRequest);
    },
  };
}

// Match the marketing site's first-party PostHog proxy. Specific asset routes
// must precede the catch-all ingest route because Vite uses the first match.
const posthogProxy: Record<string, ProxyOptions> = {
  "/ingest/static": {
    target: "https://us-assets.i.posthog.com",
    changeOrigin: true,
    rewrite: (requestPath) => requestPath.replace(/^\/ingest/, ""),
  },
  "/ingest/array": {
    target: "https://us-assets.i.posthog.com",
    changeOrigin: true,
    rewrite: (requestPath) => requestPath.replace(/^\/ingest/, ""),
  },
  "/ingest": {
    target: "https://us.i.posthog.com",
    changeOrigin: true,
    rewrite: (requestPath) => requestPath.replace(/^\/ingest/, ""),
  },
};

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), proxyEndpoint()],

  // preview.proxy inherits server.proxy, so this covers both local servers.
  server: { proxy: posthogProxy },

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Force all React imports to the top-level copy to prevent
      // version conflicts from nested dependencies (e.g. tscircuit packages)
      react: path.resolve(__dirname, "./node_modules/react"),
      "react-dom": path.resolve(__dirname, "./node_modules/react-dom"),
      "react/jsx-runtime": path.resolve(__dirname, "./node_modules/react/jsx-runtime"),
      "react/jsx-dev-runtime": path.resolve(__dirname, "./node_modules/react/jsx-dev-runtime"),
    },
  },

  define: {
    // Mode-aware: this top-level define applies to `vite build` too, and an
    // explicit NODE_ENV here overrides Vite's per-mode default — hardcoding
    // "development" would ship dev-mode React in the production bundle.
    "process.env.NODE_ENV": JSON.stringify(
      mode === "production" ? "production" : "development"
    ),
    "process.env": "{}",
    __APP_VERSION__: JSON.stringify(pkg.version),
  },

  // Pre-bundle the deps the schematic editor + tsx parsing need at startup.
  // Heavy packages used only by lazy-loaded routes (eval, pcb-viewer, 3d-viewer)
  // are intentionally NOT included here so dev boot stays fast — they get
  // bundled on demand the first time the user touches a tab that needs them.
  optimizeDeps: {
    include: [
      "@tscircuit/props",
      "schematic-symbols",
      "recast",
      "@babel/traverse",
      "@babel/types",
      "@babel/parser",
    ],
    esbuildOptions: {
      define: {
        "process.env.NODE_ENV": JSON.stringify("development"),
        "process.env": "{}",
      },
    },
  },

  // Suppress the large chunk size warning (tscircuit is a big library)
  build: {
    chunkSizeWarningLimit: 10000,
  },
}));
