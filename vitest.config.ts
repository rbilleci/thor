import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["packages/*/src/**/*.ts"],
    },
    passWithNoTests: false,
    exclude: ["**/dist/**", "dist-tests/**", "node_modules/**"],
    restoreMocks: true,
    testTimeout: 30_000,
  },
});
