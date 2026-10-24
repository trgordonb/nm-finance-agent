# Per-user prompt memory — implementation plan

**Status:** **implemented (2026-10-24)** — per-user `MEMORY.md`/`USER.md` plus
a read-only `memories/_shared/MEMORY.md`; 156 tests passing.
**Depends on:** the per-user workspace/session scoping already landed
(`src/workspace.ts` `currentUserId()`, `sessions.user_id`).
**Related:** [`per-user-workspace-and-r2.md`](./per-user-workspace-and-r2.md),
[`vm-deployment-runbook.md`](./vm-deployment-runbook.md).

---

## 0. Implementation notes (2026-10-24)

- **Layout**: `memories/<login-id>/MEMORY.md` + `USER.md` (3,575 chars per
  user) and `memories/_shared/MEMORY.md` (read-only, 2,000-char prompt budget,
  `SHARED_MEMORY_CHAR_LIMIT`).
- `PromptMemory` resolves `currentUserId()` per call (stateless; the two
  instances stay consistent); explicit-path construction still serves tests.
- Writes are atomic (temp + rename), directories `0700`, files `0600`;
  `_shared/MEMORY.md` is `0444` and `memory_manage` rejects `target="shared"`.
- `/api/memory` returns `user`, per-user usage/budget, and shared
  chars/budget/over-budget. `/api/health` reports `memory_chars: null` under
  SSO (public endpoint; no per-user value) and `shared_memory_chars`.
- Migration: the four project paragraphs in the old `MEMORY.md` plus the
  `USER.md` data policy moved to `_shared/MEMORY.md`; `trgordonb/MEMORY.md`
  and `USER.md` start empty. Originals are backed up in
  `/tmp/nm-memories-original/` and a tarball.
- Tests: `src/tests/memory-scope.test.ts` covers isolation, per-user budget,
  `memory_manage`, explicit paths, and shared truncation.

## 1. Goal

`MEMORY.md` and `USER.md` are currently **global**: every SSO user shares the
same always-on prompt memory. They must become **per-login**, using the same
identity as the workspace and session archive:

```
memories/<login-id>/MEMORY.md     # facts, decisions, project knowledge
memories/<login-id>/USER.md       # who this user is, preferences, style
```

- `MEMORY_DIR` remains the root (`./memories`, or `/var/lib/.../memories`).
- The combined **3,575-char budget** applies **per user**, not globally.
- Existing content (currently `memories/MEMORY.md` + `USER.md`) is migrated to
  `memories/trgordonb/` — the same legacy owner used for sessions.
- Nothing else changes: the agent loop, nudge, and `memory_manage` keep the
  same contracts; only the path resolution and a few invariants change.

**Non-goals:** shared/global project memory, memory encryption, semantic
memory (agentdb mirror), per-user skill toggles, per-user containers.

---

## 2. Current state (verified 2026-10-24)

| Piece | Where | Behavior |
|---|---|---|
| Root | `MEMORY_DIR` (`src/config.ts`) | `./memories`, created at boot |
| Files | `MEMORY_MD_PATH`, `USER_MD_PATH` | `memories/MEMORY.md`, `memories/USER.md` |
| Class | `PromptMemory` (`src/memory.ts`) | reads files on every call; no cache; writes directly |
| Instances | `src/index.ts` and `src/tools/memory_manage.ts` | **two** separate `new PromptMemory()` over the same files |
| Budget | `MEMORY_CHAR_LIMIT = 3575` | combined across both files |
| Prompt | `AgentLoop.runTurn` → `buildSystemPrompt(this.memory.load(), …)` | block rendered once per turn |
| Nudge | `run_memory_nudge(memory, …)` (`src/nudge.ts`) | reads/writes via the instance |
| REST | `GET /api/memory` | returns the global block + usage |
| Health | `GET /api/health` | `memory_chars` before auth (currently global) |
| Git | `.gitignore` lists `memories/MEMORY.md`, `memories/USER.md` | per-user subdirs are **not** ignored yet |
| Existing content | `MEMORY.md` 1,587 chars; `USER.md` 254 chars | belongs to `trgordonb` |

