// Builds relay-<version>.mcpb, the Claude Desktop one-click bundle: the stdio server bundled into one file (no
// node_modules, no npx, no PATH lookup: Claude Desktop runs it with its own Node), the manifest stamped with the
// package version, the icon. Output: build/relay-<version>.mcpb (and build/relay.mcpb, the stable release-asset name).
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { build } from "tsup";

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const dir = "build/mcpb";
await rm("build", { recursive: true, force: true });
await mkdir(dir, { recursive: true });

await build({
  entry: { index: "src/stdio.ts" },
  outDir: `${dir}/server`,
  format: ["esm"],
  platform: "node",
  target: "node20",
  noExternal: [/.*/],
  splitting: false,
  clean: true,
  dts: false,
  silent: true,
});
await writeFile(`${dir}/package.json`, JSON.stringify({ type: "module" }) + "\n");

const manifest = JSON.parse(await readFile("mcpb/manifest.json", "utf8"));
manifest.version = pkg.version;
await writeFile(`${dir}/manifest.json`, JSON.stringify(manifest, null, 2) + "\n");
await cp("mcpb/icon.png", `${dir}/icon.png`);

const out = `build/relay-${pkg.version}.mcpb`;
execFileSync("npx", ["--no-install", "mcpb", "pack", dir, out], { stdio: "inherit" });
await cp(out, "build/relay.mcpb");
console.log(`built ${out} and build/relay.mcpb`);
