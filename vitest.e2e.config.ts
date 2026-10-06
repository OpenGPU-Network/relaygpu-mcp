import { defineConfig } from "vitest/config";

// e2e against staging: serial files, long timeouts (a Kling video is polled up to ~6 min).
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.test.ts"],
    setupFiles: ["test/e2e/setup.ts"],
    fileParallelism: false,
    testTimeout: 420_000,
    hookTimeout: 180_000,
  },
});
