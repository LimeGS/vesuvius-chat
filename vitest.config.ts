import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["{app,lib}/**/*.{ts,tsx,mts}", "proxy.ts"],
      exclude: ["**/*.d.ts", "**/*.d.mts"],
      reporter: ["text", "html", "json-summary", "lcov"],
      thresholds: { lines: 90, statements: 90, branches: 90, functions: 90 },
    },
  },
});
