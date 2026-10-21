// SkillLibrary: agentskills.io SKILL.md directory with progressive
// disclosure. Phase-1 port of nm-memory_layer.skills + nm_skills_registry
// SkillRegistry semantics the agent surface depends on (message contracts,
// resolve ordering, frontmatter template, path guards, toggles) over a LOCAL
// directory — the materialized working copy. R2 remains the authority via
// the existing `nm-skills` CLI lifecycle (sync at boot, debounced push after
// curation — Phase 2); this file never touches object storage.
//
// Contracts preserved (parity-adapted):
//   - disabled skills are INVISIBLE to the agent surface (index/load/resolve)
//     and only visible to the admin view (list_all / toggles / REST)
//   - denials speak "Rejected:", fatal config problems "ERROR:"; unknown
//     action never ends the turn
//   - patch is the preferred update path (safe + token-cheap vs edit)

import fs from "node:fs";
import path from "node:path";
import { load as yaml } from "js-yaml";
import { SKILLS_DIR, SKILLS_STATE_DIR, SKILLS_USER_ID } from "../config.js";

const SKILL_FILE = "SKILL.md";
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

export interface SkillEntry {
  relDir: string; // posix path under the root, e.g. "devops/deploy-k8s"
  key: string; // full path of the SKILL.md
  name: string;
  description: string;
}

interface DisabledState {
  disabled: string[];
}

// Frontmatter parsing via a real YAML engine (pyyaml parity): descriptions
// legitimately use folded/literal block scalars (">"/"|") — a line-regex
// parser renders those as ">" (seen live in paper-claim-repro).
function frontmatter(text: string): { meta: Record<string, string>; body: string } {
  // tolerate CRLF endings from cross-platform skill authoring
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---")) return { meta: {}, body: text };
  // split on the FIRST two fence lines ("---\n секция\n---\n") — python split("...", 2)
  // split on the first two fence lines — python split("---", 2) parity;
  // trailing spaces after the closing fence are tolerated (YAML allows
  // them; seen live in tradedesk-dukascopy's SKILL.md — "--- ")
  const closed = /^---\n([\s\S]*?)\n---[ ]*(?:\n|$)/.exec(normalized);
  if (!closed) return { meta: {}, body: text };
  const raw = closed[1];
  const body = normalized.slice(closed[0].length).replace(/^\n/, "");
  let doc: unknown = {};
  try {
    doc = yaml(raw) ?? {};
  } catch {
    return { meta: {}, body }; // malformed frontmatter: python parity ({}, body)
  }
  const meta: Record<string, string> = {};
  if (doc && typeof doc === "object") {
    // js-yaml keeps the folded block's final newline (pyyaml does not) — trim
    // trailing whitespace so index rendering stays one line
    for (const [k, v] of Object.entries(doc as Record<string, unknown>)) {
      if (v === null || v === undefined) continue;
      meta[k.toLowerCase()] =
        typeof v === "string" ? v.replace(/\s+$/, "") : JSON.stringify(v);
    }
  }
  return { meta, body };
}

export class SkillLibrary {
  readonly root: string;
  private statePath: string;

  constructor(skillsDir?: string, user: string = SKILLS_USER_ID) {
    this.root = path.resolve(skillsDir ?? process.env.SKILLS_DIR ?? SKILLS_DIR);
    this.statePath = path.join(SKILLS_STATE_DIR, "users", user, "skills.json");
  }

  // --- index --------------------------------------------------------------

  /** Re-scan the tree into the in-memory index; returns the skill count. */
  refresh(): number {
    this.entriesIndex = scanEntries(this.root);
    return this.entriesIndex.length;
  }

  private entriesIndex: SkillEntry[] | null = null;

