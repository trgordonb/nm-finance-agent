# Design — Wiki-first routing and an Ask Wiki path

**Status:** proposed, 2026-10-27  
**Context trace:** `f31dacc7-aad1-4da7-82c9-136c733d72ea`  
**Current deployed baseline:** `2428d42` (user-scoped Wiki)

## 1. Problem

A user asked:

> What purpose does ORPO (On-Policy Reflective Policy Optimization) serves?

The term came from an article ingested into the user's **My Wiki**. The trace shows:

- `history_messages: 0`
- `load_skill` loaded **`scholar-search`**
- six `execute` calls queried OpenAlex
- **no `llm-wiki` call and no private-Wiki search**
- the model answered from public literature and corrected the acronym

The retrieval layer was configured correctly. The failure was **routing**: the
model had no explicit signal to check the user's private knowledge base for a
term/article it did not know came from there. The `llm-wiki` skill description
only triggers on words such as "wiki", "knowledge base", or "my wiki"; the
question contained none of them.

## 2. Goals

1. Make private-Wiki lookup a **first-class agent action**, not an optional
   skill the model must remember to load.
2. Add a narrow **Wiki-first routing** rule for questions about terms,
   concepts, claims, papers, or articles that may come from ingested notes.
3. Keep the existing `llm-wiki` skill for ingestion, admin operations, and
   workflows that need the shell helper.
4. Add a general **Ask Wiki** control in the Wiki tab that starts a scoped chat
   turn, in addition to the existing page-level “Ask the agent” action.
5. Preserve per-user isolation, private-by-default behavior, and the no-admin-
   token rule.

## 3. Non-goals

- Do not change the `llmwiki` service or its ingestion/compilation pipeline.
- Do not auto-answer from `/answer` in the UI; chat should use retrieval plus
  the normal agent loop and citations.
- Do not make every agent question search the Wiki. That would add latency and
  noise.
- Do not add a second wiki database, cache, or cross-user index.
- Do not expose `WIKI_API_TOKEN`, `WIKI_ASSERTION_SECRET`, or raw assertions in
  tool output, logs, or frontend code.
- Do not deploy the remote `llm-wiki-svc` on the EC2 host.

## 4. Current architecture

### 4.1 Existing skill path

`skills/llm-wiki/SKILL.md` documents the shell helper:

```bash
LW="$SKILLS_DIR/llm-wiki/scripts/llmwiki.sh"
"$LW" search "query" 8 "" --common
"$LW" answer "question" 5
```

The `execute` tool injects a short-lived assertion:

```ts
childEnv.LLMWIKI_ASSERTION = mintWikiAssertion({ username: currentUserId() });
childEnv.LLMWIKI_SCOPE = "private";
```

but only when the model chooses `load_skill("llm-wiki")` and then invokes the
helper. That did not happen in the failing trace.

### 4.2 Existing Wiki UI

`frontend/src/components/WikiTab.tsx` already has:

- a **My wiki / Shared wiki** scope switch;
- direct hybrid search through `GET /api/wiki/*`;
- a page-level **Ask the agent** button, which calls `onAsk()` with a prompt
  naming the page and scope.

`App.tsx` pre-fills the chat composer and switches to Chat. There is no general
“ask a question about this wiki” input when no page is selected.

### 4.3 Existing server proxy

`GET /api/wiki/*` in `src/index.ts` mints an assertion from `req.auth` and
forwards only the read allow-list (`domains`, `concepts`, `page`, `search`,
`healthz`) via `src/wiki-proxy.ts`. The upstream `/search` endpoint supports:

```text
GET /search?q=...&scope=private|common&domain=...&k=...
```

## 5. Proposed design

### 5.1 New tool: `wiki_search`

Add a server-side tool:

```ts
// src/tools/wiki_search.ts
export const wiki_search: ToolDef = {
  name: "wiki_search",
  description: "...",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      scope: {
        type: "string",
        enum: ["private", "common"],
        description: "private (My Wiki, default) or common (shared wiki)",
      },
      domain: { type: "string", description: "Optional domain filter" },
      k: { type: "number", description: "Max hits (default 8, max 10)" },
    },
    required: ["query"],
  },
  async execute(args) {
    // mint assertion for currentUserId()
    // GET WIKI_API_URL/search?q=...&scope=...&k=...
    // parse and format hits
  },
};
```

Register it in `src/tools/index.ts`:

