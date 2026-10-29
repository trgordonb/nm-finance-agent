// execute's skill-path redirect: only rewrite a real cwd-relative ENOENT.
// An absolute path already under SKILLS_DIR is a genuine script error and must
// be surfaced verbatim, otherwise the model loops on the same command.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Build a readable fixture instead of assuming a repo-local skills/ checkout.
// In production, SKILLS_DIR points at a 700 nmagent data directory that the
// deploy user cannot traverse; the redirect behavior itself is path-based.
const skillsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nm-execute-redirect-"));
const script = "convert-arxiv-to-md/scripts/convert_arxiv_to_md.py";
const actual = path.join(skillsRoot, script);
fs.mkdirSync(path.dirname(actual), { recursive: true });
fs.writeFileSync(actual, "fixture\n");
process.env.SKILLS_DIR = skillsRoot;

const { redirectToSkillsRoot } = await import("../tools/shell.js");

test("execute redirect: maps a workspace-relative skills path to the real skills root", () => {
  const stderr =
    `python3: can't open file 'skills/${script}': [Errno 2] No such file or directory`;
  assert.equal(redirectToSkillsRoot(stderr), actual);
});

test("execute redirect: maps an absolute path under the workspace to the real skills root", () => {
  const stderr =
    `python3: can't open file '/var/lib/nm-finance-agent/workspace/nmtest/skills/${script}': ` +
    `[Errno 2] No such file or directory`;
  assert.equal(redirectToSkillsRoot(stderr), actual);
});

test("execute redirect: does not rewrite an absolute path already under SKILLS_DIR", () => {
  const stderr =
    `python3: can't open file '${actual}': [Errno 2] No such file or directory`;
  assert.equal(redirectToSkillsRoot(stderr), null);
});

test("execute redirect: does not rewrite permission or traceback errors", () => {
  assert.equal(
    redirectToSkillsRoot(`bash: ${actual}: Permission denied`),
    null,
  );
  assert.equal(
    redirectToSkillsRoot(
      `Traceback (most recent call last):\n  File "${actual}", line 1, in <module>\nValueError: boom`,
    ),
    null,
  );
});

test("execute redirect: ignores ENOENT without a skills path", () => {
  assert.equal(
    redirectToSkillsRoot(`cat: /tmp/nope: No such file or directory`),
    null,
  );
});
