import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Config } from './config.js';
import { ApiError } from './errors.js';
import { chatRequest, sessionRequest, sessionMessage, simpleRequest, validateTranscript, type ChatRequest } from './schema.js';
import { completion, outputSchema, prepareTools, promptFor } from './protocol.js';
import { assertNoAgentTools, type Provider } from './provider.js';
import { Sessions, type Session } from './sessions.js';
import { Metrics } from './metrics.js';
import { dashboardAsset, dashboardRead, registerDashboard } from './dashboard.js';

export async function buildServer(config: Config, provider: Provider) {
  const app = Fastify({ logger: { redact: ['req.headers.authorization'] }, bodyLimit: 1_048_576 });
  const sessions = new Sessions(config.dataDir, config.sessionTtl, config.maxSessions);
  await sessions.init();
  const metrics = new Metrics(config.statsDbPath);
  const running = new Set<AbortController>();
  const tracked = new WeakMap<FastifyRequest, { id: string; start: number }>();
  const finishCall = (req: FastifyRequest, status: number, cancelled = false) => {
    const call = tracked.get(req);
    if (call) metrics.finish(call.id, performance.now() - call.start, status, cancelled);
  };
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0]!;
    const match = /^\/v1\/sessions\/([^/]{1,128})\/messages$/.exec(path);
    if (req.method === 'POST' && (path === '/chat' || path === '/v1/chat/completions' || match)) {
      const session = match ? sessions.records.get(match[1]!) : undefined;
      const id = metrics.begin(match ? '/v1/sessions/:id/messages' : path, session?.model ?? config.model, session?.effort ?? config.reasoningEffort, match?.[1] ?? null);
      tracked.set(req, { id, start: performance.now() });
      req.raw.once('aborted', () => finishCall(req, 499, true));
      reply.raw.once('close', () => { if (!reply.raw.writableEnded) finishCall(req, 499, true); });
    }
    // Prevent browser requests and DNS rebinding to an unauthenticated loopback gateway.
    const host = req.headers.host ?? '';
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) throw new ApiError(403, 'invalid_host', 'Only localhost Host headers are accepted.');
    if (req.headers.origin && !(req.method === 'GET' && dashboardRead(path) && req.headers.origin === `http://${host}`)) {
      throw new ApiError(403, 'browser_origin_denied', 'Only same-origin dashboard reads are allowed.');
    }
    // The dashboard shell is public; its data endpoints still require the gateway key.
    if (config.apiKey && !(req.method === 'GET' && dashboardAsset(path))) {
      const actual = Buffer.from(req.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${config.apiKey}`);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new ApiError(401, 'invalid_api_key', 'Invalid gateway Bearer token.');
    }
  });
  app.addHook('preValidation', async (req) => {
    const call = tracked.get(req);
    if (!call || !req.body || typeof req.body !== 'object') return;
    const body = req.body as Record<string, unknown>;
    const session = typeof (req.params as Record<string, unknown>)?.id === 'string' ? sessions.records.get((req.params as { id: string }).id) : undefined;
    const model = typeof body.model === 'string' ? body.model.slice(0, 128) : session?.model ?? config.model;
    const effort = typeof body.reasoning_effort === 'string' ? body.reasoning_effort.slice(0, 32) : typeof body.reasoning === 'string' ? body.reasoning.slice(0, 32) : session?.effort ?? config.reasoningEffort;
    metrics.context(call.id, model, effort);
  });
  app.addHook('onResponse', async (req, reply) => { finishCall(req, reply.statusCode); });
  app.setErrorHandler((error, req, reply) => {
    const call = tracked.get(req);
    if (call) metrics.error(call.id, error instanceof ApiError ? error.code : error instanceof z.ZodError ? 'invalid_request' : 'internal_error');
    if (error instanceof z.ZodError) return reply.code(400).send({ error: { message: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '), type: 'invalid_request_error', code: 'invalid_request' } });
    const known = error instanceof ApiError;
    const status = known ? error.status : ((error as { statusCode?: number }).statusCode ?? 500);
    if (status >= 500) req.log.error({ code: known ? error.code : 'internal_error' }, 'Gateway request failed');
    return reply.code(status).send({ error: { message: known ? error.message : status < 500 && error instanceof Error ? error.message : 'Internal server error.', type: status < 500 ? 'invalid_request_error' : 'server_error', code: known ? error.code : 'internal_error' } });
  });
  const execute = async (request: ChatRequest, req: FastifyRequest, reply: FastifyReply, session?: Session) => {
    prepareTools(request);
    if (request.reasoning && request.reasoning_effort && request.reasoning !== request.reasoning_effort) throw new ApiError(400, 'invalid_reasoning', 'reasoning and reasoning_effort conflict.');
    const history = session ? [...session.messages, ...request.messages] : request.messages;
    validateTranscript(history);
    if (history.length > 512 || Buffer.byteLength(JSON.stringify(history)) > 1_048_576) throw new ApiError(413, 'session_context_limit', 'Conversation limit reached. Start a new session.');
    if (session && sessions.busy.has(session.id)) throw new ApiError(409, 'session_busy', 'A turn is already running for this session.');
    if (running.size >= config.concurrency) throw new ApiError(429, 'server_busy', 'Codex concurrency limit reached. Retry later.');
    const model = request.model ?? session?.model ?? config.model;
    const effort = request.reasoning_effort ?? request.reasoning ?? session?.effort ?? config.reasoningEffort;
    const sessionEffort = session?.effort ?? config.reasoningEffort;
    if (session && ((request.model && model !== session.model) || (request.reasoning_effort && request.reasoning_effort !== sessionEffort) || (request.reasoning && request.reasoning !== sessionEffort))) {
      throw new ApiError(400, 'session_options_locked', 'Model and reasoning are fixed when the session is created.');
    }
    const controller = new AbortController();
    running.add(controller); if (session) sessions.busy.add(session.id);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, config.timeout);
    const disconnect = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.on('close', disconnect);
    try {
      const call = tracked.get(req);
      if (call) { metrics.context(call.id, model, effort); metrics.running(call.id); }
      const thread = session?.threadId ? provider.resume(session.threadId, model, effort) : provider.start(model, effort);
      const turn = await thread.run(promptFor(session?.threadId ? request.messages : history, request), { outputSchema, signal: controller.signal });
      if (call) metrics.usage(call.id, turn.usage);
      assertNoAgentTools(turn.items);
      const result = completion(turn.finalResponse, model, request, turn.usage);
      if (call) metrics.result(call.id, result.choices[0]!.message.tool_calls?.length ?? 0, result.choices[0]!.finish_reason);
      if (session) {
        if (!thread.id) throw new ApiError(502, 'missing_thread_id', 'Codex did not return a thread ID.');
        session.threadId = thread.id; session.effort = effort;
        session.messages = [...history, result.choices[0]!.message]; session.updatedAt = Date.now();
        await sessions.save();
      }
      return result;
    } catch (error) {
      // Failed/aborted turns can already be written into Codex history. Do not silently resume them.
      if (session) await sessions.remove(session.id);
      if (timedOut) throw new ApiError(504, 'codex_timeout', `Codex timed out.${session ? ' Session invalidated; create a new one.' : ''}`);
      if (error instanceof ApiError) throw error;
      throw new ApiError(502, 'codex_error', `Codex failed. Check login, model availability and CLI compatibility.${session ? ' Session invalidated; create a new one.' : ''}`);
    } finally {
      clearTimeout(timer); reply.raw.off('close', disconnect);
      running.delete(controller); if (session) sessions.busy.delete(session.id);
    }
  };
  app.get('/health', async () => ({ ok: true, provider: 'codex', active_requests: running.size }));
  app.get('/v1/models', async () => ({ object: 'list', data: [{ id: config.model, object: 'model', created: 0, owned_by: 'local-codex' }] }));
  app.post('/v1/chat/completions', async (req, reply) => execute(chatRequest.parse(req.body), req, reply));
  app.post('/chat', async (req, reply) => {
    const input = simpleRequest.parse(req.body);
    const { prompt, ...options } = input;
    const result = await execute(chatRequest.parse({ ...options, messages: [{ role: 'user', content: prompt }] }), req, reply);
    return { ok: true, output: result.choices[0]!.message.content };
  });
  app.post('/v1/sessions', async (req, reply) => {
    const input = sessionRequest.parse(req.body ?? {});
    if (input.reasoning && input.reasoning_effort && input.reasoning !== input.reasoning_effort) throw new ApiError(400, 'invalid_reasoning', 'reasoning and reasoning_effort conflict.');
    validateTranscript(input.messages);
    const session = await sessions.create({ model: input.model ?? config.model, effort: input.reasoning_effort ?? input.reasoning ?? config.reasoningEffort, messages: input.messages });
    return reply.code(201).send({ session_id: session.id });
  });
  app.post<{ Params: { id: string } }>('/v1/sessions/:id/messages', async (req, reply) => {
    const session = sessions.get(req.params.id);
    const input = sessionMessage.parse(req.body);
    const { message, ...rest } = input;
    const request = chatRequest.parse({ ...rest, messages: input.messages ?? [{ role: 'user', content: message }] });
    const result = await execute(request, req, reply, session);
    return { ...result, session_id: session.id };
  });
  app.delete<{ Params: { id: string } }>('/v1/sessions/:id', async (req, reply) => {
    sessions.get(req.params.id);
    if (sessions.busy.has(req.params.id)) throw new ApiError(409, 'session_busy', 'Cannot delete a running session.');
    await sessions.remove(req.params.id); return reply.code(204).send();
  });
  app.addHook('preClose', async () => { for (const controller of running) controller.abort(); });
  app.addHook('onClose', async () => { try { await provider.close(); } finally { metrics.close(); } });
  try { await registerDashboard(app, metrics, config, () => running.size); }
  catch (error) { metrics.close(); throw error; }
  return app;
}
