// Tiny leveled logger — diagnostics to stderr only (stdout stays protocol-clean
// for SSE payloads; mirrors main.py's agent.log file-handler doctrine).

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

export const log = {
  info(msg: string): void {
    console.error(`${stamp()} INFO ${msg}`);
  },
  warn(msg: string): void {
    console.error(`${stamp()} WARN ${msg}`);
  },
  error(msg: string): void {
    console.error(`${stamp()} ERROR ${msg}`);
  },
};
