import { defineConfig } from "vitest/config";
import { markdownText } from "./vitest.markdown.js";

export default defineConfig({
  plugins: [markdownText()],
  test: {
    testTimeout: 20_000,
  },
});
