# Deep research latency plan — P0 + P1

Status: P0 + P1 + provider hotfix implemented and verified live
(trace `eca45e89-8f76-41a1-9512-5d03ac05a575`: 11.1 min, 160K tokens, 17
searches, 24-source report)
Owner: nm-finance-agent
Evidence: LangSmith traces `7ceb1747-f95f-47fd-8e58-cabbce07d852` (clarify
turn, 5.5 s) and `ebc47e7c-a1bb-47c1-9f4d-8708eebf2521` (main run, 108.4 min)
in project `nm-finance-agent`; comparison trace
`01a0e544-49ab-7cd3-b95d-66cf63a22905` in project `thinkdepth-ai`
(Python/LangGraph, 5.9 min).

## 1. Diagnosis

The TS port and the Python original use the same research prompts, but not the
same request settings. The TS run is slow because every research role thinks at
provider-default reasoning, produces ~20x the tokens, and crosses the 300 s
HTTP timeout; failed attempts are retried from scratch.

| Metric | TS deep-research (MSFT) | Python LangGraph (DAL) |
|---|---:|---:|
| Wall time | 108.4 min | 5.9 min |
| LLM calls | 105 | 28 |
| Median / p90 LLM latency | 33.7 s / 213 s | 11.2 s / 41.9 s |
| Longest LLM call | 1,501 s | 56.7 s |
| Completion tokens | 519,610 | 24,098 |
| Prompt tokens | 1,905,178 | 163,462 |
| Tavily searches | 101 | 13 |
| Supervisor iterations | 13 | 3 |
| ConductResearch rounds | 4 | 1 |
| Researcher sub-agents | 11 | 3 |
| Compress calls | 11 | 3 |
| Empty `refine_draft_report` calls | 4 | 0 |

### 1.1 Root causes

1. **Reasoning effort (dominant).** `src/llm.ts:145-147` sends
   `reasoning: { enabled: true }` with no effort unless the caller sets one.
   Only the final report sets `reasoningEffort: "low"`. The Python original's
   `build_chat_model` defaults to `thinking="off"`, which maps to
   `reasoning_effort: "low"` for GLM, for every role.
   - 17 TS calls produced >10K output tokens; GLM's visible content was often
     only 3-5K tokens, so 12-17K tokens per call were reasoning.
   - A same-model benchmark: default reasoning with `max_tokens: 700` returned
     700 output tokens and **0 characters** of content; `effort: "low"`
     returned 338 output tokens and 1,615 characters.
   - `max_tokens` does not bound GLM reasoning: the refine cap is 12,000 but
     the calls emitted 14,048 output tokens.

2. **300 s timeout x 5 retries.** `src/llm.ts:157` uses
   `LLM_TIMEOUT_MS=300000`; timeouts are retryable and `MAX_ATTEMPTS=5`.
   - 1,501 s = 5 attempts; 1,148 s = 4; 857 s = 3; 586 s = 2.
   - A 20K-token generation at ~70 tok/s is ~285 s, right at the timeout cliff.
   - The worst compress call blocked an entire research round for 25 min.

3. **Empty refine destroys the draft.** Four `refine_draft_report` calls at
   00:49, 01:19, 01:52 and 01:56 each burned 13.7-14K reasoning tokens and
   returned `""`. `supervisor.ts:203` assigned the empty result to
   `draftReport`, overwriting the draft for later rounds.

4. **No wall-clock budget; loose depth caps.**
   - `RESEARCH_DEADLINE_MINUTES=0` (disabled).
   - `RESEARCH_MAX_RESEARCHER_TURNS=8`, `RESEARCH_TOKEN_BUDGET=2,000,000`.
   - `RESEARCH_MAX_SUPERVISOR_ITERATIONS=15` counts every supervisor call
     (including `think_tool`), not research rounds; the run used 13 calls for
     4 ConductResearch rounds and 11 researchers.

5. **Search volume.** The researcher prompt says "5 search calls maximum", but
   the code caps turns, not searches. 11 researchers did 101 searches (~9
   each) vs Python's 13.

### 1.2 Where the model time went

| Stage | Calls | Model time | Output tokens |
|---|---:|---:|---:|
| Compress | 11 | 96.8 min | 214,939 |
| Researcher turns | 73 | 51.1 min | 196,393 |
| Supervisor | 13 | 10.0 min | 35,142 |
| Refine (all empty) | 4 | 12.3 min | 55,811 |
| Scope/brief/outline/final | 4 | ~4.0 min | 17,325 |
| **Total** | **105** | **174.1 min** | **519,610** |

