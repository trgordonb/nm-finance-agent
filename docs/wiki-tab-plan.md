# Wiki tab — plan (native viewer in the React app, graph included)

Status: stages 1–3 implemented (2026-10-13). Stage 4 (service-side graph
endpoint) stays deferred until the client fan-out hurts. Owner: agent + user.
Last updated: 2026-10-13.

## Goal

Add a **Wiki** tab to the nm-finance-agent frontend that renders the compiled
llmwiki knowledge base (pages, search, and — by stage 3 — the link graph)
directly from the service's REST API. Read-only: the chat agent remains the
only writer, via the `llm-wiki` skill.

## What exists today (verified 2026-10-13)

- llmwiki REST (localhost:8010, project `~/projects/llm-wiki-svc`), read surface:
  - `GET /domains` → `[{name, description, created}]` (`general` first)
  - `GET /concepts?domain=&prefix=` → `PageGist[]` (`{slug,title,type,gist,sources,updated,version}`)
  - `GET /page/{slug}?domain=` → raw markdown (`---` YAML frontmatter + body, `[[wikilinks]]`, auto-appended `## Sources`)
  - `GET /search?q&k&domain=` → `SearchHit[]`
  - `GET /healthz` → status JSON
- **No CORS headers on the service** → the browser cannot call :8010 directly.
- Reads are **domain-scoped**; with no `domain` parameter only `general` is
  returned. A full view must iterate `/domains`.
- The frontend already has the exact markdown stack needed (react-markdown 10,
  remark-gfm, rehype-highlight, lucide-react) and a tab shell in `App.tsx`
  (`view: "chat" | "settings"`).
- The service has **no graph/backlinks endpoint**. Edges must be derived from
  page bodies (`[[wikilinks]]`) and `sources:` frontmatter client-side until a
  service-side endpoint exists (stage 4 gate).
- Reference implementation studied: `github.com/Ansub/wiki-os` — local-fs only
  (no R2/S3 option; adding one is ≈4–7 focused days there, out of scope here).

## Architecture decisions

1. **Proxy via the Express backend** — `GET /api/wiki/*` forwards an allow-listed
   read surface to `WIKI_API_URL` (default `http://127.0.0.1:8010`). Reasons:
   removes CORS, works identically for `vite dev` and a built frontend, and
   keeps the UI structurally unable to reach write/admin endpoints
   (`/ingest`, `/upload`, `/compile`, domain mutations, `/lint` are not
   forwarded — the allowlist is the security posture, not the UI).
2. **Domain is a first-class filter.** The tab carries a domain selector; the
   active domain scopes concepts and pages. Cross-domain aggregation is a
   stage-2 nicety.
3. **Frontmatter is stripped client-side**; title/type/gist come from
   `/concepts` (already fetched for the list). The `## Sources` section is
   rendered as-is (it is part of the page contract).
4. **Wikilinks become in-app navigation.** `[[target|label]]` is rewritten to a
   `wiki:` href before rendering; the markdown `a` renderer intercepts it and
   opens the page (if present in the loaded domain) or renders a "missing"
   style. Attachments/images are not rendered (compiled pages are text-first).
5. **Graph is client-derived in stage 3** (wikilinks + `sources:` edges from
   fetched page bodies), rendered with graphology + sigma, lazy-loaded exactly
   like `@luxalgo/vela`. A service-side `GET /graph` endpoint in the
   llm-wiki-svc repo is a stage-4 option, gated on corpus size making the
   client fan-out (1 request/page) too slow.

## Porting assets from the python-era frontend (found 2026-10-13)

The python repo this project was ported from already shipped a **wiki-os port**
at `~/projects/langgraph-demo/frontend/src/wikios/` (~3,800 lines: WikiTab,
WikiNote, WikiGraph, WikiSearch, WikiStatsView, HomepageContent, RawPanel,
wikios.css). The TS port dropped it ("chat-only shell (step 1)"), but
`frontend/src/styles.css` still keeps `.wiki-tab` / `.wiki-tab-scroll` for it,
and the graph view is built on **graphology + graphology-layout-forceatlas2 +
sigma** (MIT), already adapted to this app's dark palette.

What that means per stage:

| python-era component | reuse for llmwiki | notes |
|---|---|---|
| `WikiTab.tsx` (view switcher) | pattern only | home/note/graph/stats subviews; we start with list+note |
| `WikiSearch.tsx` | adapt | searches via `/api/search`; llmwiki has `/search` |
| `WikiNote.tsx` | adapt | markdown note view; ours = `/page/{slug}` + frontmatter/wikilinks |
| `WikiGraph.tsx` | **port the rendering** | consumes `GraphData {nodes, edges}` from `/api/graph`; we derive the same shape client-side |
| `WikiStatsView.tsx`, `HomepageContent.tsx` | optional | homepage/stats data has no llmwiki equivalent; derive from gists if wanted |
| `RawPanel.tsx`, person images | drop | llmwiki has no raw-file serving; person images are irrelevant here |
| `wikios.css` | reference | scoped styles; reuse class vocabulary where it fits |

