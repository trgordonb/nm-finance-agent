// "Model & key" settings tab: the user's own OpenRouter key (validate + save +
// remove), per-user main/summarizer model overrides with a dismissible free-
// model risk warning, per-user spend summary from the harness ledger, and the
// key-policy banner (warn-only deadline / enforced). The raw key never leaves
// the server.

import { useCallback, useEffect, useState } from "react";
import {
  deleteUserLlmKey,
  getLlmUsage,
  getUserLlmKeyStatus,
  saveUserLlmKey,
  saveUserLlmModels,
} from "../api";
import type { LlmUsageSummary, UserLlmKeyStatus } from "../types";

/** OpenRouter's free variants are conventionally suffixed `:free`. */
function isFreeModel(id: string): boolean {
  return /:free(?::|$)/i.test(id.trim());
}

function fmtUsd(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : `$${v.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

interface Props {
  /** Notify the shell that the effective main model changed. */
  onModelsChanged?: () => void;
}

export default function KeyTab({ onModelsChanged }: Props) {
  const [status, setStatus] = useState<UserLlmKeyStatus | null>(null);
  const [usage, setUsage] = useState<LlmUsageSummary | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [mainModel, setMainModel] = useState("");
  const [summarizerModel, setSummarizerModel] = useState("");
  const [freeDismissedFor, setFreeDismissedFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [modelsSaved, setModelsSaved] = useState(false);

  const load = useCallback(() => {
    getUserLlmKeyStatus()
      .then((s) => {
        setStatus(s);
        setMainModel(s.models.main ?? "");
        setSummarizerModel(s.models.summarizer ?? "");
        setErr(null);
      })
      .catch((e) => setErr(String(e instanceof Error ? e.message : e).slice(0, 160)));
    getLlmUsage(30)
      .then(setUsage)
      .catch(() => setUsage(null));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await saveUserLlmKey(keyInput.trim());
      setKeyInput("");
      setSaved(true);
      load();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e).slice(0, 200));
    } finally {
      setBusy(false);
    }
  };

  const saveModels = async () => {
    setBusy(true);
    setErr(null);
    setModelsSaved(false);
    try {
      await saveUserLlmModels(mainModel.trim(), summarizerModel.trim());
      setModelsSaved(true);
      setSaved(false);
      load();
      onModelsChanged?.();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e).slice(0, 200));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await deleteUserLlmKey();
      load();
    } finally {
      setBusy(false);
    }
  };

  const freeModels = [...new Set(
    [mainModel.trim(), summarizerModel.trim()].filter((model) => model && isFreeModel(model)),
  )].sort();
  const freeKey = freeModels.join("|");
  const showFreeRisk = freeKey !== "" && freeKey !== freeDismissedFor;
  const hasModelOverrides = Boolean(status?.models.main || status?.models.summarizer);
  const storedFree =
    isFreeModel(status?.models.main ?? "") || isFreeModel(status?.models.summarizer ?? "");

  const noKey = !status?.present;
  const warnDeadline = status?.require_user_warn_deadline ?? null;
  const banner =
    status?.policy === "require_user" && noKey
      ? warnDeadline
        ? `⚠ From ${new Date(warnDeadline).toLocaleDateString()} this workspace needs your own OpenRouter key — until then the server key still covers your turns.`
        : "⚠ This workspace requires your own OpenRouter key — chat is disabled until you add one below."
      : null;

  return (
    <main className="skills">
      <div className="skills-inner llmkey">
        <div className="skills-head">
          <h2>Model &amp; key</h2>
        </div>
        <div className="cron-sub">
          Your own OpenRouter key bills your turns (chat, research, scheduled jobs) to your
          account. Stored server-side, encrypted, and never displayed again — only
          {" "}{status?.masked ?? "not set"}.
        </div>

        {banner && (
          <div className={`key-banner${status?.require_user_enforced && noKey ? " err" : ""}`}>{banner}</div>
        )}
        {saved && <div className="key-banner ok">Key validated and saved — your turns now bill to your account.</div>}
        {err && <div className="cron-err">{err}</div>}

        <div className="cron-card">
          <div className="cron-card-head">
            <span className="cron-name">OpenRouter API key</span>
            {status?.present && (
              <span className={`cron-chip ${status.is_free_tier ? "dim" : "ok"}`}>
                {status.is_free_tier ? "free tier" : `usage ${fmtUsd(status.usage_usd)}${status.limit !== null ? ` / ${fmtUsd(status.limit)}` : ""}`}
              </span>
            )}
          </div>
          <div className="cron-meta">
            <span>status: {status?.present ? `configured (${status.masked ?? "key"})` : "not set"}</span>
            {status?.label && <span>label: {status.label}</span>}
            {status && <span>policy: {status.policy}</span>}
          </div>
          <div className="key-form">
            <input
              type="password"
              placeholder="sk-or-v1-…"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              aria-label="OpenRouter API key"
              autoComplete="off"
            />
            <button disabled={busy || !keyInput.trim()} onClick={() => void save()}>
              Validate &amp; save
            </button>
            {status?.present && (
              <button className="cron-danger" disabled={busy} onClick={() => void remove()}>
                Remove key
              </button>
            )}
          </div>
          <div className="cron-sub">
            The key is validated against OpenRouter (no tokens spent) before it is stored, and
            never displayed again. Removing it falls back per the workspace key policy.
          </div>
        </div>

        <div className="cron-card">
          <div className="cron-card-head">
            <span className="cron-name">Model preferences</span>
            {status && (
              <span
                className={`cron-chip ${storedFree ? "dim" : "ok"}`}
              >
                {storedFree
                  ? "free model override"
                  : hasModelOverrides
                    ? "custom overrides"
                    : "workspace defaults"}
              </span>
            )}
          </div>
          <div className="cron-sub">
            These override the workspace defaults for your turns. Leave a field blank to use the
            default. Changes apply to subsequent LLM calls.
          </div>
          <div className="key-model-grid">
            <label className="key-model-field">
              <span>
                Main model
                {isFreeModel(mainModel) && <span className="key-model-free">free</span>}
              </span>
              <input
                value={mainModel}
                onChange={(e) => setMainModel(e.target.value)}
                placeholder={status?.models.default_main ?? "workspace default"}
                aria-label="Main model ID"
                autoComplete="off"
                spellCheck={false}
                maxLength={200}
              />
            </label>
            <label className="key-model-field">
              <span>
                Summarizer model
                {isFreeModel(summarizerModel) && <span className="key-model-free">free</span>}
              </span>
              <input
                value={summarizerModel}
                onChange={(e) => setSummarizerModel(e.target.value)}
                placeholder={status?.models.default_summarizer ?? "workspace default"}
                aria-label="Summarizer model ID"
                autoComplete="off"
                spellCheck={false}
                maxLength={200}
              />
            </label>
          </div>

          {showFreeRisk && (
            <div className="key-banner free" role="status">
              <span className="key-banner-free-text">
                <strong>Free-model risk:</strong> {freeModels.join(", ")}. Free OpenRouter models
                can be rate-limited, slower, or withdrawn without notice, and free endpoints may
                log or train on prompts under their terms. Avoid confidential data here. You can
                still save and use them.
              </span>
              <button
                type="button"
                className="key-banner-dismiss"
                onClick={() => setFreeDismissedFor(freeKey)}
              >
                Dismiss
              </button>
            </div>
          )}

          <div className="key-form key-model-actions">
            <button disabled={busy} onClick={() => void saveModels()}>
              Save models
            </button>
            <button
              disabled={busy}
              onClick={() => {
                setMainModel("");
                setSummarizerModel("");
                setFreeDismissedFor(null);
                setModelsSaved(false);
              }}
            >
              Clear fields
            </button>
          </div>
          {modelsSaved && (
            <div className="key-banner ok">Model preferences saved — subsequent LLM calls use them.</div>
          )}
          {status && (
            <div className="cron-meta">
              <span>
                effective main: {status.models.effective_main}
                {status.models.main_free ? " (free)" : ""}
              </span>
              <span>
                effective summarizer: {status.models.effective_summarizer}
                {status.models.summarizer_free ? " (free)" : ""}
              </span>
            </div>
          )}
        </div>

        <div className="cron-card">
          <div className="cron-card-head">
            <span className="cron-name">Your usage — last 30 days</span>
          </div>
          {usage ? (
            <div className="cron-meta">
              <span>{usage.totals.calls} LLM calls</span>
              <span>in {fmtTokens(usage.totals.prompt_tokens)} / out {fmtTokens(usage.totals.completion_tokens)} tokens</span>
              <span>cost {fmtUsd(usage.totals.cost_usd)}</span>
            </div>
          ) : (
            <div className="cron-sub">no usage recorded yet</div>
          )}
          {usage && usage.days.length > 0 && (
            <div className="key-days">
              {usage.days.slice(-7).map((d) => (
                <div className="cron-run" key={d.day}>
                  <span className="cron-run-when">{d.day}</span>
                  <span className="cron-run-dur">{d.calls} calls</span>
                  <span className="cron-run-excerpt">
                    in {fmtTokens(d.prompt_tokens)} / out {fmtTokens(d.completion_tokens)} · {fmtUsd(d.cost_usd)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
