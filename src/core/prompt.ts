import type { ContentPart, Message } from './types.ts';
import { renderToolCall, renderToolResult } from './tool-format.ts';

// Web chats take plain text only, so a request is turned into one prompt.

function partText(p: ContentPart): string {
  switch (p.type) {
    case 'text': return p.text;
    case 'tool_call': return renderToolCall(p.name, p.arguments);
    case 'tool_result': return renderToolResult(undefined, p.content, p.isError);
    case 'image': return '[image omitted]';
  }
}

const speaker = (m: Message): string => (m.role === 'assistant' ? 'Assistant' : m.role === 'tool' ? 'Tool' : 'User');

const introOf = (m: Message): string => (m.role === 'tool'
  ? 'Latest tool results (continue the task: call the next tool or give your final answer)'
  : 'Reply to this latest message from the user');

/** Plain text of a message (what the web chat will see). */
export const messageText = (m: Message): string => m.content.map(partText).filter(Boolean).join('\n').trim();

/**
 * Prompt for a brand-new chat: instructions first, then earlier turns, then the message to answer.
 * A single plain question is sent as it is, without any scaffolding.
 */
export function buildFreshPrompt(system: string | undefined, messages: Message[]): string {
  const turns = messages.filter((m) => messageText(m) !== '');
  const last = turns.at(-1);
  const history = turns.slice(0, -1);
  const parts: string[] = [];

  if (system?.trim()) parts.push(`Follow these instructions for the whole conversation:\n${system.trim()}`);
  if (history.length) {
    const transcript = history.map((m) => `${speaker(m)}: ${messageText(m)}`).join('\n\n');
    parts.push(`Conversation so far:\n${transcript}`);
  }
  if (last) {
    parts.push(parts.length ? `${introOf(last)}:\n${messageText(last)}` : messageText(last));
  }
  return parts.join('\n\n');
}

/** Prompt for a chat that already contains the earlier turns: only what is new. */
export function buildContinuationPrompt(newMessages: Message[]): string {
  return newMessages.map(messageText).filter(Boolean).join('\n\n');
}