Wall time is 108.4 min because researchers run in parallel; the slowest call
in each round serializes the next supervisor turn.

## 2. Scope

Implement **P0** and **P1** first; P2 (usage aggregation in the root run and
extra trace metadata) was implemented afterwards on 2026-10-19. SSE streaming
for long writer calls remains optional (no timeout pressure observed live).

### P0 — stop the runaway generation

- [x] **P0.1 Low reasoning effort for all research roles.**
  - Add `RESEARCH_REASONING_EFFORT` (default `low`) to config.
  - Pass `reasoningEffort` through the orchestrator (`callOpts`), supervisor,
    researcher tool loop, compress, and refine calls.
  - Cap the pre-research outline at 4,000 output tokens (Python
    `creative_model` parity); its 8,745-token output was pure overhead.
  - Do **not** send `reasoning.max_tokens` together with `effort` — OpenRouter
    rejects that combination (verified HTTP 400). Effort alone is the knob.

- [x] **P0.2 Empty-refine guard.**
  - Run refine at low effort.
  - If the first response is empty, retry once at low effort with the same
    prompt; if still empty, return the previous draft instead of `""`.
  - Never assign an empty string to `draftReport`.

- [x] **P0.3 Timeout / retry policy.**
  - Add per-call `timeoutMs` and `maxAttempts` to `ChatOpts`; default research
    calls to `RESEARCH_LLM_TIMEOUT_MS=600000` and
    `RESEARCH_LLM_MAX_ATTEMPTS=2`.
  - Add `retryOnTimeout` (default true globally; false for writer-tier
    compress/refine/final calls) so a fully generated-but-timed-out 20K-token
    call is not repeated.
  - Log attempt numbers with the timeout budget.

### P1 — bound the run

- [x] **P1.1 Real deadline.**
  - Default `RESEARCH_DEADLINE_MINUTES` to 15.
  - Create a deadline `AbortController` in `runDeepResearch` and combine it
    with the caller signal (`AbortSignal.any`); pass it to every research
    call so an in-flight 25-min call is aborted, not just checked at stage
    boundaries.
  - Map an aborted run to `cancelled` and clear the deadline timer in a
    `finally` block.

- [x] **P1.2 Cap research rounds and searches.**
  - New `RESEARCH_MAX_RESEARCH_ROUNDS=2` (ConductResearch batches, not tool
    calls). After the second batch, stop dispatching and go to the final
    report.
  - New `RESEARCH_MAX_RESEARCHER_SEARCHES=6` enforced in the researcher loop;
    reject excess searches with a recoverable `Rejected:` message and force
    compression.
  - Defaults: `RESEARCH_MAX_RESEARCHER_TURNS=5`,
    `RESEARCH_TOKEN_BUDGET=300000`, `RESEARCH_MAX_SUPERVISOR_ITERATIONS=10`.

- [x] **P1.3 Soft deadline in the supervisor.**
  - At 70% of the wall-clock budget, inject a one-time instruction telling the
    supervisor not to start another research round and to call
    `ResearchComplete`.
  - If it still asks for `ConductResearch` after the soft deadline, mark those
    calls skipped and break to the final report instead of launching more
    researchers.

## 3. Files to change

- `src/llm.ts` — `ChatOpts` additions, per-call timeout/attempts, timeout
  retry policy, reasoning effort passthrough.
- `src/config.ts` — new research knobs and safer defaults.
- `src/research/types.ts` — new `ResearchLimits` fields.
- `src/research/orchestrator.ts` — low-effort call options, outline cap,
  deadline signal, new limits.
- `src/research/supervisor.ts` — low-effort supervisor/refine, empty-refine
  guard, round cap, soft deadline, per-call timeout/attempts.
- `src/research/researcher.ts` — low-effort tool loop/compress, search cap,
  per-call timeout/attempts.
- `.env.example` — document the new knobs and updated defaults.
- `src/tests/research.test.ts` — add contract tests for the refine guard,
  round cap, search cap, and deadline cancellation.

## 4. Expected outcome