The two `PromptMemory` instances are safe today because the class is stateless
(reads on every call). The per-user design must preserve that property or share
one instance; otherwise the tool and the loop can diverge.

---

## 3. Target model

### Paths

```
MEMORY_DIR/
  trgordonb/
    MEMORY.md
    USER.md
  alice/
    MEMORY.md        # created on first write
    USER.md
```

Resolution:

```ts
// src/memory.ts
import { currentUserId, sanitizeUserId } from "./workspace.js";

export function memoryPathsFor(userId: string = currentUserId()) {
  const dir = path.join(MEMORY_DIR, sanitizeUserId(userId) || "default");
  return {
    dir,
    memoryPath: path.join(dir, "MEMORY.md"),
    userPath: path.join(dir, "USER.md"),
  };
}
```

- `currentUserId()` is the SSO `username` (fallback `sub`), the same key used by
  workspaces and sessions. Lowercase, one path segment, no traversal.
- `AUTH_MODE=off` falls back to `WORKSPACE_USER` or `"default"` — so local
  dev/CLI must set `WORKSPACE_USER=trgordonb` to see the migrated memory.
- Empty memory files are not created until the first `add`; a missing file
  renders as `""` (unchanged).

### Class shape

Keep the constructor signature for tests/explicit paths:

```ts
export class PromptMemory {
  private readonly explicit?: { memoryPath: string; userPath: string };

  constructor(memoryPath?: string, userPath?: string) {
    if (memoryPath && userPath) this.explicit = { memoryPath, userPath };
  }

  private paths() {
    return this.explicit ?? memoryPathsFor();
  }

  get memoryPath(): string { return this.paths().memoryPath; }
  get userPath(): string { return this.paths().userPath; }

  // load(), totalChars(), add(), replace(), remove(), commit() use this.paths()
}
```

- **Stateless** per call, like today → the two instances cannot diverge.
- `load()` / `totalChars()` / `commit()` resolve the active user from
  `AsyncLocalStorage` (set by the `/api` middleware and the login route).
- Explicit-path construction remains single-user and is what the existing
  budget/round-trip tests use.

### Writes

`commit()` should become atomic and private:

```ts
const { dir, memoryPath, userPath } = this.paths();
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
fs.writeFileSync(tmp, body ? `${body}\n` : "", { mode: 0o600 });
fs.renameSync(tmp, file);
```

- A crash mid-write cannot leave a truncated `MEMORY.md`.
- Existing files: `chmodSync(file, 0o600)` after rename (best effort).
- Node is single-threaded and the methods are synchronous, so same-user
  tool/nudge writes cannot interleave. Cross-process writers are not supported
  (single service instance, same as sessions).

### Budget

- `totalChars()` reads only the active user's two files.
- `commit()` compares against `MEMORY_CHAR_LIMIT` for that user.
- The nudge prompt (`buildNudgePrompt(memory.totalChars(), MEMORY_CHAR_LIMIT)`)
  is already parameterized; no change needed.

---

## 4. Code touchpoints

| File | Change |
|---|---|
| `src/memory.ts` | per-user path resolution, atomic write, 0700/0600 modes; keep explicit-path constructor |
| `src/config.ts` | keep `MEMORY_DIR` root; remove/deprecate `MEMORY_MD_PATH` + `USER_MD_PATH` (only `memory.ts` uses them) |
| `src/tools/memory_manage.ts` | no functional change (stateless facade resolves the active user); optionally pass the shared instance instead of constructing a second one |
| `src/index.ts` | `GET /api/memory` already after auth/ALS → scoped automatically; adjust `GET /api/health` `memory_chars` (see §7); the boot log line should not claim a global count |
| `src/agent.ts` | no change: `this.memory.load()` runs inside the turn's ALS scope |
| `src/nudge.ts` | no change: reads/writes through the facade inside the turn |
| `.gitignore` | replace `memories/MEMORY.md` / `memories/USER.md` with `/memories/` so per-user subdirs stay untracked |
| `src/tests/*` | add `memory-scope.test.ts`; existing explicit-path tests keep working |
| `CLAUDE.md`, `README.md`, `docs/per-user-workspace-and-r2.md` | document per-user memory; remove "memories are global" |

