// execute: run a shell command with a hard timeout. Spawns with CWD = the
// agent workspace, so script outputs/downloads land there by construction.
import { exec, type ExecOptions } from "node:child_process";
import { EXECUTE_TIMEOUT_MS } from "../config.js";
import fs from "node:fs";
import pathSvc from "node:path";
import { resolveInWorkspace } from "../workspace.js";
import { SKILLS_DIR } from "../config.js";
import type { ToolDef } from "../types.js";

export const execute: ToolDef = {
  name: "execute",
  description:
    "Execute a shell command (120s timeout) with CWD = the workspace dir; relative outputs land there. " +
    "Skill scripts: use the ABSOLUTE paths from SKILL.md (or `cd $SKILLS_DIR`). Source dirs stay protected. " +
    "Stopping a background job: use a pidfile or the bracket trick (`pkill -f '[p]attern'`) — " +
    "a plain `pkill -f pattern` also matches this command's own shell and kills it mid-run.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to run." },
    },
    required: ["command"],
  },
  execute(args, ctx) {
    return new Promise((resolve) => {
      const command = String(args.command ?? "");
      const opts: ExecOptions = {
        shell: "/bin/bash",
        timeout: EXECUTE_TIMEOUT_MS,
        maxBuffer: 1_000_000,
        cwd: resolveInWorkspace(""),
        // $SKILLS_DIR lets shell commands reach skill scripts regardless of cwd
        env: { ...process.env, SKILLS_DIR },
      };
      // Cancel responsiveness: Stop aborts the turn signal, so kill the
      // foreground child instead of waiting for EXECUTE_TIMEOUT_MS.
      let child: ReturnType<typeof exec>;
      let onAbort: (() => void) | undefined;
      let aborted = false;
      child = exec(command, opts, (err, stdout, stderr) => {
        if (ctx?.signal && onAbort) ctx.signal.removeEventListener("abort", onAbort);
        if (err && err.killed && aborted) {
          resolve("Rejected: cancelled by user; the foreground command was killed.");
          return;
        }
        if (err && err.killed) {
          // Recoverable per the loop contract: a foreground timeout is a
          // planning failure the model must route around, not a broken
          // system (live miss 2026-10-11 — a skill-driven python export hit
          // a 30s timeout and ended the whole research turn).
          const secs = Math.max(1, Math.round(EXECUTE_TIMEOUT_MS / 1000));
          resolve(
            `Rejected: command timed out after ${secs}s. For long-running pipelines ` +
              "(data exports, backtests), run in the background instead: " +
              "`nohup <cmd> > out.log 2>&1 &` (workspace-rooted), then poll out.log or `jobs`.",
          );
          return;
        }
        const numericExit = typeof err?.code === "number";
        const parts: string[] = [];
        if (stdout) parts.push(`Output:\n${stdout}`);
        // stderr is not synonymous with failure: progress logs (llmwiki wait),
        // warnings, and telemetry routinely write there while exiting 0. Only
        // label it "Error output" when the command actually exited nonzero.
        if (stderr) {
          parts.push(`${numericExit ? "Error output" : "Stderr (non-fatal)"}:\n${stderr}`);
        }
        // Signal death (SIGTERM/SIGKILL/…, no numeric exit): recoverable, the
        // model re-plans. The classic cause is a `pkill -f <pattern>`
        // self-match — execute runs the whole command as `bash -c "<cmd>"`,
        // so the pattern sits in that shell's own argv (live miss 2026-10-16:
        // the self-match killed its own shell mid-command → signal death →
        // previously classified fatal `Error:` → the turn aborted).
        if (err && !numericExit && err.signal) {
          return resolve(
            `Rejected: the command was killed by ${err.signal} before finishing. ` +
              "A common cause: `pkill -f <pattern>` also matches this command's own shell " +
              "(the pattern is in its argv). Retry with the bracket trick " +
              "(`pkill -f '[p]attern'`) or track the job via a pidfile " +
              "(`nohup <cmd> > out.log 2>&1 & echo $! > run.pid`, then `kill $(cat run.pid)`)." +
              (parts.length ? `\n${parts.join("\n")}` : ""),
          );
        }
        // Nonzero exit is information for the model, not a fatal turn-ender
        // (parity with the Python harness: subprocess output window only).
        // Fatal "Error:" is reserved for genuine spawn failures.
        if (err && !numericExit) return resolve(`Error: ${err.message.slice(0, 300)}`);
        if (numericExit) parts.push(`Exit code: ${err.code}`);
        // Skill-script class miss: cwd is the WORKSPACE, but skill SKILL.md
        // bodies reference repo-root-relative `skills/...` paths (python-
        // harness convention). When the missing artifact exists under the
        // ACTUAL skills root, answer with the corrected absolute path so the
        // model re-routes in the same turn (live miss: died on Errno 2).
        if (err && typeof stderr === "string" && stderr) {
          const abs = redirectToSkillsRoot(stderr);
          if (abs) {
            return resolve(
              `Rejected: the command could not find that file because relative paths run from the WORKSPACE. ` +
                `The skill lives on-disk at: ${abs}\n` +
                "Re-run with its ABSOLUTE path (or `cd $SKILLS_DIR` first — that env var is exported).",
            );
          }
        }
        resolve(parts.join("\n") || "(no output)");
      });
      onAbort = () => {
        aborted = true;
        try {
          child.kill("SIGTERM");
        } catch {
          /* already exited */
        }
      };
      if (ctx?.signal) {
        if (ctx.signal.aborted) onAbort();
        else ctx.signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  },
};

// Detects the "python3 skills/x/scripts/y.py" miss: bash's ENOENT stderr names
// a path resolved under the WORKSPACE; when the same skills/-relative tail
// exists under the repo's actual skills root, return its absolute path.
function redirectToSkillsRoot(stderr: string): string | null {
  const matches = stderr.matchAll(/(?:No such file or directory[^\s\S]*?)?['"]?([^\s'"]*?skills[\\/][^\s'"]+)['"]?/g);
  for (const m of matches) {
    const attempted = m[1];
    const idx = attempted.search(/skills[\\/]/);
    if (idx === -1) continue;
    const rel = attempted.slice(idx).replace(/\\/g, "/");
    const skillsRoot = SKILLS_DIR.replace(/[\/\\](skills)[\/\\]?$/i, "");
    const abs = pathSvc.join(skillsRoot, rel);
    try {
      if (fs.existsSync(abs)) return abs;
    } catch {
      /* keep scanning candidates */
    }
  }
  return null;
}
