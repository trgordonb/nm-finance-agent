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
    "Skill scripts: use the ABSOLUTE paths from SKILL.md (or `cd $SKILLS_DIR`). Source dirs stay protected.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to run." },
    },
    required: ["command"],
  },
  execute(args) {
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
      exec(command, opts, (err, stdout, stderr) => {
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
        if (stderr) parts.push(`Error output:\n${stderr}`);
        // Nonzero exit is information for the model, not a fatal turn-ender
        // (parity with the Python harness: subprocess output window only).
        // Fatal "Error:" is reserved for timeouts and spawn failures.
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
