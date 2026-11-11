// One canonical text form for tool calls and tool results. It is used in three places that must agree:
// the instructions that tell the model how to call a tool, the history that is sent back to it, and the
// parser that reads its replies. Because the form is canonical, the history a client resends looks exactly
// like the reply the web chat already holds, so the conversation cache can still recognise it.

export const CALL_OPEN = '<tool_call>';
export const CALL_CLOSE = '</tool_call>';

/** Same value with object keys in sorted order (arrays keep their order). */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  }
  return v;
}

/**
 * Arguments as compact JSON with sorted keys, so that equal calls always render equally. Clients re-serialize the
 * calls they send back (9router/Hermes put {"path","content"} back as {"content","path"}), and without sorting the
 * conversation cache would no longer recognise the history.
 */
function compactArguments(args: string): string {
  if (!args.trim()) return '{}';
  try { return JSON.stringify(sortKeys(JSON.parse(args))); } catch { return JSON.stringify(args); }
}

export function renderToolCall(name: string, args: string): string {
  return `${CALL_OPEN}{"name":${JSON.stringify(name)},"arguments":${compactArguments(args)}}${CALL_CLOSE}`;
}

export function renderToolResult(name: string | undefined, content: string, isError?: boolean): string {
  const attrs = `${name ? ` name=${JSON.stringify(name)}` : ''}${isError ? ' is_error="true"' : ''}`;
  return `<tool_result${attrs}>\n${content}\n</tool_result>`;
}
