// mcp-config contract tests: interpolation fail-closed, atomic toggles,
// keep_tools exact + suffix matching, per-server resilience stances.
// (client binding is live-verified; faking the whole SDK adds nothing).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.SESSION_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-t-")), "s.db");
process.env.MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-m-"));
process.env.WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-w-"));

const { loadMcpServers, setServerEnabled, keepToolsFilter } = await import("../mcp-config.js");

function writeCfg(dir: string, doc: unknown): string {
  const p = path.join(dir, "mcp_servers.json");
  fs.writeFileSync(p, JSON.stringify(doc, null, 2), "utf8");
  return p;
}

test("mcp config: enabled servers interpolate env; missing var fails closed per server", () => {
  process.env.MCP_TEST_TOKEN = "tok-9012";
  const p = writeCfg(fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-")), {
    servers: {
      good: {
        transport: "stdio",
        command: "cmd",
        env: { TOKEN: "${MCP_TEST_TOKEN}" },
        enabled: true,
      },
      broken: {
        transport: "stdio",
        command: "cmd",
        env: { SECRET: "${MCP_MISSING_XYZ}" },
        enabled: true,
      },
      off: { transport: "stdio", command: "cmd", enabled: false },
      bad_transport: { transport: "carrier_pigeon", enabled: true },
    },
  });
  const { clientServers, statuses } = loadMcpServers(p);
  assert.deepEqual(clientServers.good?.env, { TOKEN: "tok-9012" });
  assert.ok(clientServers.broken === undefined, "unresolved placeholder must fail closed");
  const broken = statuses.find((s) => s.name === "broken")!;
  assert.match(broken.error ?? "", /unresolved env vars: MCP_MISSING_XYZ/);
  assert.equal(statuses.find((s) => s.name === "off")?.enabled, false);
  assert.match(statuses.find((s) => s.name === "bad_transport")?.error ?? "", /unsupported transport/);
  delete process.env.MCP_TEST_TOKEN;
});

test("mcp config: setServerEnabled flips atomically and 404s unknown names", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-"));
  const p = writeCfg(dir, { servers: { a: { transport: "stdio", command: "c", enabled: false } } });
  assert.match(setServerEnabled("a", true, p).status, /^OK: enabled/);
  assert.deepEqual(JSON.parse(fs.readFileSync(p, "utf8")).servers.a.enabled, true);
  assert.ok(fs.readdirSync(dir).every((f) => !f.includes(".tmp-")), "no temp files left");
  const miss = setServerEnabled("nope", true, p);
  assert.match(miss.status, /^Rejected: no MCP server named "nope"/);
  assert.equal(miss.notFound, true);
});

test("keep_tools: exact name or _<tool> suffix only (multi-word tool names)", () => {
  const keep = ["breadth", "get_indicator"];
  const pred = keepToolsFilter(keep);
  assert.equal(pred("breadth"), true); // exact match
  assert.equal(pred("luxalgo_breadth"), true); // suffix match
  assert.equal(pred("luxalgo_get_indicator"), true);
  assert.equal(pred("luxalgo_library_multi_word_indicator_get"), false, "must not match on last underscore segment");
  assert.equal(pred("luxalgo_discovery_data"), false);
  assert.equal(keepToolsFilter(undefined)("anything"), true);
});

test("followups: parseFollowups JSON-array extraction + status: no false positives", async () => {
  const { parseFollowups, looksLikeFollowups } = await import("../followups.js");
  assert.deepEqual(
    parseFollowups('noise before ["Run a head-to-head","Extend the falsifier window"] trailing'),
    ["Run a head-to-head", "Extend the falsifier window"],
  );
  assert.deepEqual(parseFollowups("no json here"), []);
  assert.deepEqual(parseFollowups("[\"try it\",\"x\"]", 1), ["try it"], "cap respected");
  // object-format items (free-model drift, 2026-10-16): known key first,
  // then any first string value; unusable objects are skipped
  assert.deepEqual(
    parseFollowups('[{"action": "Run the US out-of-sample demo", "context": "why"}]'),
    ["Run the US out-of-sample demo"],
  );
  assert.deepEqual(parseFollowups('[{"what": "Check the fills"}]'), ["Check the fills"]);
  assert.deepEqual(parseFollowups('[{"n": 3}, {"ok": "Do the thing"}]'), ["Do the thing"]);
  // fenced variant (the retry instruction produced this live)
  assert.deepEqual(parseFollowups('```json\n["Trim the window"]\n```'), ["Trim the window"]);
  // prefilter: needs marker + 80 chars
  assert.equal(looksLikeFollowups("short. next steps only"), false);
  assert.equal(looksLikeFollowups("a".repeat(200)), false, "no marker");
  assert.equal(
    looksLikeFollowups("Done with the backtest, metrics below. Natural next steps you might want: run the walk-forward check, then compare fills."),
    true,
  );
});

test("followups: 'If you want, I can pull...' offer shape passes the prefilter (2026-10-10 live miss)", async () => {
  const { looksLikeFollowups } = await import("../followups.js");
  const closing =
    "If you want, I can pull the actual Pine Script source of a standard RSI build, " +
    "or explain a derivative like Stochastic RSI or Connors RSI.";
  assert.equal(looksLikeFollowups(closing), true);
  // non-offer shapes still rejected
  assert.equal(looksLikeFollowups("I can see why that's confusing — the answer is 42, moving on. "), false);
  assert.equal(looksLikeFollowups("I cannot reproduce that number with the given inputs."), false);
});
