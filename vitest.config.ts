import { defineConfig } from "vitest/config"
import { hostAliases } from "./vite.config"

export default defineConfig({
  resolve: { alias: hostAliases },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Building an example routes it, which takes seconds for the ESP32 robot on a laptop and
    // several times that on a shared CI runner.
    testTimeout: 120_000,
  },
})
