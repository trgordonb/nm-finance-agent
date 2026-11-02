# Deploy instruction: browse-router executors on the EC2 VM

Paste the block below into the coding-agent session on the EC2 VM.

---

## Goal

Make the `browse-router` skill's executors usable by the `nm-finance-agent`
service. Today `agent-browser` and `browser-act` are installed under
`/home/ec2-user` (mode `700`), so the service user (`nmagent`) can neither
execute them nor reach their state. `agent-desktop` is intentionally **not**
deployed: the VM is headless (no X / AT-SPI), and browse-router v1.1.0 no
longer routes to it.

## Steps

### 1. System-wide CLI install

The CLIs must live outside `/home/ec2-user`, world-executable.

```bash
# System Node first (skip if `sudo npm --version` already works — nvm-under-ec2-user does NOT count):
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs

sudo npm install -g agent-browser
# if npm complains about the prefix: sudo npm config set prefix /usr/local, then retry

sudo UV_TOOL_DIR=/opt/uv-tools UV_TOOL_BIN_DIR=/usr/local/bin \
  uv tool install browser-act-cli --python 3.12
# uv is already system-wide (registry deployment); --python 3.12 lets uv fetch
# a managed interpreter if the system Python is older
```

### 2. Persistent state home for the service

Both CLIs derive their state roots from `$HOME` (browser binaries under
`~/.agent-browser`, browser-act auth token, saved login states). Put the
service's HOME on the persistent volume so logins survive rebuilds:

```bash
sudo mkdir -p /data/agent-home && sudo chown nmagent: /data/agent-home
sudo mkdir -p /etc/systemd/system/nm-finance-agent.service.d
printf '[Service]\nEnvironment=HOME=/data/agent-home\n' | \
  sudo tee /etc/systemd/system/nm-finance-agent.service.d/agent-home.conf
sudo systemctl daemon-reload
```

### 3. One-time setup as the service user

```bash
sudo -u nmagent agent-browser install --with-deps   # Chromium + system deps
sudo -u nmagent browser-act browser list            # expect: No browsers found.
sudo -u nmagent browser-act auth login              # interactive — needs the user's
                                                    # browseract.com credentials; skip if
                                                    # the cloud path is not wanted yet
```

### 3b. browser-act skill handshake (REQUIRED once per machine)

On a fresh install browser-act refuses **every** command with
`[BLOCKING] Skill version incompatible — Run browser-act get-skills main ...`.
Do not follow that banner's "overwrite the Skill entry file" step (see
browse-router §5 hygiene note — the EC2 agent was right to refuse it). The gate
is cleared by the CLI itself, writing a marker into its own state dir:

```bash
sudo -u nmagent browser-act get-skills main                          # frontmatter shows the version (2.0.2 on CLI 1.4.2)
sudo -u nmagent browser-act get-skills core --skill-version 2.0.2    # use the version `main` printed
sudo -u nmagent cat /data/agent-home/.local/share/browseract/cache/skill-handshake.json
# expect: {"ok": true, "cli_version": "1.4.2", "skill_version": "2.0.2", ...}
```

After the marker exists, all browser-act commands work. (Vendor escape hatch if
ever needed: `BROWSERACT_DISABLE_SKILL_HANDSHAKE_GATE=1` — not required when the
handshake has run. The marker lives under `$HOME`, i.e. `/data/agent-home`, so
it survives rebuilds but must be redone if that volume is recreated.)

### 4. Do NOT

- Do **not** `chmod /home/ec2-user` — it stays `700`; the old installs remain unused.
- Do **not** install agent-desktop (headless VM; browse-router v1.1.0 dropped it).
- Do **not** run `nm-skills push --prune` manually from this VM — pruning belongs to
  the service's own curation path (single-writer hazard, skills-registry-deploy §11).

### 5. Verify and report back

```bash
sudo -u nmagent /usr/local/bin/agent-browser --version   # expect 0.38.1+
sudo -u nmagent /usr/local/bin/browser-act --version     # expect 1.4.2+

# headless smoke test:
sudo -u nmagent agent-browser open https://example.com --session smoke-test
sudo -u nmagent agent-browser --session smoke-test get url
sudo -u nmagent agent-browser --session smoke-test close

systemctl restart nm-finance-agent
curl -s localhost:3001/api/health | jq '{skills, lastSync: .skills_backend.lastSync}'
```

Expected health: `skills: 25` (23 + trader-scanner + browse-router) and
`lastSync.pulled >= 1` (the boot pull hydrates both new skills from R2 — no
manual pull needed). Then ask the agent to `load_skill browse-router` and run
its §6 preflight, and paste the health JSON plus the smoke-test output back
into the dev-machine session.