  private entries(): SkillEntry[] {
    if (this.entriesIndex === null) {
      this.entriesIndex = scanEntries(this.root);
    }
    return this.entriesIndex.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  /** Enabled skills as {name, description, path} — the agent-facing view. */
  listSkills(): Array<{ name: string; description: string; path: string }> {
    const disabled = new Set(this.disabled());
    return this.entries()
      .filter((e) => !disabled.has(e.relDir))
      .map((e) => ({ name: e.name, description: e.description, path: e.key }));
  }

  /** Admin view: every skill plus its enabled state (REST/SettingsTab). */
  listAll(): Array<SkillEntry & { path: string; enabled: boolean }> {
    const disabled = new Set(this.disabled());
    return this.entries().map((e) => ({
      ...e,
      path: e.key,
      enabled: !disabled.has(e.relDir),
    }));
  }

  /** System-prompt block: names + descriptions ONLY (progressive disclosure). */
  renderIndex(): string {
    const skills = this.listSkills();
    if (!skills.length) return "";
    return (
      "<skills_index>\n" +
      skills.map((s) => `- ${s.name}: ${s.description}`).join("\n") +
      "\n</skills_index>"
    );
  }

  /** Find an *enabled* skill by frontmatter name, rel dir or basename. */
  resolve(name: string): SkillEntry | null {
    const disabled = new Set(this.disabled());
    for (const e of this.entries()) {
      if (disabled.has(e.relDir)) continue;
      const base = e.relDir.split("/").pop()!;
      if (e.name === name || e.relDir === name || base === name) return e;
    }
    return null;
  }

  /** Full SKILL.md content — the progressive-disclosure second step. */
  loadSkill(name: string): string {
    const entry = this.resolve(name);
    if (!entry) return `Rejected: no skill named ${JSON.stringify(name)}`;
    try {
      return fs.readFileSync(entry.key, "utf8");
    } catch (e) {
      return `Error: ${(e as Error).message}`;
    }
  }

  // --- state (per-user toggles) --------------------------------------------

  private loadState(): DisabledState {
    try {
      return JSON.parse(fs.readFileSync(this.statePath, "utf8")) as DisabledState;
    } catch {
      return { disabled: [] };
    }
  }

  private saveState(state: DisabledState): void {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    fs.writeFileSync(this.statePath, `${JSON.stringify(state, null, 1)}\n`, "utf8");
  }

  private disabled(): string[] {
    const doc = this.loadState();
    return Array.isArray(doc.disabled) ? doc.disabled.map(String) : [];
  }

  /** Hermes-style toggle. Disabled skills vanish from index/load until
   *  re-enabled; takes full effect next session (index is injected once). */
  setEnabled(nameOrRel: string, enabled: boolean): string {
    const entry =
      this.resolve(nameOrRel) ??
      this.entries().find(
        (e) => e.name === nameOrRel || e.relDir.split("/").pop() === nameOrRel || e.relDir === nameOrRel,
      );
    if (!entry) {
      // toggling an unknown skill: admin view must see it even if disabled —
      // rescan without the disabled filter for a truthful status
      const all = this.listAll().find(
        (s) => s.name === nameOrRel || s.relDir === nameOrRel || s.relDir.split("/").pop() === nameOrRel,
      );
      const relDir = all?.relDir ?? null;
      if (!relDir) return `Rejected: no skill named ${JSON.stringify(nameOrRel)}`;
      return this.applyToggle(relDir, enabled);
    }
    return this.applyToggle(entry.relDir, enabled);
  }

  private applyToggle(relDir: string, enabled: boolean): string {
    const state = this.loadState();
    const next = new Set(Array.isArray(state.disabled) ? state.disabled : []);
    if (enabled) next.delete(relDir);
    else next.add(relDir);
    state.disabled = [...next].sort();
    this.saveState(state);
    this.entriesIndex = null; // visibility changes → rebuild
    return `OK: ${enabled ? "enabled" : "disabled"} skill ${JSON.stringify(relDir)}`;
  }

  // --- curation ----------------------------------------------------------------

  createSkill(name: string, description: string, content: string, category?: string | null): string {
    if (!NAME_RE.test(name)) {
      return `Rejected: skill name must match ${NAME_RE.source} (got ${JSON.stringify(name)})`;
    }
    if (category && !NAME_RE.test(category)) {
      return `Rejected: category must be a slug (got ${JSON.stringify(category)})`;
    }
    const key = this.skillKey(name, category ?? null);
    if (fs.existsSync(key)) {
      return `Rejected: skill ${JSON.stringify(name)} already exists; use patch or edit`;
    }
    if (!content.trim()) return "Rejected: skill body is empty";
    fs.mkdirSync(path.dirname(key), { recursive: true });
    fs.writeFileSync(key, frontmatterTemplate(name, description) + content.trim() + "\n", "utf8");
    this.updateEntry(key);
    return `OK: created skill ${JSON.stringify(name)} at ${key}`;
  }

  /** Targeted update (the PREFERRED action): replace one exact string. */
  patchSkill(name: string, oldText: string, newText: string): string {
    const outcome = this.rmw(name, (text) => {
      if (!text.includes(oldText)) {
        return rejection(`Rejected: old_text not found in ${name}'s SKILL.md`);
      }
      return text.replace(oldText, newText);
    });
    return outcome || `OK: patched ${JSON.stringify(name)}`;
  }

  /** Full body rewrite (frontmatter preserved). Discouraged vs patch. */
  editSkill(name: string, content: string): string {
    const outcome = this.rmw(name, (text, entry) => {
      const nf = content.match(/^---[\s\S]*?---\n\n?/);
      if (nf) {
        // user supplied frontmatter: replace name/description to match
        return frontmatterTemplate(entry.name, metaOf(content).description ?? entry.description) +
          content.slice(nf[0].length).trimEnd() + "\n";
      }
      const part = text.split("---");
      const fm = part.length >= 3 ? `${part[0]}---${part[1]}---\n\n` : "";
      return fm + content.replace(/^---[\s\S]*?---\n\n?/, "").trimEnd() + "\n";
    });
    return outcome || `OK: patched ${JSON.stringify(name)}`;
  }

  deleteSkill(name: string): string {
    const entry = this.resolve(name) ?? this.listAll().find((s) => s.name === name || s.relDir.split("/").pop() === name);
    if (!entry) return `Rejected: no skill named ${JSON.stringify(name)}`;
    const dir = path.dirname(entry.key);
    fs.rmSync(dir, { recursive: true, force: true });
    const ml = entry;
    this.entriesIndex = (this.entriesIndex ?? []).filter((e) => e.relDir !== ml.relDir);
    return `OK: deleted skill ${JSON.stringify(entry.relDir)}`;
  }

  private guardedKey(name: string, relativePath: string): { key: string; skill: SkillEntry } | null {
    const entry = this.resolve(name);
    if (!entry) return null;
    const rel = String(relativePath ?? "");
    if (!rel || rel.startsWith("/") || rel.includes("\\") || rel.split("/").includes("..") || rel.endsWith("/")) {
      return null;
    }
    return { key: path.join(path.dirname(entry.key), rel), skill: entry };
  }

  writeSkillFile(name: string, relativePath: string, content: string): string {
    const g = this.guardedKey(name, relativePath);
    if (!g) {
      if (!this.resolve(name)) return `Rejected: no skill named ${JSON.stringify(name)}`;
      return `Rejected: invalid relative path ${JSON.stringify(relativePath)}`;
    }
    fs.mkdirSync(path.dirname(g.key), { recursive: true });
    fs.writeFileSync(g.key, content, "utf8");
    return `OK: wrote ${JSON.stringify(relativePath)} in ${JSON.stringify(g.skill.name)}`;
  }

  removeSkillFile(name: string, relativePath: string): string {
    const g = this.guardedKey(name, relativePath);
    if (!g) {
      if (!this.resolve(name)) return `Rejected: no skill named ${JSON.stringify(name)}`;
      return `Rejected: invalid relative path ${JSON.stringify(relativePath)}`;
    }
    if (!fs.existsSync(g.key)) {
      return `Rejected: ${JSON.stringify(relativePath)} not found in ${JSON.stringify(g.skill.name)}`;
    }
    fs.rmSync(g.key);
    return `OK: removed ${JSON.stringify(relativePath)} from ${JSON.stringify(g.skill.name)}`;
  }

  // --- internals ---------------------------------------------------------------

  private skillKey(name: string, category: string | null): string {
    const base = category ? path.join(this.root, category) : this.root;
    return path.join(base, name, SKILL_FILE);
  }

  private updateEntry(key: string): void {
    // relDir is the skill DIRNAME (strip SKILL.md), matching scanEntries/python
    const relDir = path.relative(this.root, path.dirname(key)).split(path.sep).join("/");
    try {
      const text = fs.readFileSync(key, "utf8");
      const { meta } = frontmatter(text);
      // the base scan may ALREADY include the freshly-written file — dedupe
      // first, then append
      const arr = (this.entriesIndex ?? scanEntries(this.root)).filter((e) => e.relDir !== relDir);
      this.entriesIndex = [
        ...arr,
        {
          relDir,
          key,
          name: meta.name || relDir.split("/").pop()!,
          description: meta.description ?? "",
        },
      ];
    } catch {
      this.entriesIndex = (this.entriesIndex ?? []).filter((e) => e.relDir !== relDir);
    }
  }

  /** Read-modify-write with bounded retry (local CAS-lite: re-scan between
   *  attempts; single-writer in-process so conflicts are starved here). */
  private rmw(name: string, mutate: (text: string, entry: SkillEntry) => string): string {
    for (let attempt = 0; attempt < 3; attempt++) {
      const entry = this.resolve(name);
      if (!entry) return `Rejected: no skill named ${JSON.stringify(name)}`;
      let text: string;
      try {
        text = fs.readFileSync(entry.key, "utf8");
      } catch {
        this.entriesIndex = null;
        continue;
      }
      try {
        const next = mutate(text, entry);
        if (typeof next !== "string") return next; // rejection from mutate
        fs.writeFileSync(entry.key, next, "utf8");
        this.updateEntry(entry.key);
        return "";
      } catch (e) {
        if (e instanceof Rejection) return e.message;
      }
    }
    return `Error: could not update ${JSON.stringify(name)} after 3 attempts`;
  }
}

class Rejection extends Error {}

function rejection(msg: string): never {
  throw new Rejection(msg);
}

export function frontmatterTemplate(name: string, description: string): string {
  const safe = String(description ?? "").replace(/"/g, "'");
  return `---\nname: ${name}\ndescription: "${safe}"\nversion: 1.0.0\n---\n\n`;
}

function metaOf(text: string): Record<string, string> {
  return frontmatter(text.startsWith("---") ? text : "---\n---\n" + text).meta;
}

function scanEntries(root: string): SkillEntry[] {
  const out: SkillEntry[] = [];
  const visit = (dir: string) => {
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (item.name.startsWith(".")) continue;
      const p = path.join(dir, item.name);
      if (item.isDirectory()) visit(p);
      else if (item.isFile() && item.name === SKILL_FILE) {
        try {
          const { meta } = frontmatter(fs.readFileSync(p, "utf8"));
          const relDir = path.relative(root, path.dirname(p)).split(path.sep).join("/");
          out.push({
            relDir,
            key: p,
            name: meta.name || relDir.split("/").pop()!,
            description: meta.description ?? "",
          });
        } catch {
          /* unreadable SKILL.md: skip */
        }
      }
    }
  };
  visit(root);
  return out;
}
