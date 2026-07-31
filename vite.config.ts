import path from "path";
import { readFileSync } from "fs";
import { createRequire } from "module";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// The /api/proxy handler, mounted into the dev and preview servers.
import handleProxyRequest from "./server/proxy.mjs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

// Resolve React through Node rather than a hardcoded ./node_modules path, so a
// hoisted install (npm workspaces, pnpm) resolves the same single copy.
const require = createRequire(import.meta.url);
const reactDir = path.dirname(require.resolve("react/package.json"));
const reactDomDir = path.dirname(require.resolve("react-dom/package.json"));

// Serve /api/proxy from the dev + preview servers.
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

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), proxyEndpoint()],

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Force all React imports to the top-level copy to prevent
      // version conflicts from nested dependencies (e.g. tscircuit packages)
      react: reactDir,
      "react-dom": reactDomDir,
      "react/jsx-runtime": path.join(reactDir, "jsx-runtime"),
      "react/jsx-dev-runtime": path.join(reactDir, "jsx-dev-runtime"),
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