- P0: 108 min -> ~15-25 min, ~300-500K tokens.
- P0 + P1: ~8-12 min, ~150-250K tokens, close to the Python run's 6 min.
- Quality: the Python original runs at low effort for all roles, so the
  research/report contract is preserved; the final report already runs at
  `reasoningEffort: "low"` and is good.

## 5. Verification

1. `npm test` (offline research contract tests).
2. `npm run check` (tsc).
3. Re-run the MSFT question through `/research` and compare LangSmith:
   - wall time < 20 min,
   - completion tokens < 300K,
   - zero empty-content LLM runs,
   - no LLM run duration clustering at 2x/3x/4x/5x `RESEARCH_LLM_TIMEOUT_MS`,
   - at most 2 ConductResearch rounds and <= 6 searches per researcher.
4. Confirm the root run reports a cancelled status when the deadline fires.

## 6. Implementation log

- P0.1: every research call now sends `reasoning: { enabled: true, effort: "low" }`
  (supervisor, researcher turns, compress, refine, outline, final). The outline
  is capped at 4,000 output tokens.
- P0.2: `refineDraftReport` retries once and keeps the previous draft on a
  second empty response. `runResearcher` compress has the same one-retry guard.
- P0.3: `ChatOpts` gained `timeoutMs`, `maxAttempts`, and `retryOnTimeout`.
  Research defaults: 600 s timeout, 2 attempts; writer-tier compress/refine/
  outline/final do not retry a timeout.
- P1.1: `runDeepResearch` creates a deadline `AbortController`, combines it
  with the caller signal, passes it to every call, maps an aborted run to
  `cancelled`, and clears the timer in `finally`.
- P1.2: `RESEARCH_MAX_RESEARCH_ROUNDS=2`, `RESEARCH_MAX_RESEARCHER_SEARCHES=6`,
  `RESEARCH_MAX_RESEARCHER_TURNS=5`, `RESEARCH_TOKEN_BUDGET=300000`,
  `RESEARCH_MAX_SUPERVISOR_ITERATIONS=10`.
- P1.3: the supervisor injects a one-time wrap-up instruction at 70% of the
  deadline and skips/breaks new research after that point.
- Offline verification: `npm run check` clean; `npm test` 97/97 pass, including
  new tests for low-effort request options, the search cap, the round cap, the
  empty-refine guard, and in-flight deadline cancellation.

P2 status: researcher usage aggregation and reasoning-token metadata are now
implemented (see section 8); SSE streaming for long writer calls remains an
optional future item.

## 7. Follow-up — 2026-10-19 META run researched nothing

Trace `c34e67c3-2319-4a7f-84e2-c2f4271b9030`: 6:57 wall, 5 LLM calls, **zero
tool calls**, and a 129,533-char final report. The brief call returned prose
instead of JSON, the supervisor returned 16.5K chars of gibberish with no tool
calls (so the loop broke immediately), and the final call hit its 32K-token cap
repeating boilerplate.

### Root cause: a bad OpenRouter provider, not the research logic

The pinned provider order started with `relace`. Reproducing the exact brief
prompt against each provider:

| Provider | Result |
|---|---|
| `relace` | degenerate mixed-language garbage, JSON parse fails |
| `open-inference/fp4` | valid JSON brief in 23 s |
| `novita/fp8` | valid JSON brief in 47 s |
| default routing (Wafer) | valid JSON brief in 3 s |

Relace was also failing the same prompt at default reasoning effort and with
the reasoning block omitted, so the low-effort change was not the cause. The
model returns HTTP 200 with degenerate text, which OpenRouter fallbacks cannot
detect.

### Fixes

- **Routing**: `OPENROUTER_MAIN_MODEL_PROVIDER=open-inference/fp4,novita/fp8`;
  new `OPENROUTER_PROVIDER_IGNORE=relace` (OpenRouter `provider.ignore`) so
  fallbacks cannot re-select it. Applied to `.env` and `.env.example`.
- **Brief guard**: if the brief does not parse as JSON, retry once with a
  strict system contract; if it still fails, use the cleaned question as the
  brief. Free-form prose never reaches the supervisor.
- **Outline guard**: JSON-only; an unparseable outline becomes an empty draft
  instead of poisoning the supervisor's context.
- **Supervisor guard**: if the supervisor returns no tool calls (or
  `ResearchComplete`) while no research has run, launch a fallback researcher
  from the brief. This is the safety net that turns "research nothing" into at
  least one bounded research pass.
