import { useRef, useState } from "react";

interface Props {
  streaming: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}

export default function Composer({ streaming, onSend, onStop }: Props) {
  const [text, setText] = useState("");
  const areaRef = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    const trimmed = text.trim();
    if (!streaming && trimmed) {
      onSend(trimmed);
      setText("");
      if (areaRef.current) areaRef.current.style.height = "auto";
    }
  };

  const autoResize = () => {
    const el = areaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    }
  };

  return (
    <div className="composer">
      <textarea
        ref={areaRef}
        value={text}
        placeholder={streaming ? "agent is working — Stop to interrupt…" : "Message the agent…"}
        onChange={(e) => {
          setText(e.target.value);
          autoResize();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        rows={1}
        disabled={false}
      />
      {streaming ? (
        <button className="stop" onClick={onStop} title="Cancel the current turn (partial state is saved)">
          ■ Stop
        </button>
      ) : (
        <button className="send" onClick={submit} disabled={!text.trim()}>
          Send ⏎
        </button>
      )}
    </div>
  );
}
