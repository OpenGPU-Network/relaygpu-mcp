import pkg from "../package.json" with { type: "json" };

/** The package version, inlined from package.json at build time — never hand-edited. */
export const VERSION: string = pkg.version;