- **No-findings guard**: `runDeepResearch` throws if the supervisor and
  fallback researcher produced zero findings, instead of writing a report from
  the pre-research draft alone.
- **Final-report guard**: >60K chars triggers one strict-contract retry; if it
  is still over the limit, the run fails instead of returning repetition.
- **Observability**: `ChatResponse` now carries `provider` and `finish_reason`,
  and research LLM trace metadata records both. The next provider regression is
  visible in the trace without a reproduction script.

### Verification

- Offline: `npm run check` clean; `npm test` 101/101, including new tests for
  the brief fallback, supervisor fallback researcher, no-findings guard, and
  overlong-report retry.
- Live: the failing brief prompt now returns valid JSON from OpenInference;
  a live supervisor turn launched 2 researchers in 33.9 s.
- **Action required**: the running `tsx src/index.ts` server does not
  hot-reload; restart it to load the provider order and the new guards.

## 8. Live verification — 2026-10-19 META run

Trace `eca45e89-8f76-41a1-9512-5d03ac05a575` (after the server restart):

| Metric | Old MSFT run | New META run | Python run |
|---|---:|---:|---:|
| Wall time | 108.4 min | **11.1 min** | 5.9 min |
| LLM calls | 105 | 20 | 28 |
| LLM tokens (children) | 2,424,788 | **160,331** | 187,560 |
| Completion tokens | 519,610 | 43,355 | 24,098 |
| Tavily searches | 101 | 17 | 13 |
| Research rounds | 4 | 2 | 1 |
| Researchers | 11 | 3 | 3 |
| Longest LLM call | 1,501 s | 84.7 s | 56.7 s |
| Empty-content calls | 4 | 0 | 0 |

- All 20 LLM calls were served by `OpenInference` with normal finish reasons;
  no retries, no timeout clustering, no empty content.
- The deadline did not fire; the soft-deadline path was not needed.
- The final report is 2,221 words (under the 3,000-word contract), with 24
  cited sources, 9 named brokerages, and 37 price-point mentions. It covers
  results vs consensus, forward guidance/capex, the sell-off, rating and
  price-target changes, and consensus sentiment.
- The supervisor batched `think_tool` with `ConductResearch` in each round
  (no think-only round trips): round 1 launched 2 researchers, round 2 launched
  1 on remaining gaps.
- Remaining gap vs Python: TS uses 2 research rounds instead of 1 and
  OpenInference is ~1.5-2x slower per call. Setting
  `RESEARCH_MAX_RESEARCH_ROUNDS=1` would trade ~3 min for coverage.
- **P2 closed (2026-10-19)**: `runSupervisor` now adds each
  `ResearcherResult.usage` (regular and fallback researchers) to the run total,
  so the root run reports the full model spend instead of ~4x below the child
  sum. Reasoning tokens are recorded in trace metadata via the SDK convention
  (`usage_metadata.output_token_details.reasoning`), verified live. The
  remaining optional item is SSE streaming for long writer calls; the current
  600 s timeout + low effort showed no timeout pressure in the live run.
- **Second live run (AMD, trace `d39a0923-a598-4022-b124-e2a251a3198b`)**:
  9.3 min, 229,859 tokens (180,751 in / 49,108 out), 28,749 reasoning tokens,
  26 LLM calls, 21 tool calls (16 Tavily + 5 think), 1 research round with 3
  researchers, refine produced a 15,749-char draft, final report 2,268 words
  with 22 citations across 12 named firms. Root usage **exactly matches the
  child sum** (180,751/49,108), and providers were OpenInference (24 calls)
  with Novita and Wafer fallbacks — no Relace. No empty/stop calls, no
  `finish_reason=length`, no retries, no timeout clustering.

## 9. Model config refresh (2026-10-20)

- Summarizer default: `poolside/laguna-xs-2.1:free` (the `:free` Gemma variant
  was Google-AI-Studio-only and blocked from HK).
- Main provider order: `open-inference/fp4,deepinfra/fp4,novita/fp8`, still
  ignoring `relace`. Provider steering applies to the main model only;
  summarizer/title/followup calls use OpenRouter default routing.
- The free Poolside tier is intermittently 429 upstream; the summarizer's
  20 s / 2-attempt bound + raw fallback keeps turns responsive.
