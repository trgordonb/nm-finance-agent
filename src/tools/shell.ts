// execute: run a shell command with a hard timeout. Spawns with CWD = the
// agent workspace, so script outputs/downloads land there by construction.
import { exec, type ExecOptions } from "node:child_process";
import { EXECUTE_TIMEOUT_MS } from "../config.js";
import { resolveInWorkspace } from "../workspace.js";
import type { ToolDef } from "../types.js";

export const execute: ToolDef = {
  name: "execute",
  description:
    "Execute a shell command (30s timeout) with CWD = the workspace dir — relative outputs land there. " +
    "Use ../../ or absolute paths to reach repo/outside sources.",
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
        resolve(parts.join("\n") || "(no output)");
      });
    });
  },
};
