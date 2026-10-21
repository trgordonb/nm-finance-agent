# Skills registry — fresh VM / container deployment

How `nm-finance-agent` gets its skills on a brand-new machine. Companion to the
registry repo (`~/projects/nm-skills-registry`, `nm-skills` CLI) and to
`container/README.md` (the mirror container).

**Status:** 2026-10-21 · registry `v0.1.7` published (the `sync --prune` fix).
The bridge still boots with pull+push and does not depend on it — see §9.

---

## 1. What runs where

| Layer | Code | Talks to R2? | When |
|---|---|---|---|
| Agent tools | `load_skill`, `skill_manage` → `SkillLibrary` | **no** | every turn |
| Sync bridge | `src/skills/sync.ts` → `nm-skills` CLI | yes | boot + debounced curation |
| CLI | `nm_skills_registry` (Python, `uv`) | yes | two processes per boot |

Reads are always local: the index and `SKILL.md` bodies come from `skills/`.
Writes are local-first: the tool returns immediately, and a 5 s-debounced
`push --prune` reconciles the bucket. The CLI is never on the read path and
never blocks a turn.

Boot order (all before the first chat turn):

```
getRuntime()
  └─ syncAtBoot()
       ├─ nm-skills pull <SKILLS_DIR>    # hydrate the working copy
       └─ nm-skills push <SKILLS_DIR>    # upload local drift (no --prune)
  └─ assembleRuntime()                   # MCP + tools
```

---

## 2. Prerequisites

| Dependency | Notes |
|---|---|
| Node **24** | `npm ci`, `npm run build` |
| Python **≥ 3.11** + `uv` | `uv run --directory …` or an installed binary |
| `nm-skills-registry` checkout **or** installed `nm-skills` | pinned tag, never `main` |
| R2 bucket + credentials | `SKILLS_REGISTRY`, `R2_*` |
| **Seeded bucket** | the only copy of the skill corpus |

`skills/` is gitignored in both repos, so a fresh checkout starts empty **by
design**. The bucket, not the repo, is the source of truth.

---

## 3. One-time seed (from the dev machine)

Do this before the first VM boot. Without it the VM is healthy and skill-less.

```bash
cd ~/projects/nm-finance-agent
uv run --directory ~/projects/nm-skills-registry nm-skills doctor
uv run --directory ~/projects/nm-skills-registry nm-skills import skills
```

`import` uploads the whole tree (first seed). Afterwards the bridge's
`push`/`push --prune` keeps it in sync. `doctor` shows the bucket, prefix and
mirror drift.

---

## 4. VM layout and environment

```
/opt/nm-finance-agent        app; systemd WorkingDirectory
/opt/nm-skills-registry      pinned registry checkout (v0.1.7)
/data/skills                 SKILLS_DIR   (persistent volume)
/data/state                  SKILLS_STATE_DIR (toggles, per user)
```

```ini
SKILLS_REGISTRY=s3://neuralmatrix
SKILLS_DIR=/data/skills
SKILLS_STATE_DIR=/data/state
NM_SKILLS_REGISTRY_HOME=/opt/nm-skills-registry
# SKILLS_CLI=/home/nmagent/.local/bin/nm-skills   # if installed as a tool
# SKILLS_USER_ID=default                          # per-user toggle profile
SKILLS_REQUIRED=1                                 # prod: fail boot, never serve empty
# SKILLS_CLI_BRIDGE=0                             # dev/local-only escape hatch
# SKILLS_CLI_TIMEOUT_MS=90000
# SKILLS_PUSH_DEBOUNCE_MS=5000
# R2_ENDPOINT_URL / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
```

Two gotchas:

- `SKILLS_DIR`'s **basename is the bucket prefix** (`/data/skills` → `skills/`)
  unless `SKILLS_REGISTRY` carries an explicit path. Keep it named `skills`.
- Paths must be **absolute** on a VM. `../nm-skills-registry` is a dev default
  relative to the process CWD.

---

## 5. Install

### A. Registry checkout (works with v0.1.7, zero app changes)

```bash
git clone --branch v0.1.7 https://github.com/trgordonb/nm-skills-registry /opt/nm-skills-registry
uv sync --directory /opt/nm-skills-registry --frozen    # at image/build time, not boot
```

Pinning matters: `v0.1.7` is the latest published tag. Upgrade deliberately
(§10), not by pulling `main` on the VM.

### B. Installed binary (skips the checkout)

```bash
uv tool install "git+https://github.com/trgordonb/nm-skills-registry@v0.1.7"
export SKILLS_CLI="$(uv tool dir --bin)/nm-skills"
```

