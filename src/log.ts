// JSON lines on stderr only: on stdio, stdout is the protocol and a stray write breaks the client.
const LEVELS = { debug: 10, info: 20, warning: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

function threshold(): number {
  const raw = (process.env.LOG_LEVEL ?? "warning").toLowerCase();
  return LEVELS[(raw === "warn" ? "warning" : raw) as Level] ?? LEVELS.warning;
}

export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (LEVELS[level] < threshold()) return;
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }) + "\n");
}
