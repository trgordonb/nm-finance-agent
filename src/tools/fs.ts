// Filesystem tools: ls / read_file / write_file / edit_file / glob / grep.
// Port of langgraph-demo tools.py (minus the subprocess-based ls for speed).
// Same failure convention: catch and return "Error: ..." strings.

import fs from "node:fs";
import path from "node:path";
import type { ToolDef } from "../types.js";
import { resolveInWorkspace, guardWorkspaceWrite } from "../workspace.js";

export const ls: ToolDef = {
  name: "ls",
  description:
    "List files and directories. Relative paths are workspace-rooted; '.' = the workspace itself.",
  parameters: {
    type: "object",
    properties: {
      directory: { type: "string", description: "Path to list. Defaults to the workspace." },
    },
    required: [],
  },
  execute(args) {
    try {
      const dir = resolveInWorkspace(String(args.directory ?? ""));
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const lines = entries.map((e) => {
        const kind = e.isDirectory() ? "d" : e.isSymbolicLink() ? "l" : "-";
        let size = "";
        try {
          const st = path.join(dir, e.name);
          if (kind !== "d") size = String(fs.statSync(st).size);
          fs.statSync(st).size;
        } catch {
          /* unreadable: skip size */
        }
        return `${kind} ${size.padStart(8)} ${e.name}`;
      });
      return (lines.length ? lines.join("\n") : "(empty directory)") + `\n(dir: ${dir})`;
    } catch (e) {
      // Missing directory is usually a wrong-path mistake the model can fix
      // by listing the parent — recoverable, not turn-fatal.
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return `Rejected: directory does not exist (${String(args.directory ?? "")}) — try ls on the parent or the workspace.`;
      }
      return `Error: ${(e as Error).message}`;
    }
  },
};

export const read_file: ToolDef = {
  name: "read_file",
  description:
    "Read the contents of a file. Relative paths are workspace-rooted; absolute paths allowed for repo sources.",
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute or workspace-relative path." },
    },
    required: ["file_path"],
  },
  execute(args) {
    try {
      return fs.readFileSync(resolveInWorkspace(String(args.file_path)), "utf8");
    } catch (e) {
      const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
      if (missing) {
        return `Rejected: file does not exist — verify the path with ls/glob first.`;
      }
      return `Error: ${(e as Error).message}`;
    }
  },
};

export const write_file: ToolDef = {
  name: "write_file",
  description:
    "Write content to a file (overwrites if exists; creates parents). Relative paths land in the workspace.",
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path to write to (workspace-rooted when relative)." },
      content: { type: "string", description: "Full file content." },
      allow_outside: {
        type: "boolean",
        description: "Explicitly allow writing outside the workspace (harness dirs always rejected).",
      },
    },
    required: ["file_path", "content"],
  },
  execute(args) {
    const p = resolveInWorkspace(String(args.file_path));
    const deny = guardWorkspaceWrite(p);
    if (deny && !args.allow_outside) return deny;
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, String(args.content ?? ""), "utf8");
      return `Successfully wrote to ${p}`;
    } catch (e) {
      return `Error: ${(e as Error).message}`;
    }
  },
};

export const edit_file: ToolDef = {
  name: "edit_file",
  description:
    "Replace a specific string in a file with new content (exact match, first occurrence). Relative paths are workspace-rooted.",
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path of the file to edit (workspace-rooted when relative)." },
      old_string: { type: "string", description: "Exact text to find." },
      new_string: { type: "string", description: "Replacement text." },
      allow_outside: {
        type: "boolean",
        description: "Explicitly allow editing outside the workspace (harness dirs always rejected).",
      },
    },
    required: ["file_path", "old_string", "new_string"],
  },
  execute(args) {
    const p = resolveInWorkspace(String(args.file_path));
      const deny = guardWorkspaceWrite(p);
      if (deny && !args.allow_outside) return deny;
      try {
        const content = fs.readFileSync(p, "utf8");
        const oldString = String(args.old_string ?? "");
        const newText = String(args.new_string ?? "");
        const match = findFlex(content, oldString);
        if (!match) {
          // Wrong-args class failure: the model can re-read and correct the
          // edit — recoverable, must NOT end the turn (our "Error:" fatality
          // is reserved for system-level failures).
          return `Rejected: old_string not found in file — the file may have changed or the text is not an exact match (whitespace matters); re-read the relevant part of ${p} and retry with corrected text or a smaller unique match.`;
        }
        const updated = content.slice(0, match.start) + newText + content.slice(match.end);
        fs.writeFileSync(p, updated, "utf8");
        return `Successfully edited ${p}`;
      } catch (e) {
        return `Error: ${(e as Error).message}`;
      }
    },
};

