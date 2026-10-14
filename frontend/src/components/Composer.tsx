import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Paperclip, X } from "lucide-react";
import { uploadWikiPdf } from "../api";

interface Props {
  streaming: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  /** Bumped draft injected from outside (e.g. follow-up tips) — `n` triggers. */
  draft?: { text: string; n: number };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function Composer({ streaming, onSend, onStop, draft }: Props) {
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!draft || draft.n === 0) return;
    setText(draft.text);
    const el = areaRef.current;
    if (el) {
      el.focus();
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    }
  }, [draft?.n]);

  const resetHeight = () => {
    if (areaRef.current) areaRef.current.style.height = "auto";
  };

  const pickFile = (e: ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0] ?? null;
    e.target.value = ""; // allow re-picking the same file after a remove
    if (!picked) return;
    if (!(picked.type === "application/pdf" || /\.pdf$/i.test(picked.name))) {
      setError("Only PDF files can be attached for wiki ingestion.");
      return;
    }
    setError(null);
    setFile(picked);
  };

  // A bare attachment IS the wiki-ingest intent; typed text rides along as
  // guidance (e.g. "file this under algotrade").
  const submit = async () => {
    const trimmed = text.trim();
    if (streaming || uploading || (!trimmed && !file)) return;
    if (!file) {
      onSend(trimmed);
      setText("");
      resetHeight();
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const up = await uploadWikiPdf(file);
      const message = trimmed
        ? `${trimmed}\n\n[Attached PDF for wiki ingestion: ${up.path}]`
        : `Ingest the attached PDF into the wiki: ${up.path}`;
      onSend(message);
      setText("");
      setFile(null);
      resetHeight();
    } catch (err) {
      setError(`Upload failed: ${(err as Error).message}`);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="composer">
      {file && (
        <div className="attach-chip">
          <Paperclip size={13} />
          <span className="attach-name" title={file.name}>
            {file.name}
          </span>
          <span className="attach-size">{formatBytes(file.size)}</span>
          <button
            type="button"
            className="attach-remove"
            onClick={() => setFile(null)}
            title="Remove attachment"
            aria-label="Remove attachment"
          >
            <X size={14} />
          </button>
        </div>
      )}
      {error && <div className="attach-error">{error}</div>}
      <div className="composer-row">
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={pickFile}
        />
        <button
          type="button"
          className="attach"
          onClick={() => fileRef.current?.click()}
          disabled={streaming || uploading}
          title="Attach a PDF for wiki ingestion"
        >
          <Paperclip size={18} />
        </button>
        <textarea
          ref={areaRef}
          value={text}
          placeholder={
            streaming
              ? "agent is working — Stop to interrupt…"
              : file
                ? "Optional note (e.g. which domain)…"
                : "Message the agent… (/research for deep research)"
          }
          onChange={(e) => {
            setText(e.target.value);
            if (areaRef.current) {
              areaRef.current.style.height = "auto";
              areaRef.current.style.height = `${Math.min(areaRef.current.scrollHeight, 160)}px`;
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={1}
          disabled={false}
        />
        {streaming ? (
          <button
            className="stop"
            onClick={onStop}
            title="Cancel the current turn (partial state is saved)"
          >
            ■ Stop
          </button>
        ) : (
          <button
            className="send"
            onClick={() => void submit()}
            disabled={(!text.trim() && !file) || uploading}
          >
            {uploading ? "Uploading…" : "Send ⏎"}
          </button>
        )}
      </div>
    </div>
  );
}
