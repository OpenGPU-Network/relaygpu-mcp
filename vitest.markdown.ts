// Vite plugin: a `.md` import is its text, as tsup's `.md` text loader builds it into dist.
import type { Plugin } from "vite";

export const markdownText = (): Plugin => ({
  name: "markdown-text",
  enforce: "pre",
  transform(code, id) {
    if (id.endsWith(".md")) return { code: `export default ${JSON.stringify(code)};`, map: null };
  },
});