export const glob: ToolDef = {
  name: "glob",
  description:
    "Find files matching a glob pattern (e.g. **/*.ts). Relative base paths are workspace-rooted (default = the workspace).",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern with ** and * wildcards." },
      path: { type: "string", description: "Base directory (workspace-rooted when relative)." },
    },
    required: ["pattern"],
  },
  execute(args) {
    try {
      const base = resolveInWorkspace(String(args.path ?? ""));
      const pattern = String(args.pattern ?? "*");
      const re = globToRegex(pattern);
      const out: string[] = [];
      walk(base, 4, (rel, abs) => {
        if (re.test(rel.replace(/\\/g, "/"))) out.push(abs);
      });
      return out.length ? out.join("\n") : "No matches found";
    } catch (e) {
      return `Error: ${(e as Error).message}`;
    }
  },
};

export const grep: ToolDef = {
  name: "grep",
  description:
    "Search for a regex or literal pattern in files (path:line prefixes). Relative paths are workspace-rooted (default = the workspace).",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Text or regex to search for." },
      path: { type: "string", description: "Directory (recursive) or single file; workspace-rooted when relative." },
      file_pattern: { type: "string", description: "Glob filter, e.g. *.ts. Defaults to '*.*'." },
    },
    required: ["pattern"],
  },
  execute(args) {
    try {
      const pattern = String(args.pattern ?? "");
      const base = resolveInWorkspace(String(args.path ?? ""));
      const filePattern = String(args.file_pattern ?? "");
      const reSpec = /.*[*?].*/.test(pattern) ? null : new RegExp(escapeRegex(pattern), "i");
      const fileRe = filePattern ? globToRegex(filePattern) : null;
      const out: string[] = [];
      const searchFile = (abs: string) => {
        if (fileRe && !fileRe.test(path.basename(abs))) return;
        let lines: string[];
        try {
          lines = fs.readFileSync(abs, "utf8").split(/\r?\n/);
        } catch {
          return;
        }
        lines.forEach((line, i) => {
          if ((reSpec && reSpec.test(line)) || (!reSpec && line.includes(pattern))) {
            out.push(`${abs}:${i + 1}: ${line.slice(0, 400)}`);
          }
        });
      };
      const st = fs.statSync(base);
      if (st.isFile()) searchFile(base);
      else walk(base, 6, (rel, abs) => searchFile(abs));
      return out.length ? out.slice(0, 200).join("\n") : "No matches found";
    } catch (e) {
      return `Error: ${(e as Error).message}`;
    }
  },
};

function walk(dir: string, maxDepth: number, cb: (rel: string, abs: string) => void): void {
  const visit = (d: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) visit(abs, depth + 1);
      else cb(path.relative(dir, abs), abs);
    }
  };
  visit(dir, 0);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegex(pattern: string): RegExp {
  // Supports ** (any depth) and * (within segment). Low-tech; enough for tools.
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else re += escapeRegex(c);
  }
  return new RegExp(`^${re}$`);
}

// --- edit_file matching helpers ----------------------------------------------

/**
 * Locate old text with graceful degradation: exact → trimmed →
 * whitespace-flexible (any whitespace run matches any other). Returns the
 * [start, end) span in the ORIGINAL content. Rebuilt for runs where the
 * model's old_string indentation drifted from the file's (the single most
 * common edit_file rejection class).
 */
function findFlex(content: string, target: string): { start: number; end: number } | null {
  if (!target) return null;
  // 1) exact
  const exact = content.indexOf(target);
  if (exact !== -1) return { start: exact, end: exact + target.length };
  // 2) trimmed
  const trimmed = target.trim();
  if (trimmed && trimmed !== target) {
    const at = content.indexOf(trimmed);
    if (at !== -1) return { start: at, end: at + trimmed.length };
  }
  // 3) whitespace-flexible: match the non-whitespace token sequence, letting
  //    any whitespace run in the content stand in for any other in the target.
  const tokens = target.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length < 2) return null;
  const first = escapeRegex(tokens[0]);
  const re = new RegExp(first + tokens.slice(1).map((t) => `\\s+${escapeRegex(t)}`).join(""), "");
  const m = re.exec(content);
  if (!m || m.index === undefined) return null;
  const start = m.index;
  let pos = start + tokens[0].length;
  for (const tok of tokens.slice(1)) {
    const ws = /^\s+/.exec(content.slice(pos));
    if (!ws) return null;
    pos += ws[0].length;
    pos += tok.length;
  }
  return { start, end: pos };
}
