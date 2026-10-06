import { readFile, writeFile, chmod } from "node:fs/promises";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts", "src/stdio.ts", "src/http.ts"],
  format: ["esm"],
  target: "node18",
  dts: { entry: "src/server.ts" },
  clean: true,
  splitting: true,
  // dist/stdio.js is the package bin: give it a shebang and the exec bit.
  async onSuccess() {
    const bin = "dist/stdio.js";
    const src = await readFile(bin, "utf8");
    if (!src.startsWith("#!")) await writeFile(bin, "#!/usr/bin/env node\n" + src);
    await chmod(bin, 0o755);
  },
});
