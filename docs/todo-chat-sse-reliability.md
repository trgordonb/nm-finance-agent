# TODO — harden normal chat SSE against idle/client disconnects

**Status:** implemented on the dev box, 2026-10-25 — heartbeat + disconnect-abort in `src/index.ts` (`/api/chat`), wire parsing + post-`done` tolerance extracted to `frontend/src/sse.ts` (used by `streamChat`), tests in `src/tests/chat-sse.test.ts` (5). `npm run check`, `npm test` (168) and `npm --prefix frontend run build` all green. Deploy: git pull + `npm ci` + `npm --prefix frontend run build` + restart `nm-finance-agent`.
**Owner:** coding agent on the other side
**Context commit:** `c75ee4d` (`main`)

## Symptom

During a long two-turn session, the browser showed:

```text
error: Error in input stream
```

The turn looked stopped in the UI, but the backend continued and completed it.

## Trace evidence

LangSmith traces:

- `c3a5be8b-d588-413e-9e62-75917853dc35` — **success**, 17 iterations, 5m 29s
- `b0c22d27-83bf-414a-acb1-561aa1339a2d` — **success**, 21 iterations, 11m 54s

The second trace was initially `pending` when checked, then completed at
`09:55:38 UTC`. There was no error child run, `cancelled=false`, and the final
message was persisted in session `696cda52-ae52-4c9c-8e20-61c64dba90ca`
(`nmtest`). The server journal showed no exception.

**Conclusion:** the model/tool turn did not fail. The browser's SSE stream was
interrupted; the UI surfaced the raw stream-reader error. The server kept the
turn alive after the client stopped reading.

## Relevant code

- `src/index.ts` — `POST /api/chat` normal-turn SSE route (around the
  `app.post("/api/chat", ...)` block).
  - It sends event blocks via `write()`.
  - Deep-research turns have a `ping` callback and send `: ping\n\n`; normal
    chat turns do not.
  - The route does not abort the turn when the client disconnects. `abandoned`
    only suppresses writes after `controller.abort()`.
  - `POST /api/chat/cancel` already exists for the Stop button.
- `frontend/src/api.ts` — `streamChat()` reads `res.body` manually and throws
  the browser stream error to the caller.
- `frontend/src/App.tsx` — the chat catch block displays
  `error: ${err.message}`; a truncated stream therefore appears as a UI error
  even when the turn completed server-side.

Caddy already uses `flush_interval -1`, so no proxy change is needed.

## Proposed fix

1. **Heartbeat normal chat SSE.** While a normal `/api/chat` turn is active,
   send an SSE comment such as `: ping\n\n` every 15–20 seconds, guarded by
   `!abandoned && !res.writableEnded && !res.destroyed`. Clear the timer in
   `finally`. The frontend parser ignores blocks with no `data:` line, so this
   is backward-compatible.
2. **Abort on client disconnect.** Listen for the response/request close; if
   the response has not completed normally, mark the turn abandoned and call
   `controller.abort()`. Preserve the existing valid-prefix persistence path.
   Do not abort after a normal `done`/`res.end()`.
3. **Ignore post-`done` stream errors.** In `streamChat()`, track receipt of the
   `done` event. If the body reader throws after `done`, do not surface it as a
   failed turn. Only report a stream error if no terminal event was received.
4. **Add focused coverage.** At minimum verify:
   - the heartbeat does not corrupt SSE parsing;
   - a disconnect aborts a simulated active turn;
   - Stop still uses `/api/chat/cancel` and persists the valid prefix;
   - a completed turn is not marked cancelled by the disconnect handler.
5. **Verify and deploy.** Run `npm run check`, `npm test`, and
   `npm --prefix frontend run build` if the frontend changes. Restart
   `nm-finance-agent`; test a deliberately slow turn and confirm the UI stays
   connected, the final message persists, and the LangSmith trace has no error.

## Acceptance criteria

- A turn with >2 minutes of silent LLM/tool work does not produce
  `Error in input stream`.
- If the browser really disconnects, the server aborts the upstream call and
  persists only the valid prefix.
- A normal completed turn remains persisted and is not marked cancelled.
- Stop still works through the existing cancel endpoint.
- No secrets or trace payloads are added to logs or docs.
