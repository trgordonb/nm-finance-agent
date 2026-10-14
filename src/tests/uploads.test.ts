// Wiki-PDF intake (Chat UI attach): filename sanitizing, PDF sniffing, and the
// timestamped workspace write the agent's llm-wiki upload consumes.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { safePdfName, looksLikePdf, saveWikiUpload } = await import("../uploads.js");

test("uploads: browser filenames are sanitized to a safe .pdf basename", () => {
  assert.equal(safePdfName("Quarterly Report (final).pdf"), "Quarterly-Report-final.pdf");
  assert.equal(safePdfName("../../etc/passwd"), "passwd.pdf");
  assert.equal(safePdfName(".hidden"), "hidden.pdf");
  assert.equal(safePdfName("noext"), "noext.pdf");
  assert.equal(safePdfName(""), "upload.pdf");
});

test("uploads: PDF sniffing accepts a header in the first KiB only", () => {
  assert.equal(looksLikePdf(Buffer.from("%PDF-1.7\nbody")), true);
  assert.equal(looksLikePdf(Buffer.concat([Buffer.alloc(500, 0x20), Buffer.from("%PDF-1.4")])), true);
  assert.equal(looksLikePdf(Buffer.concat([Buffer.alloc(2000, 0x20), Buffer.from("%PDF-1.4")])), false);
  assert.equal(looksLikePdf(Buffer.from("<html>not a pdf</html>")), false);
});

test("uploads: saveWikiUpload writes a timestamped copy and never clobbers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-upl-"));
  const data = Buffer.from("%PDF-1.4\nhello");
  const at = new Date("2026-10-13T09:30:00Z");

  const first = saveWikiUpload(dir, data, "Paper One.pdf", at);
  assert.equal(first.fileName, "2026-10-13T09-30-00-Paper-One.pdf");
  assert.equal(first.bytes, data.length);
  assert.equal(fs.readFileSync(first.absPath, "utf8"), data.toString());

  const second = saveWikiUpload(dir, data, "Paper One.pdf", at);
  assert.equal(second.fileName, "2026-10-13T09-30-00-Paper-One-2.pdf", "same-second re-attach must not overwrite");
  assert.notEqual(first.absPath, second.absPath);
});
