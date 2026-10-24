// Report persistence shared by the research CLI and the server: completed
// reports land under workspace/research/<stamp>[-tag]-<slug>.md
// (RESEARCH_SAVE_REPORTS), or at an explicit `out` path.

import fs from "node:fs";
import path from "node:path";
import { currentWorkspaceRoot } from "../workspace.js";

export function slugify(question: string): string {
  const slug = question
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "report";
}

/** Write the report and return its absolute path. `tag` (e.g. a session-id
 *  prefix) is inserted before the slug so server runs stay identifiable. */
export function saveResearchReport(opts: {
  question: string;
  report: string;
  tag?: string;
  out?: string;
}): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = opts.out
    ? path.resolve(opts.out)
    : path.join(
        currentWorkspaceRoot(),
        "research",
        `${stamp}${opts.tag ? `-${opts.tag}` : ""}-${slugify(opts.question)}.md`,
      );
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, opts.report, "utf8");
  return target;
}
