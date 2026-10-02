import { z } from 'zod';
import { ApiError } from './errors.js';

export const reasoning = z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent']);
const name = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
export const toolCall = z.object({
  id: z.string().min(1), type: z.literal('function'),
  function: z.object({ name, arguments: z.string() }).strict(),
}).strict();
export const message = z.object({
  role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
  content: z.string().nullable().optional(),
  name: name.optional(), tool_call_id: z.string().optional(),
  tool_calls: z.array(toolCall).min(1).optional(),
}).strict().superRefine((m, ctx) => {
  if (m.role === 'tool' && (!m.tool_call_id || typeof m.content !== 'string')) ctx.addIssue({ code: 'custom', message: 'Tool messages require tool_call_id and string content.' });
  if (m.tool_calls && m.role !== 'assistant') ctx.addIssue({ code: 'custom', message: 'Only assistant messages may contain tool_calls.' });
  if (typeof m.content !== 'string' && !(m.role === 'assistant' && m.tool_calls)) ctx.addIssue({ code: 'custom', message: 'Text content is required.' });
});
export const tool = z.object({
  type: z.literal('function'), function: z.object({
    name, description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).default({ type: 'object', properties: {} }),
    strict: z.boolean().optional(),
  }).strict(),
}).strict();
export const toolChoice = z.union([
  z.enum(['auto', 'none', 'required']),
  z.object({ type: z.literal('function'), function: z.object({ name }).strict() }).strict(),
]);
const options = {
  model: z.string().min(1).max(128).optional(),
  reasoning_effort: reasoning.optional(), reasoning: reasoning.optional(),
  tools: z.array(tool).max(64).optional(), tool_choice: toolChoice.optional(),
  parallel_tool_calls: z.boolean().default(true),
  temperature: z.literal(0).optional(),
  stream: z.literal(false).optional(), n: z.literal(1).optional(),
};
export const chatRequest = z.object({ ...options, messages: z.array(message).min(1).max(512) }).strict();
export const sessionRequest = z.object({
  model: options.model, reasoning_effort: options.reasoning_effort, reasoning: options.reasoning,
  messages: z.array(message).max(512).default([]),
}).strict();
export const sessionMessage = z.object({
  ...options, message: z.string().min(1).optional(), messages: z.array(message).min(1).max(512).optional(),
}).strict().refine(v => Boolean(v.message) !== Boolean(v.messages), 'Provide message OR messages.');
export const simpleRequest = z.object({ prompt: z.string().min(1), model: options.model, reasoning: options.reasoning, reasoning_effort: options.reasoning_effort }).strict();
export type Message = z.infer<typeof message>;
export type Tool = z.infer<typeof tool>;
export type ChatRequest = z.infer<typeof chatRequest>;

// Reject incomplete or invented tool results before forwarding a transcript to Codex.
export function validateTranscript(messages: Message[]) {
  const pending = new Set<string>();
  const seen = new Set<string>();
  for (const m of messages) {
    if (m.role === 'tool') {
      if (!pending.delete(m.tool_call_id!)) throw new ApiError(400, 'invalid_tool_result', 'Unknown or duplicate tool_call_id.');
    } else {
      if (pending.size) throw new ApiError(400, 'missing_tool_result', 'Supply all pending tool results before another message.');
      for (const call of m.tool_calls ?? []) {
        if (seen.has(call.id)) throw new ApiError(400, 'duplicate_tool_call', 'Tool call IDs must be unique.');
        seen.add(call.id); pending.add(call.id);
        try { JSON.parse(call.function.arguments); } catch { throw new ApiError(400, 'invalid_tool_arguments', 'Assistant tool arguments must contain JSON.'); }
      }
    }
  }
  if (pending.size) throw new ApiError(400, 'missing_tool_result', 'Supply all pending tool results.');
}