`SKILLS_CLI` is an executable path (or a name on `PATH`), not a command line.
When set, the bridge runs `nm-skills <args>` directly; `NM_SKILLS_REGISTRY_HOME`
and `UV_BIN` are then unused.

---

## 6. systemd unit (WorkingDirectory is required)

Both `dotenv.config()` in `src/config.ts` and the CLI's `./.env` lookup are
relative to the process CWD.

```ini
[Unit]
Description=nm-finance-agent
After=network-online.target

[Service]
User=nmagent
WorkingDirectory=/opt/nm-finance-agent
EnvironmentFile=/opt/nm-finance-agent/.env
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

`SKILLS_REQUIRED=1` + `Restart=always` means a broken registry is a visible
crash loop, not a silent empty agent. Remove the flag if you prefer degradation.

---

## 7. Docker variant

```dockerfile
FROM node:24-slim

# uv + registry pinned at build time → no PyPI access at boot
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
RUN git clone --depth 1 --branch v0.1.7 \
      https://github.com/trgordonb/nm-skills-registry /opt/nm-skills-registry \
 && uv sync --directory /opt/nm-skills-registry --frozen

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

ENV SERVER_HOST=0.0.0.0 \
    SKILLS_DIR=/data/skills \
    SKILLS_STATE_DIR=/data/state \
    NM_SKILLS_REGISTRY_HOME=/opt/nm-skills-registry

VOLUME /data
EXPOSE 3001
CMD ["npm", "run", "start"]
```

Pass `SKILLS_REGISTRY` and `R2_*` as runtime secrets (never build args). If
`/opt` is read-only at runtime, `uv sync` must happen at build time (above) or
set `UV_PROJECT_ENVIRONMENT=/data/uv-env`.

---

## 8. Boot verification

```bash
curl -s localhost:3001/api/health | jq '{skills, skills_required, skills_backend}'
```

Expected first boot:

```json
{
  "skills": 19,
  "skills_required": true,
  "skills_backend": {
    "mode": "s3",
    "registry": "s3://neuralmatrix",
    "cliAvailable": true,
    "cli": "uv:/opt/nm-skills-registry",
    "skillCount": 19,
    "degraded": false,
    "lastSync": { "pulled": 19, "removed": 0, "unchanged": 0, "pushed": 0 }
  }
}
```

Then `uv run --directory /opt/nm-skills-registry nm-skills doctor`, and ask the
agent to `load_skill` one known skill.

---

## 9. Failure semantics

| Condition | Without `SKILLS_REQUIRED` | With `SKILLS_REQUIRED=1` |
|---|---|---|
| `SKILLS_REGISTRY` unset | local-only, no error | **boot fails** (required but unconfigured) |
| `SKILLS_CLI_BRIDGE=0` | local-only | boot fails |
| CLI / `uv` missing | `ERROR` log, `degraded:true` | boot fails (`SkillsRequiredError` → exit 1) |
| Pull fails (creds/network) | `ERROR` log, `degraded:true`, last good mirror still readable | boot fails |
| Pull succeeds but 0 `SKILL.md` | `ERROR` log, `degraded:true` (the fresh-VM trap) | boot fails |
| Push fails after a good pull | agent keeps working; next `skill_manage` returns an advisory; edits stay local | unaffected |
| `nm-skills sync` (the subcommand) | not used by the bridge; pull+push is deliberate. The missing `--prune` flag was fixed in v0.1.7 | — |

`/api/health` always exposes `skills_backend.degraded`, `skillCount` and the
last error, so a monitoring check can alert on `degraded=true`.

---

## 10. Upgrade

```bash
cd /opt/nm-skills-registry
git fetch --tags && git checkout v0.1.8        # next release
uv sync --frozen
systemctl restart nm-finance-agent
```

Skills are in R2, not in the image or the checkout, so an upgrade never touches
them. If the app image is rebuilt, `/data` (and therefore `skills/` + `state/`)
must be a volume.

---

## 11. Multi-user warning (OAuth2 roadmap)

`SKILLS_USER_ID` selects `state/users/<id>/skills.json` (sanitised to one path
segment). Toggles are per user; the **working copy is shared per process**.

`push --prune` compares the local tree to the whole bucket prefix. Two writers
with stale mirrors are destructive: user A publishes a skill, user B's
container never pulled it, B's next `push --prune` deletes A's skill from R2.

For per-user containers, pick one:

- drop `--prune` from the curation push, or
- namespace the prefix per user (`s3://bucket/skills/<uid>/`), or
- centralise pushes in a single service and make containers read-only.

Not urgent while single-user; it becomes urgent the moment OAuth2 opens the
door to a second human.
