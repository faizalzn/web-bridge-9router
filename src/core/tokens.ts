import type { ChatRequest } from './types.ts';
import { partsToText } from './types.ts';

// Web chats don't report token usage, so we estimate (~4 chars per token).
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export function estimateRequestTokens(req: ChatRequest): number {
  let text = req.system ?? '';
  for (const m of req.messages) {
    text += partsToText(m.content);
    for (const p of m.content) if (p.type === 'tool_call') text += p.name + p.arguments;
  }
  if (req.tools) text += JSON.stringify(req.tools);
  return estimateTokens(text);
}
