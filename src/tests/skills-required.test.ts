// Fresh-VM guard: with SKILLS_REQUIRED=1 the boot sync must fail loudly when
// the registry cannot produce a usable working copy, so index.ts can exit
// instead of serving a skill-less agent. Separate file: config constants are
// evaluated at import time.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-required-"));
process.env.SESSION_DB_PATH = path.join(tmp, "s.db");
process.env.MEMORY_DIR = path.join(tmp, "memories");
process.env.WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.SKILLS_REGISTRY = "s3://neuralmatrix";
process.env.SKILLS_CLI_BRIDGE = "0"; // no CLI configured
process.env.SKILLS_REQUIRED = "1";

const sync = await import("../skills/sync.js");

test("SKILLS_REQUIRED refuses to boot without a usable registry", async () => {
  const bridge = new sync.SkillsCliBridge(path.join(tmp, "skills"));
  await assert.rejects(
    () => bridge.syncAtBoot(),
    (e: unknown) =>
      e instanceof sync.SkillsRequiredError &&
      /SKILLS_REQUIRED=1/.test((e as Error).message),
  );
});
