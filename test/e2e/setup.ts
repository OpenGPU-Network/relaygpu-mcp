// e2e setup (vitest setupFiles): load the SDK test account's .env (never echoed), then refuse production.
// RELAY_E2E_NO_DOTENV=1 skips the .env load (proves the skip path with the credentials unset).
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ENV_FILE = fileURLToPath(new URL("../../.env", import.meta.url));

function loadEnv(path: string): void {
  const native = (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile;
  if (native) return native.call(process, path);
  // Node < 20.12: minimal KEY=VALUE reader, existing variables win (as loadEnvFile does).
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

if (process.env.RELAY_E2E_NO_DOTENV !== "1" && existsSync(ENV_FILE)) loadEnv(ENV_FILE);

const PROD_HOST = /(^|\.)(relaygpu\.com|relay\.opengpu\.network)$/i;
const base = process.env.RELAY_BASE_URL;
if (base) {
  let host: string;
  try {
    host = new URL(base).hostname;
  } catch {
    throw new Error("e2e refused: RELAY_BASE_URL is not a URL");
  }
  if (PROD_HOST.test(host)) throw new Error("e2e refused: RELAY_BASE_URL points at production; the e2e suite runs against staging only");
}
