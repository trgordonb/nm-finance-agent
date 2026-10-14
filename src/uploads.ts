// Wiki-PDF intake for the Chat UI. The browser POSTs one PDF as a raw request
// body; it lands under {WORKSPACE_DIR}/uploads/ so the agent's llm-wiki skill
// can `upload` it to the service — the service runs in a container and cannot
// see host paths, so the workspace copy is the handoff point.
//
// Pure path/data logic only; the HTTP glue lives in index.ts (same split as
// workspace.ts).

import fs from "node:fs";
import path from "node:path";

/** Strip a browser-supplied filename to a safe basename ending in `.pdf`. */
export function safePdfName(original: string): string {
  const base = path.basename(String(original ?? "")).replace(/[^A-Za-z0-9._-]+/g, "-");
  const stem = base
    .replace(/^[.-]+/, "")
    .replace(/\.pdf$/i, "")
    .replace(/[.-]+$/, "");
  return `${(stem || "upload").slice(0, 80)}.pdf`;
}

/** True when the buffer looks like a PDF (header within the first 1 KiB). */
export function looksLikePdf(data: Buffer): boolean {
  return data.subarray(0, 1024).includes("%PDF-");
}

export interface SavedUpload {
  fileName: string;
  absPath: string;
  bytes: number;
}

/** Write one PDF into `dir` (created on demand). Timestamp-prefixed names keep
 *  repeat uploads of the same document distinct; `-2`, `-3` cover the rare
 *  same-second re-attach. */
export function saveWikiUpload(
  dir: string,
  data: Buffer,
  originalName: string,
  now: Date = new Date(),
): SavedUpload {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const stem = `${stamp}-${safePdfName(originalName).replace(/\.pdf$/i, "")}`;
  let fileName = `${stem}.pdf`;
  let absPath = path.join(dir, fileName);
  for (let n = 2; fs.existsSync(absPath); n++) {
    fileName = `${stem}-${n}.pdf`;
    absPath = path.join(dir, fileName);
  }
  fs.writeFileSync(absPath, data);
  return { fileName, absPath, bytes: data.length };
}
