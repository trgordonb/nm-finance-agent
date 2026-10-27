# Handoff — Wiki-first routing and Ask Wiki

**Status:** implemented locally, 2026-10-27 (not yet deployed).
**Design:** `docs/wiki-first-routing-design.md`
**Baseline:** `2428d42` (user-scoped Wiki)

## What shipped

| Stage | Commit | Change |
|---|---|---|
| 1 | `99eac69` (+ `5091aca` log hardening) | `wiki_search` tool; private scope by default, per-user assertion, compact citations, no admin token |
| 2 | `ef43c45` | `WIKI-FIRST ROUTING` prompt block + wire/tool/prompt tests |
| 3 | `f540ecb` | General **Ask Wiki** handoff in `WikiTab`; page-level action now names `wiki_search` and its scope; styles |
| 4 | working tree + R2 | `llm-wiki` skill description includes terms/concepts/claims from ingested notes; pushed to `s3://neuralmatrix/skills/` |

The tool is in the always-bound base registry, so scheduled runs see it too;
the existing per-turn policy only filters MCP servers and `cron_manage`.

## Files

- `src/tools/wiki_search.ts` — tool implementation.
- `src/tools/index.ts` — registration.
- `src/agent.ts` — prompt routing block.
- `src/tests/wiki-search-tool.test.ts` — 7 tests (private default, common,
  scope validation, k clamp, missing secret, upstream 401/429/500, timeout,
  formatting/truncation, no admin token).
- `src/tests/wiki-routing-prompt.test.ts` — prompt + wire presence.
- `frontend/src/components/WikiTab.tsx` — Ask Wiki form, page prompt update.
- `frontend/src/styles.css` — Ask Wiki row.
- `skills/llm-wiki/SKILL.md` — description update (ignored by git; see below).

## Verification run

```bash
npm run check                 # clean
npm test                      # 199 passing
npm --prefix frontend run build
```

## Deployment notes

1. `npm ci`
2. `npm run check && npm test`
3. `npm --prefix frontend ci && npm --prefix frontend run build`
4. Restart `nm-finance-agent`; hard-refresh the browser.
5. Ensure `WIKI_ASSERTION_SECRET` is set for the app user. The tool mints a
   short-lived user assertion with `mintWikiAssertion({ username:
   currentUserId() })`; it never reads or sends `WIKI_API_TOKEN`.
6. Manual acceptance: ask a coined-term question without saying “wiki”; the
   first retrieval call should be `wiki_search` with `scope=private`, followed
   by an answer citing the private page. Repeat with no matching page and
   confirm the agent says the private wiki is empty before falling back.

## Skill description registry state

The **working copy** `skills/llm-wiki/SKILL.md` now mentions terms/concepts/
claims from articles or notes ingested into My Wiki. `skills/` is git-ignored,
so the change is not in the commit; it was published to R2 with:

```bash
uv run --project ~/projects/nm-skills-registry nm-skills push skills
# push skills/ → s3://neuralmatrix 'skills/': 1 uploaded, 0 pruned
uv run --project ~/projects/nm-skills-registry nm-skills doctor
# registry OK: 21 skills indexed; ... drift: 0 file(s)
```

`nm-skills list` shows the revised `llm-wiki` description. The tracked
`.nm-skills-registry-index.json` records the new etag/size.

Do **not** blindly push the `~/projects/nm-skills-registry` checkout: it is
older than the live user-scoped working copy (it predates the private/shared
scope sections). The working-copy push above is the safe path; reconcile the
checkout before any whole-repo registry push.

## Deliberately unchanged

- No new HTTP route or database migration.
- No automatic `/answer` call from the UI; Ask Wiki hands a prompt to Chat.
- Search results stay snippet-sized; full page reads remain the page viewer or
  the `llm-wiki` skill.
- `common` is only sent when the caller explicitly asks for it.
