// InstaBox sandbox lifecycle net (skills/instabox-sandbox). Sandboxes created
// by an agent turn are tagged with the owning session via
// `instabox create … --meta nm-session=$NM_SESSION_ID` (the shell tool exports
// the variable). When the session's turn completes, the harness sweeps any
// sandboxes still tagged with that session and removes them — a forgotten
// sandbox would otherwise hold one of the plan's 5 machine slots and burn
// runtime. Best-effort by design: missing CLI, network errors or malformed
// output are swallowed (never break a turn); boxes created without the tag
// (manual warm boxes) are invisible to the sweep.

import { execFile } from "node:child_process";

type Runner = (
  file: string,
  args: string[],
  cb: (err: Error | null, stdout: string, stderr?: string) => void,
) => void;

let runner: Runner = (file, args, cb) => execFile(file, args, { timeout: 30_000 }, cb);

/** Test seam: replace the exec runner. */
export function setInstaboxRunner(fn: Runner | null): void {
  runner = fn ?? ((file, args, cb) => execFile(file, args, { timeout: 30_000 }, cb));
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    runner(file, args, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

function parseIds(json: string): string[] {
  try {
    const start = json.indexOf("[");
    const doc = JSON.parse(json.slice(json.indexOf("{", 0) >= 0 && start === -1 ? 0 : start));
    const arr = Array.isArray(doc) ? doc : Array.isArray(doc.machines) ? doc.machines : [];
    return arr
      .map((m: Record<string, unknown>) => String(m.id ?? m.machine_id ?? ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Remove every sandbox meta-tagged `nm-session=<sessionId>`. Fire-and-forget
 *  safe: resolves [] even when the CLI is missing or the API is unreachable. */
export async function cleanupSessionSandboxes(sessionId: string): Promise<string[]> {
  if (!sessionId) return [];
  const meta = `nm-session=${sessionId}`;
  let listing: string;
  try {
    listing = await run("instabox", ["ls", "--meta", meta, "--json"]);
  } catch {
    return []; // CLI absent (dev boxes) or transient failure — nothing to do
  }
  const ids = parseIds(listing);
  const removed: string[] = [];
  for (const id of ids) {
    try {
      await run("instabox", ["rm", id, "--no-wait"]);
      removed.push(id);
    } catch {
      /* keep sweeping the rest */
    }
  }
  return removed;
}