**No changes** to: session schema, workspace resolver, skills toggles, the
agentdb mirror, or the tool JSON schemas.

---

## 5. Migration (implemented split)

The old `memories/MEMORY.md` + `USER.md` were backed up, then split:

- **project-wide facts** (Dukascopy tooling, MintEval finding, indicator
  series, long-job/repro conventions) **and the data policy** →
  `memories/_shared/MEMORY.md` (mode `0444`);
- **per-user** `memories/trgordonb/MEMORY.md` and `USER.md` → empty (start
  adding personal facts as needed).

```bash
tar -czf /tmp/nm-memories-backup-<stamp>.tar.gz memories
mkdir -p /tmp/nm-memories-original
cp -a memories/MEMORY.md memories/USER.md /tmp/nm-memories-original/
mkdir -p memories/trgordonb memories/_shared
# write the shared facts to memories/_shared/MEMORY.md
: > memories/trgordonb/MEMORY.md
: > memories/trgordonb/USER.md
rm memories/MEMORY.md memories/USER.md
chmod 700 memories/trgordonb
chmod 600 memories/trgordonb/*.md
chmod 755 memories/_shared
chmod 444 memories/_shared/MEMORY.md
```

- Verified: shared = 1,888 bytes (1,871 trimmed; under the 2,000 budget),
  per-user = 0. Originals are in `/tmp/nm-memories-original/`.
- To move a line back to personal memory: `chmod u+w` the shared file, delete
  the line, `chmod 444` it, then add the line via `memory_manage` as that user.
- Do **not** leave a root `memories/MEMORY.md`; the new code ignores it, and it
  would confuse future migrations.
- If `memories/trgordonb/` already exists, merge manually rather than `mv`
  over it.

### `.gitignore`

Before the move:

```
/memories/
```

The current two-file list would leave `memories/trgordonb/MEMORY.md` untracked
and visible to `git add -A`.

### VM/deployment

`memories/` is part of `/var/lib/nm-finance-agent` on the VM. Either:

1. migrate on the dev machine before copying (recommended), or
2. run the same move on the VM **before** the first boot, then set
   `MEMORY_DIR=/var/lib/nm-finance-agent/memories`.

Add the move to the VM runbook's data-migration step (`T6`) when implemented.

### Rollback

Restore `memories-backup-<date>.tar.gz`, revert the code commit, restart. The
old global files are the only state; no schema changes.

---

## 6. Behavior changes

| Surface | Before | After |
|---|---|---|
| System prompt | one global `<agent_memory>` | the active login's block |
| `memory_manage` | writes `memories/*.md` | writes `memories/<login-id>/*.md` |
| `GET /api/memory` | global block | active login's block (already after auth/ALS) |
| Nudge | edits global memory | edits the turn owner's memory |
| Budget | 3,575 total | 3,575 per user |
| New user | inherited all memory | starts empty (unless seeded — see §9) |
| `AUTH_MODE=off` | global | `WORKSPACE_USER` (or `default`) folder |

`GET /api/health` is public and runs before auth. Its `memory_chars` currently
reports the global count; after scoping it would report the fallback identity
(`WORKSPACE_USER`/`default`). Options:

- set `memory_chars: null` when `AUTH_MODE=sso` (cleanest; it is a per-user
  value that health cannot know), or
- leave it (it will read `memories/default/`, usually 0), or
- move the field to an authenticated `/api/memory` response only.

Recommend `null` under SSO and keep the boot log line generic (`memory: per-user`).

---

## 7. Tests

### New `src/tests/memory-scope.test.ts`

- `runInWorkspace("alice", …)` → `PromptMemory.add("memory", "alice fact")`
  writes `memories/alice/MEMORY.md`; Bob's load is `""`.
