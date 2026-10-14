// `/research` mode detection — python app.py `_detect_mode`/`_clean_question`
// parity, tightened: the prefix must be a whole token (`/research` followed by
// whitespace or end of message), so "/researchx" is a normal message.

export const RESEARCH_PREFIX = "/research";

export function detectResearchMode(message: string): boolean {
  return /^\/research(\s|$)/.test(message.trim());
}

/** Strip the prefix; the returned text is what the pipeline researches and
 *  what the archive stores as the user question. */
export function cleanResearchQuestion(message: string): string {
  return message
    .trim()
    .replace(/^\/research(\s+|$)/, "")
    .trim();
}