```ts
import { wiki_search } from "./wiki_search.js";
...
return [..., createSessionSearchTool(...), wiki_search];
```

#### Authorization and scope

- Use `currentUserId()` (the same identity used by `execute`).
- Mint a short-lived assertion with `mintWikiAssertion({ username })`.
- Default `scope` to `private`.
- Only pass `common` when the caller explicitly asks for it.
- Never use `WIKI_API_TOKEN` from this tool, even if it is present.
- Do not log or return the assertion.

#### Request and result

Request:

```http
GET {WIKI_API_URL}/search?q=<query>&scope=<scope>&k=<k>[&domain=<domain>]
Authorization: Bearer <minted assertion>
```

Return a compact string suitable for the model:

```text
Wiki search (private, 3 hits):
- score 0.82 | page: algotrade/orpo | title: ORPO and RPO
  excerpt: "ORPO here means On-Policy Reflective Policy Optimization..."
  source: raw/...
- score 0.61 | chunk: ... | page: ...
...
```

Rules:

- Limit to `k=8` by default, maximum 10.
- Truncate each excerpt to ~500 characters.
- Include `origin` (`wiki`/`chunk`), score, domain, slug/page, title, and a
  source reference when available.
- No results: return “No relevant pages in My Wiki for …” so the model can
  explicitly say that before falling back to web/scholar search.
- Missing secret: `Rejected: wiki search is not configured (WIKI_ASSERTION_SECRET missing).`
- Upstream 401: `Rejected: llmwiki rejected the user assertion; check WIKI_ASSERTION_SECRET/scope.`
- Timeout/502: `Rejected: llmwiki is unreachable/cold; retry once.`
- Do not throw a fatal `Error:` for recoverable service conditions; preserve
  the existing tool recovery contract.

#### Why a tool, not only the skill

The failing model selected `scholar-search` because it was a direct, named
tool. `llm-wiki` is one of many skill entries and requires an extra load step.
A tool named `wiki_search` is directly visible in the wire tool list and
matches the desired action.

### 5.2 Prompt and skill routing

Add a short block to `buildSystemPrompt()` in `src/agent.ts` (or a shared
prompt constants module):

```text
WIKI-FIRST ROUTING:
When the user asks about a term, acronym, concept, claim, paper, article, or
saved note that may come from their own knowledge base, call wiki_search with
scope "private" before internet_search or scholar-search. If the question
mentions "my wiki", "the article I ingested/saved", "my notes", or a coined
term, this check is required. Cite the wiki page and source when it answers the
question. Use scope "common" only when the user explicitly asks about the
shared wiki. If the private wiki has nothing relevant, say so, then continue
with other sources.
```

Do **not** add an unconditional “always search wiki” rule. The trigger is
about *personal/ingested context*, not every question.

Also update the source `llm-wiki` skill description in the registry to include
questions about terms/concepts/claims from articles or notes previously
ingested into My Wiki. Keep the skill for capture/ingest/admin workflows; the
new tool is the fast retrieval path.

### 5.3 General Ask Wiki UI

Add an **Ask Wiki** input to `WikiTab.tsx`, near the scope switch and the
existing search box:

```text
[ Ask your wiki…                         ] [ Ask ]
[ My wiki ] [ Shared wiki ]
```

Behavior:

- The scope selector controls the default scope.
- On submit, call `onAsk()` with a prompt such as:

```text
Use wiki_search to search {my private wiki | the shared/common wiki} for:
"<query>".
Search the wiki first. Cite the page/domain and source excerpts. If the wiki
has no relevant page, say so explicitly before using web/scholar search.
```

- `onAsk` already switches to Chat and pre-fills the composer; do not auto-send
  in v1, so the user can review the prompt.
- Clear the Ask input after handing off.
- Keep the existing direct search box for literal keyword/hybrid search.
- Update the existing page-level **Ask the agent** prompt to name
  `wiki_search` and the page’s scope, e.g.:

```text
Search my private wiki (scope=private) for the page "<title>" (domain "<domain>",
slug "<slug>"). Use wiki_search, then summarize it and its related pages.
```

A user who starts from a specific page keeps the current page context; a user
who starts from the general Ask box gets a private-first search.

### 5.4 Data flow

```text
User: "What does ORPO mean?"
  → chat / agent loop
  → model calls wiki_search(query, scope=private)
  → mint short-lived assertion for current user
  → GET llmwiki /search
  → hits from user's private wiki
  → model cites page/source, or says no match
  → only then may internet_search/scholar-search run
```

