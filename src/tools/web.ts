// Web tools: web_to_markdown (Jina Reader) + internet_search (Tavily).
// The search backend moved off Jina (s.jina.ai) after an API break — Tavily
// (api.tavily.com/search) is the replacement; the Jina Reader fetch path is
// untouched (it is keyless-optional and still working).

import type { ToolDef } from "../types.js";

function jinaKey(): string {
  return process.env.JINA_API_KEY ?? "";
}

function tavilyKey(): string {
  return process.env.TAVILY_API_KEY ?? "";
}

function jinaHeaders(accept: string): Record<string, string> {
  const h: Record<string, string> = { Accept: accept };
  const key = jinaKey();
  if (key) h.Authorization = `Bearer ${key}`;
  return h;
}

export const web_to_markdown: ToolDef = {
  name: "web_to_markdown",
  description:
    "Fetch one or more URLs (web pages, PDFs, JS-heavy sites) and return clean LLM-friendly Markdown. " +
    "Primary path is the Jina Reader API; URLs that fail there (quota/bot pages) fall back to Tavily Extract.",
  parameters: {
    type: "object",
    properties: {
      urls: {
        type: "array",
        description: "URLs to fetch and convert.",
        items: { type: "string", description: "A full URL including scheme." },
      },
    },
    required: ["urls"],
  },
  async execute(args) {
    const urls = (args.urls ?? []) as string[];
    if (!Array.isArray(urls) || !urls.length) return "Error: no URLs provided";
    const reqHeaders = jinaHeaders("text/plain");
    reqHeaders["X-Remove-Selector"] = "nav, header, footer, aside, .ads, .sidebar, .related-posts, .comments";
    reqHeaders["X-Retain-Images"] = "none";
    reqHeaders["X-Retain-Links"] = "text";
    reqHeaders["X-With-Links-Summary"] = "true";
    reqHeaders["X-Max-Tokens"] = "8000";
    const parts: string[] = [];
    const failures: string[] = [];
    const jinaOutage: Array<{ url: string; reason: string }> = []; // Jina-side failures worth a Tavily attempt

    for (const url of urls) {
      try {
        const res = await fetch(`https://r.jina.ai/${url}`, {
          headers: reqHeaders,
          signal: AbortSignal.timeout(180_000),
        });
        if (res.ok) {
          const content = (await res.text()).trim() || "(empty content)";
          parts.push(`--- Source: ${url} ---\n\n${content}`);
        } else {
          // Payment-required, auth, rate-limit or upstream 5xx → Jina-side
          // outage/out-of-credits; try Tavily Extract for these URLs.
          jinaOutage.push({ url, reason: `HTTP ${res.status}` });
        }
      } catch (e) {
        jinaOutage.push({ url, reason: (e as Error).message.slice(0, 200) });
      }
    }

    if (jinaOutage.length) {
      const tavKey = tavilyKey();
      if (!tavKey) {
        for (const o of jinaOutage) failures.push(`${o.url}: ${o.reason}`);
      } else {
        try {
          const res = await tavilyExtract(
            jinaOutage.map((o) => o.url),
            tavKey,
          );
          // Align by URL: Tavily returns results + failed_results
          for (const { url, reason } of jinaOutage) {
            const hit = (res.results ?? []).find(
              (r: any) => stripScheme(String(r.url ?? "")) === stripScheme(url),
            );
            if (hit && String(hit.raw_content ?? "").trim()) {
              parts.push(`--- Source: ${url} ---\n\n${String(hit.raw_content).trim()}`);
            } else {
              const tavFail = (res.failed_results ?? []).find(
                (f: any) => stripScheme(String(f.url ?? "")) === stripScheme(url),
              );
              failures.push(`${url}: jina ${reason}; tavily: ${tavFail?.error ?? "no extract content"}`);
            }
          }
        } catch (e) {
          for (const { url, reason } of jinaOutage) {
            failures.push(`${url}: jina ${reason}; tavily: ${(e as Error).message.slice(0, 120)}`);
          }
        }
      }
    }

    if (!parts.length) return `Error: all fetches failed: ${failures.join("; ")}`;
    let output = parts.join("\n\n");
    if (failures.length)
      output += `\n\n(Note: some requests failed: ${failures.join("; ")})`;
    return output;
  },
};

function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

async function tavilyExtract(urls: string[], key: string): Promise<any> {
  const res = await fetch("https://api.tavily.com/extract", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ urls, extract_depth: "basic" }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
  }
  return await res.json();
}

export const internet_search: ToolDef = {
  name: "internet_search",
  description:
    "Run a web search via the Tavily API, returning results with title, URL, snippet content (and a relevance score).",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query." },
      max_results: { type: "number", description: "1-20, default 5." },
      topic: { type: "string", description: "'general', 'news', or 'finance'.", enum: ["general", "news", "finance"] },
    },
    required: ["query"],
  },
  async execute(args) {
    const query = String(args.query ?? "");
    const maxResults = Math.max(1, Math.min(Number(args.max_results ?? 5) || 5, 20));
    const topic = String(args.topic ?? "general");
    const key = process.env.TAVILY_API_KEY ?? "";
    if (!key) {
      return "Error: TAVILY_API_KEY is not set. Add it to the environment or .env file (get a key at https://tavily.com).";
    }
    try {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          query,
          topic,
          max_results: maxResults,
          include_answer: false,
          include_raw_content: false,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        const text = await res.text();
        return `Error: Tavily search failed (HTTP ${res.status}): ${text.slice(0, 300)}`;
      }
      const data = (await res.json()) as any;
      const results = data.results ?? [];
      if (!results.length) return "Error: Tavily search returned no results";
      return results
        .map((r: any, i: number) => {
          let content = String(r.content || "");
          if (content.length > 4000) content = `${content.slice(0, 4000)}\n[... content truncated ...]`;
          const score = typeof r.score === "number" ? ` · score ${r.score.toFixed(2)}` : "";
          const date = r.published_date ? ` (${r.published_date})` : "";
          return (
            `--- Result ${i + 1}: ${r.title}${score}${date} ---\n` +
            `URL: ${r.url}\n\n` +
            `${content.trim()}`
          );
        })
        .join("\n\n");
    } catch (e) {
      return `Error: Tavily search failed: ${(e as Error).message}`;
    }
  },
};
