// Skills R2 lifecycle (Phase 2 of the approved C-strategy skills port):
// the nm-skills CLI remains the object-store authority tool; this module
// drives it at the two lifecycle points the agent loop needs:
//   - boot:    `nm-skills sync skills` — pull newest (adopt-unchanged,
//              prune removed) then push any local drift, so the working copy
//              mirrors the bucket before the first session indexes it
//   - curation: debounced `nm-skills push --prune skills` after each OK
//              mutation (skill create/patch/edit/delete/file ops) — tracks
//              agent edits into the bucket without blocking the turn
// Everything degrades: no CLI (uv/nm-skills-registry missing), no
// SKILLS_REGISTRY env, or a failed run → local-only mode with the reason in
// health. The agent loop never depends on the bridge.
//
// Failure semantics: the contract says doctor/pull failures are
// `Rejected:`-grade information (health-visible), never fatal for turns.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { SKILLS_REQUIRED } from "../config.js";
import { log } from "../logger.js";

const REGISTRY_HOME =
  process.env.NM_SKILLS_REGISTRY_HOME?.trim() ||
  path.resolve(process.cwd(), "..", "nm-skills-registry");
const CLI_TIMEOUT_MS = Number(process.env.SKILLS_CLI_TIMEOUT_MS ?? "90000");
const PUSH_DEBOUNCE_MS = Number(process.env.SKILLS_PUSH_DEBOUNCE_MS ?? "5000");

export interface SkillsSyncInfo {
  mode: "s3" | "local";
  registry?: string;
  cliAvailable: boolean;
  /** Resolved CLI transport: `uv:<registry home>` or `binary:<path>`. */
  cli?: string;
  /** SKILL.md files found after the boot pull (fresh-VM preflight). */
  skillCount?: number;
  /** Registry configured but the boot pull failed or yielded zero skills. */
  degraded?: boolean;
  lastSync?: {
    at: string;
    pulled: number;
    removed: number;
    unchanged: number;
    pushed?: number;
    error?: string;
  };
  lastPush?: { at: string; uploaded: number; pruned: number; error?: string };
  pendingPush?: boolean;
  error?: string;
}

/** Thrown when SKILLS_REQUIRED=1 and the boot pull cannot produce a usable
 *  working copy. index.ts turns it into a fatal exit (systemd/docker then
 *  surface the failure instead of serving a skill-less agent). */
export class SkillsRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillsRequiredError";
  }
}

/** Count SKILL.md files under a working copy (same traversal rules as
 *  SkillLibrary: skip dot-dirs, follow no symlinks). */
export function countSkillFiles(root: string): number {
  let count = 0;
  const visit = (dir: string) => {
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (item.name.startsWith(".")) continue;
      const p = path.join(dir, item.name);
      if (item.isDirectory()) visit(p);
      else if (item.isFile() && item.name === "SKILL.md") count++;
    }
  };
  visit(root);
  return count;
}

export class SkillsCliBridge {
  readonly info: SkillsSyncInfo;
  private pushTimer: NodeJS.Timeout | null = null;
  private busy: Promise<unknown> | null = null;
  private queueDrain: (() => void) | null = null;

  constructor(skillsDir?: string) {
    this.skillsDir = path.resolve(skillsDir ?? process.env.SKILLS_DIR ?? "skills");
    const registry = process.env.SKILLS_REGISTRY?.trim();
    if (process.env.SKILLS_CLI_BRIDGE === "0") {
      this.info = { mode: "local", cliAvailable: false, error: "disabled by env" };
    } else if (!registry) {
      this.info = { mode: "local", cliAvailable: false, error: "SKILLS_REGISTRY not set — local skills dir only" };
    } else {
      this.info = { mode: "s3", registry, cliAvailable: true };
    }
    if (this.info.mode === "s3") {
      const explicit = (process.env.SKILLS_CLI ?? "").trim();
      this.info.cli = explicit ? `binary:${explicit}` : `uv:${REGISTRY_HOME}`;
    }
  }

