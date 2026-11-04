import { fileURLToPath } from "node:url"
import { defineConfig, type Plugin } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { themeScript } from "./src/store/themeScript"

/**
 * The packages the editor imports from the hosted app's monorepo, answered here
 * from `host/`: stand-ins for the wire types and the model roster, and a copy of
 * the change format live editing runs on. `vitest.config.ts` and `tsconfig.json`
 * carry the same map.
 */
export const hostAliases = {
  "@cherryblossom/api-contract": fileURLToPath(new URL("./host/contract.ts", import.meta.url)),
  "@cherryblossom/ai-models": fileURLToPath(new URL("./host/ai-models.ts", import.meta.url)),
  "@cherryblossom/project-changes": fileURLToPath(new URL("./host/project-changes.ts", import.meta.url)),
}

/** Sets the theme before first paint, so a dark-mode visitor never sees a light flash. */
function themeBeforePaint(): Plugin {
  return {
    name: "cherryblossom-theme-script",
    transformIndexHtml: () => [{ tag: "script", children: themeScript, injectTo: "head" }],
  }
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), themeBeforePaint()],
  resolve: { alias: hostAliases },
  // The editor is written to be bundled by any host, and reads `process.env.NODE_ENV` rather than
  // `import.meta.env`. Mode-aware, so a production build never ships the development hook.
  define: {
    "process.env.NODE_ENV": JSON.stringify(mode === "production" ? "production" : "development"),
  },
  worker: { format: "es" },
  // The workers (`new Worker(new URL(...))`) are invisible to the dependency scan, so the first
  // STEP file or Tidy in a fresh dev server would find their dependencies late, re-optimise, and
  // lose the worker's request to a stale chunk.
  optimizeDeps: { entries: ["index.html", "src/**/*.worker.ts"] },
  build: {
    target: "es2022",
    // three.js and the STEP reader are big on their own; both load lazily with the 3D view.
    chunkSizeWarningLimit: 2000,
  },
}))
