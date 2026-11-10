// One canonical text form for tool calls and tool results. It is used in three places that must agree:
// the instructions that tell the model how to call a tool, the history that is sent back to it, and the
// parser that reads its replies. Because the form is canonical, the history a client resends looks exactly
// like the reply the web chat already holds, so the conversation cache can still recognise it.

export const CALL_OPEN = '<tool_call>';
export const CALL_CLOSE = '</tool_call>';

/** Arguments as compact JSON, so that equal calls always render equally. */
function compactArguments(args: string): string {
  if (!args.trim()) return '{}';
  try { return JSON.stringify(JSON.parse(args)); } catch { return JSON.stringify(args); }
}

export function renderToolCall(name: string, args: string): string {
  return `${CALL_OPEN}{"name":${JSON.stringify(name)},"arguments":${compactArguments(args)}}${CALL_CLOSE}`;
}

export function renderToolResult(name: string | undefined, content: string, isError?: boolean): string {
  const attrs = `${name ? ` name=${JSON.stringify(name)}` : ''}${isError ? ' is_error="true"' : ''}`;
  return `<tool_result${attrs}>\n${content}\n</tool_result>`;
}