  private skillsDir: string;

  /** `SKILLS_CLI` (a path or binary name) bypasses `uv run --directory` so a
   *  `uv tool install`ed nm-skills can be used on a VM without the source
   *  checkout. Unset = the dev-mode sibling checkout. */
  private cliCommand(args: string[]): { bin: string; argv: string[] } {
    const explicit = (process.env.SKILLS_CLI ?? "").trim();
    if (explicit) return { bin: explicit, argv: args };
    return {
      bin: process.env.UV_BIN || "uv",
      argv: ["run", "--directory", REGISTRY_HOME, "nm-skills", ...args],
    };
  }

  private async runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const { bin, argv } = this.cliCommand(args);
      const child = execFile(
        bin,
        argv,
        { timeout: CLI_TIMEOUT_MS, cwd: process.cwd(), env: process.env, maxBuffer: 2_000_000 },
        (err, stdout, stderr) => {
          // uv exits non-zero on CLI errors with the message on stderr/stdout
          if (err && typeof (err as { code?: number }).code !== "number") return reject(err);
          resolve({ code: (err?.code as number) ?? 0, stdout, stderr });
        },
      );
      child.on("error", (e) => reject(e));
    });
  }

  private parsePull(stdout: string, at: string): SkillsSyncInfo["lastSync"] & { pushed?: number } {
    const m = /(\d+) pulled, (\d+) removed, (\d+) unchanged/.exec(stdout) ?? null;
    const info: SkillsSyncInfo["lastSync"] = m
      ? { at, pulled: Number(m[1]), removed: Number(m[2]), unchanged: Number(m[3]) }
      : { at, pulled: -1, removed: -1, unchanged: -1, error: stdout.trim().slice(0, 200) || "unreadable output" };
    const p = /push .*: (\d+) uploaded, (\d+) pruned/.exec(stdout);
    if (p) info.pushed = Number(p[1]);
    return info;
  }

  /** Boot lifecycle: pull then push as TWO invocations — the CLI's `sync`
   *  subcommand is broken in v0.1.6 (cmd_push reached via cmd_sync hits
   *  `args.prune`; fixed upstream for v0.1.7). Boot-time push omits --prune
   *  (drift upload only).
   *
   *  Preflight: on a fresh VM an unseeded bucket or a missing CLI otherwise
   *  looks like "healthy but skill-less". A failed pull or an empty working
   *  copy is logged at ERROR and surfaced in /api/health as `degraded`;
   *  SKILLS_REQUIRED=1 turns the same condition into a fatal throw. */
  async syncAtBoot(): Promise<void> {
    if (!this.info.cliAvailable) {
      if (SKILLS_REQUIRED) {
        this.preflight(`skills registry unavailable (${this.info.error ?? "no CLI"})`);
      } else if (this.info.mode === "s3") {
        log.error(`skills registry unavailable: ${this.info.error ?? "no CLI"}`);
      }
      return;
    }
    const at = new Date().toISOString();
    try {
      const pull = await this.runCli(["pull", this.skillsDir]);
      const parsed = this.parsePull(pull.stdout, at);
      if (pull.code !== 0) {
        this.info.lastSync = { ...parsed, error: (pull.stderr || pull.stdout).trim().slice(0, 200) || `exit ${pull.code}` };
        this.info.degraded = true;
        this.preflight(`skills pull failed: ${this.info.lastSync.error}`);
        return;
      }
      const push = await this.runCli(["push", this.skillsDir]);
      const uploaded = /(\d+) uploaded, (\d+) pruned/.exec(push.stdout);
      this.info.lastSync = { ...parsed, pushed: uploaded ? Number(uploaded[1]) : -1 };
      this.info.skillCount = countSkillFiles(this.skillsDir);
      this.info.degraded = this.info.skillCount === 0;
      if (push.code !== 0) {
        this.info.lastSync = { ...this.info.lastSync, error: (push.stderr || push.stdout).trim().slice(0, 200) || `exit ${push.code}` };
        log.warn(`skills push (boot) failed: ${this.info.lastSync.error}`);
      } else {
        log.info(
          `skills sync — ${this.info.lastSync.pulled} pulled, ${this.info.lastSync.removed} removed, ` +
            `${this.info.lastSync.unchanged} unchanged, ${this.info.lastSync.pushed} pushed, ` +
            `${this.info.skillCount} SKILL.md`,
        );
      }
      if (this.info.degraded) {
        this.preflight(
          `skills working copy is empty at ${this.skillsDir} ` +
            `(registry ${this.info.registry ?? "?"} returned no SKILL.md)`,
        );
      }
    } catch (e) {
      if (e instanceof SkillsRequiredError) throw e;
      this.info.lastSync = { at, pulled: -1, removed: -1, unchanged: -1, error: String(e).slice(0, 200) };
      this.info.degraded = true;
      this.preflight(`skills sync unavailable: ${String(e).slice(0, 160)}`);
    }
  }

  /** Loud (or fatal, with SKILLS_REQUIRED=1) boot failure. */
  private preflight(message: string): void {
    if (SKILLS_REQUIRED) {
      throw new SkillsRequiredError(
        `${message} — SKILLS_REQUIRED=1 refuses to serve without a usable skills registry`,
      );
    }
    log.error(message);
  }

  /** CAS-conflict UX (Phase 4): when the last push failed there is a real
   *  attribution gap between the working copy and the bucket authority — the
   *  agent's edits exist only locally. Pending-failure consults surface in
   *  the next skill_manage result as a Rejected-grade advisory so the model
   *  re-reads before more edits. */
  lastPushFailure(): string | null {
    if (!this.info.lastPush?.error) return null;
    return `R2 authority not updated (last push failed: ${this.info.lastPush.error.slice(0, 140)})`;
  }

  /** Curation hook: schedule a debounced push of the working copy (--prune:
   *  agent deletes must propagate). Debouncing keeps multi-op turns from
   *  pushing per tool call; serialization of a queued run. */
  notifyChange(): void {
    if (!this.info.cliAvailable) return;
    this.info.pendingPush = true;
    if (this.pushTimer) return; // debounce already scheduled
    this.pushTimer = setTimeout(() => void this.flush(), PUSH_DEBOUNCE_MS);
    if (typeof this.pushTimer.unref === "function") {
      (this.pushTimer as NodeJS.Timeout & { unref: () => void }).unref();
    }
  }

  private async flush(): Promise<void> {
    this.pushTimer = null;
    this.info.pendingPush = false;
    if (this.busy) {
      await this.busy.catch(() => undefined);
    }
    const at = new Date().toISOString();
    const run = (async () => {
      try {
        const { code, stdout, stderr } = await this.runCli(["push", "--prune", this.skillsDir]);
        const p = /(\d+) uploaded, (\d+) pruned/.exec(stdout);
        this.info.lastPush = p
          ? { at, uploaded: Number(p[1]), pruned: Number(p[2]) }
          : { at, uploaded: -1, pruned: -1, error: (stderr || stdout).trim().slice(0, 200) };
        if (code !== 0) {
          this.info.lastPush = { ...this.info.lastPush, error: (stderr || stdout).trim().slice(0, 200) };
          log.warn(`skills push failed: ${this.info.lastPush.error}`);
        } else {
          log.info(`skills push — ${this.info.lastPush.uploaded} uploaded, ${this.info.lastPush.pruned} pruned`);
        }
      } catch (e) {
        this.info.lastPush = { at, uploaded: -1, pruned: -1, error: String(e).slice(0, 200) };
        log.warn(`skills push unavailable: ${String(e).slice(0, 160)}`);
      }
    })();
    this.busy = run;
    await run;
  }

  async flushNow(): Promise<void> {
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
      this.info.pendingPush = false;
      await this.flush();
    }
  }

  dispose(): void {
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
  }

  // queueDrain kept for parity with alternate bridge flavors; unused now.
  private unusedQueueDrain(): void {
    void this.queueDrain;
  }
}
