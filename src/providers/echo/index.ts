import { setTimeout as sleep } from 'node:timers/promises';
import type { StreamEvent } from '../../core/types.ts';
import { partsToText } from '../../core/types.ts';
import { newId } from '../../core/ids.ts';
import type { Provider, ProviderRequest } from '../base.ts';

/**
 * Test provider: streams the last user message back word by word.
 * Send a message containing "/tool" with tools attached to get a fake tool call,
 * which lets you verify tool-call formatting end to end without a real model.
 */
export class EchoProvider implements Provider {
  readonly id = 'echo';
  readonly name = 'Echo (test provider)';
  readonly nativeTools = true;

  listModels() { return [{ id: 'echo', name: 'Echo' }]; }

  async status() { return { loggedIn: true, mode: 'A' as const, detail: 'always available' }; }

  async *chat(req: ProviderRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
    const lastUser = req.messages.findLast((m) => m.role === 'user');
    const text = lastUser ? partsToText(lastUser.content) : '';
    const tool = req.tools?.[0];

    if (tool && text.includes('/tool') && req.toolChoice !== 'none') {
      yield { type: 'tool_call', id: newId.toolCall(), name: tool.name, arguments: '{}' };
      yield { type: 'done', stopReason: 'tool_calls' };
      return;
    }

    const reply = `Echo: ${text || '(empty)'}`;
    for (const piece of reply.split(/(?<=\s)/)) {
      await sleep(15, undefined, { signal });
      yield { type: 'text', text: piece };
    }
    yield { type: 'done', stopReason: 'stop' };
  }
}
