import { useEffect, useRef } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { isValidElement, type ReactNode } from "react";
import { Bot, Check, LoaderCircle, SquareTerminal, UserRound, X } from "lucide-react";
import { ChartCard } from "../charts/ChartCard";
import { parseChartSpec } from "../charts/yahoo";
import type { FeedItem, MessageItem, ToolCall } from "../types";

// ```vela-chart fenced blocks render as live chart cards (the agent emits
// them; pasting one into the composer renders it too). Everything else keeps
// the default markdown rendering.
const MD_COMPONENTS = {
  pre: ({ children }: { children?: ReactNode }) => {
    const child = Array.isArray(children) ? children[0] : children;
    const isChart =
      isValidElement(child) &&
      (child.props as { className?: string }).className === "language-vela-chart";
    return isChart ? <>{children}</> : <pre>{children}</pre>;
  },
  code: ({ className, children }: { className?: string; children?: ReactNode }) => {
    if (className === "language-vela-chart") {
      const spec = parseChartSpec(String(children));
      if (spec) return <ChartCard spec={spec} />;
    }
    return <code className={className}>{children}</code>;
  },
};

// User messages keep their plain pre-wrap rendering except for pasted
// ```vela-chart blocks, which render as cards too.
// User messages keep their plain pre-wrap rendering except for pasted
// vela-chart blocks, which render as cards too.
function UserContent({ content }: { content: string }) {
  const parts = content.split(/```vela-chart\s*\n([\s\S]*?)```/g);
  if (parts.length === 1) return <div className="user-content">{content}</div>;
  return (
    <div className="user-content">
      {parts.map((part, i) =>
        i % 2 === 0 ? (
          part && <span key={i}>{part}</span>
        ) : (
          (() => {
            const spec = parseChartSpec(part);
            return spec ? <ChartCard key={i} spec={spec} /> : <span key={i}>{part}</span>;
          })()
        )
      )}
    </div>
  );
}

function shortArgs(args: Record<string, unknown>): string {
  const raw = JSON.stringify(args);
  return raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
}

function ToolRow({ call }: { call: ToolCall }) {
  return (
    <div className="tool-call">
      <span className="row-icon">
        <SquareTerminal size={12} strokeWidth={2} />
      </span>
      {call.name}({shortArgs(call.args)})
    </div>
  );
}

function MessageRow({ item }: { item: MessageItem }) {
  if (item.role === "user") {
    return (
      <div className="msg user">
        <div className="role-label">
          <span className="role-icon">
            <UserRound size={13} strokeWidth={2.2} />
          </span>
          you
        </div>
        <UserContent content={item.content} />
      </div>
    );
  }

  if (item.role === "tool") {
    // Transport status is always "success" for a completed tool; outcome
    // labels key off content ("Error:"/"Rejected:" are in-band strings).
    // Tool outputs carry diagnostics INSIDE the content (execute prints
    // 'Error output:' + non-`Exit code: 0'): treat those as failures too.
    const failed =
      item.status === "error" ||
      item.content.startsWith("Rejected:") ||
      item.content.startsWith("Error:") ||
      item.content.includes("Error output:") ||
      /Exit code: (?!0\b)\d+/.test(item.content);
    return (
      <details className={`tool-result${failed ? " failed" : ""}`}>
        <summary>
          <span className={`row-icon ${failed ? "ico-err" : "ico-ok"}`}>
            {failed ? <X size={12} strokeWidth={2.4} /> : <Check size={12} strokeWidth={2.4} />}
          </span>
          {item.toolName ?? "tool"} · {failed ? "failed" : "success"}
        </summary>
        <pre>{item.content}</pre>
      </details>
    );
  }

  return (
    <div className="msg assistant">
      <div className="role-label">
        <span className="role-icon">
          <Bot size={13} strokeWidth={2.2} />
        </span>
        agent
      </div>
      {item.toolCalls?.map((call) => <ToolRow key={call.id} call={call} />)}
      {item.content && (
        <div className="md">
          <Markdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{item.content}</Markdown>
        </div>
      )}
    </div>
  );
}

// Rendered at the bottom of the feed whenever a turn is in flight —
// covers both "waiting for the model" and "tools running" gaps.
function ThinkingRow() {
  return (
    <div className="msg assistant thinking-row">
      <div className="role-label">
        <span className="role-icon thinking-icon">
          <LoaderCircle size={13} strokeWidth={2.2} />
        </span>
        <span className="thinking-text">
          thinking
          <span className="thinking-dots">
            <span>.</span>
            <span>.</span>
            <span>.</span>
          </span>
        </span>
      </div>
    </div>
  );
}

export default function Feed({
  items,
  streaming,
}: {
  items: FeedItem[];
  streaming?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [items, streaming]);

  return (
    <div
      className="feed-scroll"
      ref={scrollRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      {items.map((item) => {
        if (item.kind === "system") {
          return (
            <div key={item.id} className={`system-row ${item.tone}`}>
              {item.text}
            </div>
          );
        }
        if (item.kind === "notice") {
          return (
            <div key={item.id} className={`notice ${item.tone}`}>
              {item.text}
            </div>
          );
        }
        return <MessageRow key={item.id} item={item} />;
      })}
      {streaming && <ThinkingRow />}
    </div>
  );
}