This materially reduces stage 3: the graph renderer (force layout, hover
highlight, node sizing by backlinks) is a port with a data adapter, not new
physics. New deps needed then: `graphology`, `graphology-layout-forceatlas2`,
`sigma` (lazy-loaded like `@luxalgo/vela`).

## Stages

### Stage 1 — read-only browser (this stage)

Deliverables:
- `src/wiki-proxy.ts`: allow-list + URL builder + upstream fetch; unit tests in
  `src/tests/wiki-proxy.test.ts`.
- `GET /api/wiki/*` route in `src/index.ts` (502 on upstream failure, 400 on
  non-allow-listed paths).
- `WIKI_API_URL` in `src/config.ts`.
- Frontend: `api.ts` helpers, `WikiTab.tsx` (domain selector, page list with
  filter, page pane), `App.tsx` Wiki tab, styles.
- Frontmatter strip + wikilink remap in the page pane.

Acceptance:
- Wiki tab lists domains and their pages; selecting a page renders markdown
  (headings, lists, tables, code) with site typography; wikilinks navigate
  within the domain and show a "missing" style otherwise; upstream down →
  visible error with hint; `npm test` (backend) and `npm run build`
  (frontend) pass.

### Stage 2 — search and integration — implemented 2026-10-13

- Search box over `GET /search` (debounced 350ms, ≥2 chars), results carry
  origin/domain/snippet; wiki hits open their page, chunk hits open the
  source note they came from. Scoped to the selected domain, or every domain
  under "all" (service policy=all; each hit carries its own `domain`).
- Cross-domain "all domains" scope: concepts fan out over `/domains`, sorted
  by `updated` desc; list rows show a domain tag; slug collisions are keyed
  `domain:slug`.
- "Ask the agent" button: prefills the composer with the page's domain+slug
  and switches to the chat view (chat remains the only writer).
- Polish: type/origin badges, results header, empty states, refresh reloads
  the current scope.

### Stage 3 — graph view — implemented 2026-10-13 (render-only scope)

- Toggle (network icon) in the sidebar header; graph replaces the page pane
  for the current scope (all domains or one) and closes back to the page view
  on node click.
- Nodes = the scope's gists (color by type, size by degree, labels);
  keyed `domain:slug`. Edges = body wikilinks, including the compiler's
  `## Sources` rows (`sources/<id>` normalizes to the source-note page):
  a source note and its compiled pages link both ways. Unresolved targets
  become dim "missing" nodes so dangling links are visible (skipped `#anchor`
  fragments). Per-page fetch failures degrade to an edgeless node.
- Rendering: `graphology` + `graphology-layout-forceatlas2` + `sigma@3`,
  dynamically imported (own chunks: ~61 kB + ~91 kB; main bundle unchanged).
  Hover highlights neighbors via reducer, click opens the page.
- Deferred (not needed for v1): in-graph search box, type/domain filters,
  source-node toggle, info panel, >300-node guard, cached rebuilds. The
  client-side page fan-out remains the cost to watch — stage 4 stays the
  escape hatch.

Reference: the python-era `WikiGraph.tsx` supplied the sigma-3 settings and
reducer patterns; sigma is pinned to v3 for that API (sigma 4 reworked the
styling system).

### Stage 4 — (conditional) service-side graph endpoint

Trigger: graph fan-out or refresh cost becomes noticeable (>300 pages), or the
chat agent would benefit from a backlinks API.
- llm-wiki-svc: `GET /graph?domain=` returns `{nodes:[{slug,title,type,domain}],
  edges:[{from,to,kind}], dangling:[{from,target}]}` computed from the gists +
  stored pages, cached per revision. Cross-repo change, separate review.

## Risks / open questions

- **Slug collisions across domains**: page identity must include domain
  (`domain:slug`) everywhere in the graph and search deep-links.
- **Wikilinks are not namespaced by the compiler** — a link may resolve in
  another domain; stage 2+ can probe other domains on miss (bounded).
- `/page` returns text/markdown, not JSON — the api helper uses a text fetch.
- Vault pages include `type: source` notes; the UI may want to filter them from
  the default list (stage 2).
- Graph layout physics on very large graphs — sigma handles it, but keep the
  performance guard.

## Testing

- Backend: unit tests for the proxy allow-list/URL builder (pure), plus
  `npm test` contract suite.
- Frontend: `npm run build` (tsc + vite) is the gate; manual smoke against the
  live service via `npm start` + `npm run dev`.
- Manual smoke script (curl) documented in the implementation PR/commit.
