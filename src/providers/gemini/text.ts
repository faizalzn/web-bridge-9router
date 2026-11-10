// Turns the cumulative reply text of Gemini into clean deltas for API clients.
//
// Gemini's web app puts a placeholder link at the end of some replies
// (http://googleusercontent.com/<kind>_content/<id>) that the page renders as a card.
// API clients must not see it. While streaming, a half-received placeholder and trailing
// whitespace are held back until it is clear they are not part of the answer.

const PLACEHOLDER = /\s*https?:\/\/(?:www\.)?googleusercontent\.com\/[a-z0-9_]+_content\/[A-Za-z0-9_\-/.]*/gi;
const PLACEHOLDER_HEAD = 'http://googleusercontent.com/';

/** Text safe to show to the client. While `final` is false, an unfinished tail is withheld. */
export function cleanReply(text: string, final: boolean): string {
  let t = text.replace(PLACEHOLDER, '');
  if (!final) {
    const cut = t.lastIndexOf('http');
    if (cut !== -1) {
      const tail = t.slice(cut);
      const head = PLACEHOLDER_HEAD.replace('http://', tail.startsWith('https') ? 'https://' : 'http://');
      // Could still turn into a placeholder (partial scheme/host, or a placeholder without its id yet)
      if (!/\s/.test(tail) && (head.startsWith(tail) || tail.startsWith(head))) t = t.slice(0, cut);
    }
  }
  return t.trimEnd();
}

/** Converts a growing cumulative text into the new characters since the last call. */
export class DeltaEmitter {
  private emitted = '';

  /** Returns the characters to send now (may be empty). */
  push(cumulative: string, final = false): string {
    const clean = cleanReply(cumulative, final);
    if (clean.startsWith(this.emitted)) {
      const delta = clean.slice(this.emitted.length);
      this.emitted = clean;
      return delta;
    }
    // The server rewrote text we already sent. It cannot be taken back, so only keep what is common.
    let i = 0;
    while (i < this.emitted.length && i < clean.length && this.emitted[i] === clean[i]) i++;
    return i === this.emitted.length ? clean.slice(i) : '';
  }

  get text(): string { return this.emitted; }
}

// Gemini's web app sometimes fails internally and answers with a canned message instead of a reply. It arrives as
// ordinary text, so without this check the client would take it for the model's answer (and keep it in the history).
// Only messages actually seen in our logs are listed.
const FAILURE_REPLIES = [
  'I encountered an error doing what you asked. Could you try again?',
  'Sorry, something went wrong. Please try your request again.',
].map((s) => s.toLowerCase());

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** True when the whole reply is one of Gemini's canned failure messages. */
export function isFailureReply(text: string): boolean {
  return FAILURE_REPLIES.includes(norm(text));
}

/** True while a reply that is still arriving could turn out to be a canned failure message. */
export function couldBeFailureReply(text: string): boolean {
  const t = norm(text);
  return t.length > 0 && FAILURE_REPLIES.some((f) => f.startsWith(t));
}