- Alice and Bob each fill their own 3,575 budget; one hitting the limit does
  not affect the other.
- `load()` includes only the active user's `MEMORY.md` + `USER.md`.
- Explicit-path construction (`new PromptMemory(tmp/MEMORY.md, tmp/USER.md)`)
  still writes exactly those paths (existing contract).
- `memory_manage` (the module-level instance) writes to the active scope, not
  the root.
- Migration helper (if added) moves root files only when the target is absent.

### Existing tests

- `contracts.test.ts` budget/round-trip use explicit paths → unchanged.
- `memory_manage` denial tests don't depend on the path → unchanged.
- `nudge.test.ts` uses `buildNudgePrompt` only → unchanged.

Target: **150 + ~4 = 154 tests**, `tsc --noEmit` clean.

### Acceptance (manual, two SSO logins)

1. `trgordonb` sees the migrated 1,587 + 254 chars in `/api/memory` and the
   system prompt; a new login sees `""`.
2. `memory_manage add` as the new login creates
   `memories/<new-id>/MEMORY.md`; trgordonb's files are byte-identical.
3. The nudge after a turn as the new login writes to that user's file.
4. Budget rejection is per user.
5. No `memories/MEMORY.md` at the root after migration.
6. `git status` shows no memory files.

---

## 8. Risks and edge cases

| Risk | Mitigation |
|---|---|
| `AUTH_MODE=off` sees empty memory | set `WORKSPACE_USER=trgordonb` for local CLI/dev; document |
| SSO login id changes (rename) | memory folder changes with it (same as workspace/sessions); consider keying all three by `sub` later (§9) |
| New users lose project facts from the old `MEMORY.md` | review before migration; optionally seed from a template (§9) |
| `execute` can read another user's memory file | path separation, not isolation; per-user containers remain the isolation step |
| Two `PromptMemory` instances | stateless resolution; optionally share one instance |
| Crash during write | atomic temp+rename |
| `/api/health` leaks a count | return `null` under SSO |
| Root `memories/MEMORY.md` left behind | migration checklist + boot warning (optional) |
| Concurrent same-user writes | single-threaded sync methods; atomic rename; no cross-process writers |

---

## 9. Open questions

1. **`MEMORY.md` per-user or shared + per-user?** `USER.md` is clearly
   per-user. `MEMORY.md` may hold project-wide facts ("the OpenRouter provider
   order is …"). Options:
   - per-user only (this plan), or
   - a read-only `memories/_shared/MEMORY.md` composed into every prompt, with a
     separate budget.
   Decide before migrating; the current 1,587 chars may include facts other
   users need.
2. **Identity key:** `username` (current workspace/session key) vs `sub`
   (stable across renames). Switching all three to `sub` is a larger migration;
   not in this plan.
3. **Seed new users:** copy `memories/_template/` on first login, or start
   empty? Empty is the safe default.
4. **Budget:** keep 3,575 per user, or raise it because each user now has a
   private budget? Keep 3,575 for prompt-cache parity.
5. **Health:** `memory_chars: null` under SSO, or remove the field.

---

## 10. Phases and effort

| Phase | Work | Effort |
|---|---|---|
| P0 | backup + `mv` existing files + `.gitignore` + verify | 30 min |
| P1 | `PromptMemory` per-user paths + atomic writes + modes | 2–3 h |
| P2 | tests (scope, budget, tool, migration) | 1–2 h |
| P3 | `/api/health` adjustment, docs, VM runbook note | 1 h |
| P4 | two-login manual verification + commit/push | 30 min |

**Total: ~0.5 day.** No schema migration, no new dependencies.

### Definition of done

- `memories/<login-id>/{MEMORY.md,USER.md}` is the only layout.
- Legacy files live in `memories/trgordonb/`.
- `/api/memory`, the system prompt, the nudge, and `memory_manage` all use the
  active login's files.
- Budget is enforced per user.
- `git status` shows no memory content; tests pass.
- Docs no longer say memory is global.
