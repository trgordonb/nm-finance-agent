// Headless deep-research runner — mirrors the Python repo's run_research.py:
//   npm run research -- "question" [--out report.md] [--quiet]
// Progress goes to stderr; the report goes to stdout unless --quiet. The
// report is saved under workspace/research/ (RESEARCH_SAVE_REPORTS=1) unless
// --out names a path.
//
// Every run also writes a durable log under workspace/research/logs/ (all
// step lines + outcome + failure stack + signal interrupts), so a long run
// that fails after the terminal is gone stays diagnosable.

import fs from "node:fs";
import path from "node:path";
import { EXA_API_KEY, RESEARCH_SAVE_REPORTS, WORKSPACE_DIR } from "../config.js";
import { runDeepResearch } from "./orchestrator.js";
import { saveResearchReport } from "./reports.js";
import type { ResearchEvent } from "./types.js";

interface CliArgs {
  question: string;
  out?: string;
  quiet: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let out: string | undefined;
  let quiet = false;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") {
      out = argv[++i];
    } else if (arg === "--quiet") {
      quiet = true;
    } else {
      rest.push(arg);
    }
  }
  return { question: rest.join(" ").trim(), out, quiet };
}

const { question, out, quiet } = parseArgs(process.argv.slice(2));
const started = Date.now();

// Durable per-run log (best effort: logging must never block the run).
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
let logPath = "";
try {
  const logDir = path.join(WORKSPACE_DIR, "research", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  logPath = path.join(logDir, `${stamp}.log`);
} catch {
  /* no log file — console output remains */
}
const log = (line: string): void => {
  if (!logPath) return;
  try {
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* ignore */
  }
};
const relLog = (): string => (logPath ? path.relative(process.cwd(), logPath) : "(no log file)");

// Signal interrupts are logged so a killed run is distinguishable from a crash.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    log(`interrupted (${sig})`);
    console.error(`\n[research] interrupted (${sig}) — log: ${relLog()}`);
    process.exit(130);
  });
}

async function main(): Promise<void> {
  if (!question) {
    console.error('usage: npm run research -- "your research question" [--out report.md] [--quiet]');
    process.exitCode = 2;
    return;
  }
  if (!process.env.TAVILY_API_KEY) {
    console.error("[research] warning: TAVILY_API_KEY is not set — searches will fail");
  }
  if (!EXA_API_KEY) {
    console.error("[research] note: EXA_API_KEY not set — page summaries fall back to the summarizer model");
  }
  console.error(`[research] question: ${question}`);
  console.error(`[research] log: ${relLog()}`);
  log(`question: ${question}`);
  log(`cwd: ${process.cwd()}`);

  const emit = (event: ResearchEvent): void => {
    const line = `${event.step}: ${event.detail}`;
    console.error(`[research] ${line}`);
    log(line);
  };

  const outcome = await runDeepResearch({ question, deps: { emit } });

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const tokens = outcome.usage.prompt_tokens + outcome.usage.completion_tokens;

  if (outcome.status !== "completed" || !outcome.report) {
    const asks =
      outcome.status === "awaiting_clarification" && outcome.clarification
        ? `\n[research] the agent asks: ${outcome.clarification}`
        : "";
    log(`run ${outcome.status} · ${elapsed}s · ${tokens} tokens${asks ? " · clarification asked" : ""}`);
    console.error(`\n[research] run ${outcome.status} (${elapsed}s, ${tokens} tokens) — log: ${relLog()}${asks}`);
    process.exitCode = 1;
    return;
  }

  let reportPath: string | undefined;
  if (out) {
    reportPath = saveResearchReport({ question, report: outcome.report, out });
  } else if (RESEARCH_SAVE_REPORTS) {
    reportPath = saveResearchReport({ question, report: outcome.report });
  }

  if (!quiet) console.log(outcome.report);
  log(`completed · report=${reportPath ?? "(not saved)"} · ${elapsed}s · ${tokens} tokens`);
  console.error(
    `\n[research] done in ${elapsed}s — ${tokens} tokens${reportPath ? ` — saved to ${reportPath}` : ""} — log: ${relLog()}`,
  );
}

try {
  await main();
} catch (e) {
  const stack = (e as Error).stack ?? String(e);
  log(`FAILED: ${stack}`);
  console.error(`[research] failed: ${stack}`);
  console.error(`[research] full log: ${relLog()}`);
  process.exitCode = 1;
}
