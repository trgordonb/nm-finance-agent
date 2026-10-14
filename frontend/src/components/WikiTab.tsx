// Native Wiki tab: browse and search the compiled llmwiki knowledge base over
// the read-only /api/wiki/* proxy. Stage 2 of docs/wiki-tab-plan.md:
// cross-domain scope ("all domains"), server-side hybrid search, and an
// "ask the agent" handoff that prefills the composer (chat stays the writer).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { BookOpen, LoaderCircle, MessageSquare, Network, RefreshCw, X } from "lucide-react";
import { getWikiConcepts, getWikiDomains, getWikiPage, searchWiki } from "../api";
import type { WikiDomain, WikiGist, WikiSearchHit } from "../types";
import WikiGraph from "./WikiGraph";

interface Props {
  /** Hand a page off to the chat agent (prefills the composer, focuses chat). */
  onAsk: (text: string) => void;
}

/** A concept gist plus the domain it came from — required once the list can
 *  span domains ("all"), and for opening cross-domain search hits. */
interface WikiPageRef extends WikiGist {
  domain: string;
}

/** Scope sentinel: every registered domain. */
const ALL = "*";

/** The service returns frontmatter + body; the UI shows title/gist from the
 *  gists index, so the YAML block is dropped before rendering. */
function stripFrontmatter(md: string): string {
  return md.replace(/^---\n[\s\S]*?\n---[ ]*\n?/, "");
}

/** react-markdown's default URL sanitizer strips unknown schemes to `""` —
 *  `wiki:` links then rendered as `href="" target="_blank"` (a new browser tab
 *  of the app home). The scheme is internal and safe; keep it and let
 *  everything else go through the default sanitizer. */
function wikiUrlTransform(url: string): string {
  return url.startsWith("wiki:") ? url : defaultUrlTransform(url);
}

/** Resolve `[[target|label]]` into `[label](wiki:<page-slug>)` so the link
 *  renderer below can intercept it:
 *  - `sources/<id>` (the compiler's `## Sources` row form) addresses the
 *    source-note page, whose REST slug is the bare id;
 *  - a link without an alias shows the known page's title (falls back to the
 *    raw target), so "Pages compiled from this source" reads as page names. */
function resolveWikilinks(md: string, concepts: WikiGist[]): string {
  const titles = new Map(concepts.map((c) => [c.slug, c.title]));
  // Fold the compiler's "## Sources" rows ("- [[sources/<id>]] - <title>")
  // into an aliased link, so the title doesn't render twice once labelled.
  const folded = md.replace(
    /^- \[\[sources\/([^\]|]+)\]\] - (.+)$/gm,
    (_match, id: string, title: string) => `- [[sources/${id}|${title.trim()}]]`,
  );
  return folded.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_match, target: string, label?: string) => {
      const raw = String(target).trim();
      const slug = raw.replace(/^sources\//, "");
      const text = String(label ?? titles.get(slug) ?? raw).trim();
      return `[${text}](wiki:${encodeURIComponent(slug)})`;
    },
  );
}

const byUpdated = (a: WikiPageRef, b: WikiPageRef) =>
  (b.updated ?? "").localeCompare(a.updated ?? "") || a.title.localeCompare(b.title);

function hitLabel(hit: WikiSearchHit): string {
  const title = typeof hit.metadata?.title === "string" ? hit.metadata.title : "";
  return title || hit.slug || hit.source_id || hit.id;
}

/** Where a search hit opens: wiki hits are pages; chunk hits open the source
 *  note page that the chunk came from (slug = source id). */
function hitTarget(hit: WikiSearchHit): { domain: string; slug: string } | null {
  const slug = hit.origin === "wiki" ? hit.slug : hit.source_id;
  return slug ? { domain: hit.domain, slug } : null;
}

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 90 ? `${flat.slice(0, 90)}…` : flat;
}

