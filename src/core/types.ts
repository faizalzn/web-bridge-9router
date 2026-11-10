// Provider-agnostic request/response model. Every API format (OpenAI, Anthropic)
// is translated into these types, and every provider adapter only speaks these.

export type Role = 'user' | 'assistant' | 'tool';

export interface TextPart { type: 'text'; text: string }
export interface ImagePart { type: 'image'; mediaType?: string; data?: string; url?: string }
export interface ToolCallPart { type: 'tool_call'; id: string; name: string; arguments: string }
export interface ToolResultPart { type: 'tool_result'; toolCallId: string; content: string; isError?: boolean }
export type ContentPart = TextPart | ImagePart | ToolCallPart | ToolResultPart;

export interface Message { role: Role; content: ContentPart[] }

export interface ToolDef { name: string; description?: string; parameters: Record<string, unknown> }
export type ToolChoice = 'auto' | 'none' | 'required' | { name: string };

export interface ChatRequest {
  /** Full public model id, e.g. "gemini/pro". */
  model: string;
  system?: string;
  messages: Message[];
  tools?: ToolDef[];
  toolChoice?: ToolChoice;
  maxTokens?: number;
  temperature?: number;
  stream: boolean;
}

export type StopReason = 'stop' | 'length' | 'tool_calls';
export interface Usage { inputTokens: number; outputTokens: number }

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; arguments: string }
  | { type: 'done'; stopReason: StopReason; usage?: Usage };

export function partsToText(parts: ContentPart[]): string {
  return parts
    .map((p) => (p.type === 'text' ? p.text : p.type === 'tool_result' ? p.content : ''))
    .filter(Boolean)
    .join('\n');
}