Scheduled/cron runs use the same tool and the owning user's `currentUserId()`.
The tool must be included in the scheduled tool policy unless a future policy
explicitly disables it.

## 6. Files to change

| File | Change |
|---|---|
| `src/tools/wiki_search.ts` | New tool implementation |
| `src/tools/index.ts` | Register `wiki_search` |
| `src/agent.ts` | Add Wiki-first routing block to system prompt |
| `skills/llm-wiki/SKILL.md` (registry source) | Add term/ingested-article triggers to description |
| `frontend/src/components/WikiTab.tsx` | Add general Ask Wiki input and update page Ask prompt |
| `frontend/src/styles.css` | Style the Ask Wiki row/button |
| `src/tests/wiki-search-tool.test.ts` | Unit tests for the tool |
| `src/tests/agent-loop.test.ts` or prompt test | Assert the routing block is present |
| `docs/` | This design plus a short handoff note |

No database migration and no new HTTP API route are required. The chat route,
assertion minting, and Wiki proxy already exist.

## 7. Test plan

### Unit tests

1. `wiki_search` mints a usable assertion and calls the private scope by
   default.
2. Explicit `scope=common` is forwarded; no silent fallback to common.
3. `k` defaults to 8 and clamps to 10.
4. No `WIKI_ASSERTION_SECRET` returns the configured-error message, not a
   crash.
5. Upstream 401, 429, 500, and timeout map to actionable recoverable messages.
6. Empty results return a clear “no relevant pages” result.
7. Hits are formatted with page/slug/source and snippets are truncated.
8. The tool never sends `WIKI_API_TOKEN`.

Use a stubbed global `fetch` or injectable fetch function, following existing
tool tests.

### Prompt/tool tests

- Assert the system prompt includes `WIKI-FIRST ROUTING` and mentions
  `wiki_search`, private-first, and common-only-on-request.
- Assert `wiki_search` appears in `toWire(buildToolRegistry(...))`.

### Manual acceptance

Using a private page containing a coined term:

1. Start a new chat and ask the term question without saying “wiki”.
2. Confirm the first relevant tool call is `wiki_search` with
   `scope=private`.
3. Confirm the answer cites the private page/source.
4. Ask the same question with no matching wiki content; confirm the agent says
   the private wiki has no result, then falls back to public search.
5. Switch to Shared and use **Ask Wiki**; confirm `scope=common` is sent.
6. Confirm no other user's page is returned.

### Regression

- Existing Wiki tab search still works.
- Page-level “Ask the agent” still pre-fills the chat.
- `llm-wiki` ingest/capture through `execute` still works.
- `npm run check`, tests, and the frontend build pass.
- Trace for the ORPO example contains `wiki_search` before
  `scholar-search`/`internet_search`.

## 8. UX and safety notes

- The general Ask box is a **handoff to Chat**, not a separate wiki chat. This
  reuses the existing agent loop, auth, tool policy, citations, and session
  history.
- Private is the default. Shared is an explicit switch and should be named in
  the prompt.
- The tool returns snippets, not full page bodies; this keeps trace context
  manageable.
- Do not put the assertion in tool output or logs. Log only scope, hit count,
  duration, and upstream status.
- If `WIKI_ASSERTION_SECRET` is missing, the tool returns a recoverable error;
  the Wiki tab can still show an availability banner if the UI wants to detect
  it.

## 9. Rollout

1. Implement the tool and prompt changes behind the existing Wiki env
   configuration.
2. Update the `llm-wiki` skill description in the registry.
3. Run `npm ci`, `npm run check`, tests, and the frontend build.
4. Restart `nm-finance-agent`.
5. Hard-refresh the browser.
6. Verify the ORPO/private-term trace and the Ask Wiki flow.
7. Record the trace ID and any prompt deviation in the handoff report.

## 10. Decisions

- **Use a dedicated `wiki_search` tool** rather than relying on the model to
  load the `llm-wiki` skill.
- **Do not use `/answer`** in the UI path; retrieval + normal agent reasoning
  keeps cost and behavior consistent with the chat loop.
- **Keep private as the default**; common reads are explicit.
- **Do not auto-send** the Ask Wiki prompt; prefill for review.
- **Do not change the ingestion/admin skill behavior**; the skill remains the
  capture and admin interface.