export default function WikiTab({ onAsk }: Props) {
  const [domains, setDomains] = useState<WikiDomain[]>([]);
  const [scope, setScope] = useState<string>(ALL);
  const [concepts, setConcepts] = useState<WikiPageRef[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WikiSearchHit[] | null>(null);
  const [current, setCurrent] = useState<WikiPageRef | null>(null);
  const [page, setPage] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);
  const [loadingPage, setLoadingPage] = useState(false);
  const [graphMode, setGraphMode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // stale-response guards: only the newest page/search request may win
  const reqRef = useRef(0);
  const searchRef = useRef(0);

  const loadScope = useCallback(async (next: string, list: WikiDomain[]) => {
    setScope(next);
    setCurrent(null);
    setPage(null);
    setConcepts([]);
    setError(null);
    try {
      let loaded: WikiPageRef[];
      if (next === ALL) {
        const per = await Promise.all(
          list.map(async (d) =>
            (await getWikiConcepts(d.name)).map((g) => ({ ...g, domain: d.name })),
          ),
        );
        loaded = per.flat().sort(byUpdated);
      } else {
        loaded = (await getWikiConcepts(next)).map((g) => ({ ...g, domain: next }));
      }
      setConcepts(loaded);
      if (loaded.length) setCurrent(loaded[0]);
    } catch (err) {
      setError(`failed to load pages: ${(err as Error).message}`);
    }
  }, []);

  const bootstrap = useCallback(
    async (nextScope: string) => {
      setBooting(true);
      setError(null);
      try {
        const list = await getWikiDomains();
        setDomains(list);
        const target =
          nextScope === ALL || list.some((d) => d.name === nextScope) ? nextScope : ALL;
        await loadScope(target, list);
      } catch (err) {
        setError(
          `llmwiki unreachable — is the service up at :8010? (${(err as Error).message})`,
        );
      } finally {
        setBooting(false);
      }
    },
    [loadScope],
  );

  useEffect(() => {
    void bootstrap(ALL);
  }, [bootstrap]);

  // Page body for the current selection.
  useEffect(() => {
    if (!current) return;
    const n = ++reqRef.current;
    setLoadingPage(true);
    setPage(null);
    getWikiPage(current.slug, current.domain)
      .then((md) => {
        if (reqRef.current === n) setPage(md);
      })
      .catch((err) => {
        if (reqRef.current === n) setError(String(err));
      })
      .finally(() => {
        if (reqRef.current === n) setLoadingPage(false);
      });
  }, [current]);

  // Hybrid search (debounced); scoped to the selected domain, or every domain
  // when the scope is "all".
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      return;
    }
    const n = ++searchRef.current;
    const handle = window.setTimeout(() => {
      searchWiki(q, scope === ALL ? null : scope)
        .then((hits) => {
          if (searchRef.current === n) setResults(hits);
        })
        .catch((err) => {
          if (searchRef.current === n) setError(`search failed: ${(err as Error).message}`);
        });
    }, 350);
    return () => window.clearTimeout(handle);
  }, [query, scope]);

  const openRef = useCallback(
    (target: { domain: string; slug: string }, titleHint = "", typeHint = "concept") => {
      const gist = concepts.find((c) => c.domain === target.domain && c.slug === target.slug);
      setCurrent(
        gist ?? {
          domain: target.domain,
          slug: target.slug,
          title: titleHint,
          type: typeHint,
          gist: "",
          sources: [],
          updated: null,
          version: 0,
        },
      );
    },
    [concepts],
  );

  // The open page's own domain is the wikilink resolution context.
  const domainConcepts = useMemo(
    () => (current ? concepts.filter((c) => c.domain === current.domain) : []),
    [concepts, current],
  );

  const mdComponents = useMemo(
    () => ({
      a: ({ href, children }: { href?: string; children?: ReactNode }) => {
        if (href?.startsWith("wiki:")) {
          const target = decodeURIComponent(href.slice("wiki:".length));
          const gist = domainConcepts.find((c) => c.slug === target);
          return (
            <a
              href="#"
              className={`wikilink${gist ? "" : " missing"}`}
              title={gist ? gist.title : `${target} — not a page in this domain`}
              onClick={(e) => {
                e.preventDefault();
                if (gist) setCurrent(gist);
              }}
            >
              {children}
            </a>
          );
        }
        return (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        );
      },
    }),
    [domainConcepts],
  );

  const gist = useMemo(
    () => (current ? concepts.find((c) => c.domain === current.domain && c.slug === current.slug) : null),
    [concepts, current],
  );
  const pageTitle = gist?.title || current?.title || current?.slug || "";
  const pageType = gist?.type || current?.type || "concept";

  const askAbout = () => {
    if (!current) return;
    onAsk(
      `About the llmwiki page "${pageTitle}" (domain "${current.domain}", slug "${current.slug}"): ` +
        `use the llm-wiki skill to read it, summarize the key points, and explain how it connects to related pages.`,
    );
  };

  return (
    <div className="wiki-tab">
      <div className="wiki-layout">
        <aside className="wiki-side">
          <div className="wiki-side-head">
            <select
              className="wiki-domain"
              value={scope}
              onChange={(e) => void loadScope(e.target.value, domains)}
              disabled={booting || domains.length === 0}
            >
              <option value={ALL}>all domains</option>
              {domains.map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name}
                </option>
              ))}
            </select>
            <button
              className="wiki-refresh"
              title="Reload from llmwiki"
              onClick={() => void bootstrap(scope)}
              disabled={booting}
            >
              <RefreshCw size={14} />
            </button>
            <button
              className={`wiki-refresh${graphMode ? " active" : ""}`}
              title={graphMode ? "Back to the page view" : "Show the link graph"}
              onClick={() => setGraphMode((v) => !v)}
              disabled={booting}
            >
              <Network size={14} />
            </button>
          </div>
          <div className="wiki-search-row">
            <input
              className="wiki-search"
              placeholder="Search the wiki…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button className="wiki-search-clear" title="Clear search" onClick={() => setQuery("")}>
                <X size={13} />
              </button>
            )}
          </div>
          <div className="wiki-list">
            {results !== null ? (
              <>
                <div className="wiki-results-head">
                  {results.length} result{results.length === 1 ? "" : "s"} for “{query.trim()}”
                </div>
                {results.map((hit) => {
                  const target = hitTarget(hit);
                  const isActive =
                    target &&
                    current &&
                    target.domain === current.domain &&
                    target.slug === current.slug;
                  return (
                    <button
                      key={`${hit.domain}:${hit.id}`}
                      className={`wiki-item${isActive ? " active" : ""}`}
                      onClick={() =>
                        target &&
                        openRef(target, hitLabel(hit), hit.origin === "wiki" ? "concept" : "source")
                      }
                    >
                      <span className="wiki-item-title">{hitLabel(hit)}</span>
                      <span className="wiki-item-meta">
                        <span className={`wiki-type t-${hit.origin}`}>{hit.origin}</span>
                        <span className="wiki-domain-tag">{hit.domain}</span>
                        <span className="wiki-item-gist">{snippet(hit.text)}</span>
                      </span>
                    </button>
                  );
                })}
                {results.length === 0 && <div className="wiki-empty">no matches</div>}
              </>
            ) : (
              <>
                {concepts.map((c) => {
                  const isActive = current?.domain === c.domain && current?.slug === c.slug;
                  return (
                    <button
                      key={`${c.domain}:${c.slug}`}
                      className={`wiki-item${isActive ? " active" : ""}`}
                      onClick={() => setCurrent(c)}
                    >
                      <span className="wiki-item-title">{c.title || c.slug}</span>
                      <span className="wiki-item-meta">
                        <span className={`wiki-type t-${c.type}`}>{c.type}</span>
                        {scope === ALL && <span className="wiki-domain-tag">{c.domain}</span>}
                        <span className="wiki-item-gist">{c.gist}</span>
                      </span>
                    </button>
                  );
                })}
                {!booting && !error && concepts.length === 0 && (
                  <div className="wiki-empty">
                    no pages yet — ingest something with the llm-wiki skill
                  </div>
                )}
              </>
            )}
          </div>
        </aside>
        <section className={`wiki-main${graphMode ? " wiki-graph-pane" : " wiki-tab-scroll"}`}>
          {graphMode ? (
            booting ? (
              <div className="wiki-status">
                <LoaderCircle className="wiki-spin" size={16} /> loading the wiki…
              </div>
            ) : (
              <WikiGraph
                refs={concepts}
                onOpen={(ref) => {
                  openRef(ref);
                  setGraphMode(false);
                }}
              />
            )
          ) : (
            <>
          {error && <div className="wiki-error">{error}</div>}
          {booting && (
            <div className="wiki-status">
              <LoaderCircle className="wiki-spin" size={16} /> loading the wiki…
            </div>
          )}
          {!booting && !error && !current && concepts.length === 0 && (
            <div className="wiki-status">
              <BookOpen size={16} /> nothing to show yet — the wiki grows as the agent ingests
            </div>
          )}
          {current && (
            <article className="wiki-page">
              <header className="wiki-page-head">
                <div className="wiki-page-title-row">
                  <h1>{pageTitle || current.slug}</h1>
                  <button className="wiki-ask" onClick={askAbout} title="Open a chat turn about this page">
                    <MessageSquare size={13} /> Ask the agent
                  </button>
                </div>
                <div className="wiki-page-meta">
                  <span className={`wiki-type t-${pageType}`}>{pageType}</span>
                  <span>{current.domain}</span>
                  {gist?.updated && <span>updated {gist.updated}</span>}
                  {gist && (
                    <span>
                      {gist.sources.length} source{gist.sources.length === 1 ? "" : "s"}
                    </span>
                  )}
                </div>
                {gist?.gist && <p className="wiki-page-gist">{gist.gist}</p>}
              </header>
              {loadingPage ? (
                <div className="wiki-status">
                  <LoaderCircle className="wiki-spin" size={16} /> loading page…
                </div>
              ) : page !== null ? (
                <div className="md wiki-page-body">
                  <Markdown
                    remarkPlugins={[remarkGfm]}
                    components={mdComponents}
                    urlTransform={wikiUrlTransform}
                  >
                    {resolveWikilinks(stripFrontmatter(page), domainConcepts)}
                  </Markdown>
                </div>
              ) : null}
            </article>
          )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
