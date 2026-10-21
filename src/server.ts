import { NativeUsage } from './native-usage.js';
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
import { Inspector, redact } from './inspector.js';
import { Activities, digest, type ActivityRun } from './activity.js';
import { Sse } from './sse.js';
import {ProviderRegistry} from './provider-registry.js';
import {PerformanceLab} from './performance-lab.js';
import {Resources} from './resources.js';
import type {BenchmarkTag} from './activity.js';
import { Scheduler } from './scheduler.js';
import { publicContent, withoutSecretPrefix } from './stream-content.js';

export async function buildServer(config: Config, provider: Provider) {
  const app = Fastify({ logger: { redact: ['req.headers.authorization'] }, bodyLimit: 1_048_576 });
  const sessions = new Sessions(config.dataDir, config.sessionTtl, config.maxSessions);
  await sessions.init();
  const metrics = new Metrics(config.statsDbPath);
  const inspector = new Inspector(config, () => app.log.warn({ code: 'inspector_storage_error' }, 'Request inspector storage unavailable'));
  await inspector.init();
  const native = new NativeUsage(config.statsDbPath, config.nativeCodexHome, config.nativeUsageInterval);
  native.start();
  const running = new Set<AbortController>();
  const activities = new Activities(config);
  const registry=new ProviderRegistry(config,provider),resources=new Resources();
  for(const id of ['ollama','lmstudio'] as const){const settings=config.localProviders[id];if(settings?.pid&&['127.0.0.1','localhost','[::1]'].includes(new URL(settings.url).hostname))resources.track(settings.pid,id,true,'configured_local_provider_process_shared');}
  const scheduler = new Scheduler(config.concurrency,config.maxQueue,config.queueTimeout);
  const identities = new WeakMap<FastifyRequest, {owner:string;admin:boolean}>();
  const received = new WeakMap<FastifyRequest, number>();
  const streams = new Set<Sse>();
  const jobs = new Set<Promise<unknown>>();
  const checkStreams = () => { if (streams.size >= 128) throw new ApiError(429,'subscriber_limit','Too many streaming connections.'); };
  const openStream = (reply:FastifyReply) => { checkStreams(); const stream = new Sse(reply); streams.add(stream); stream.onClose(() => streams.delete(stream)); return stream; };
  const tracked = new WeakMap<FastifyRequest, { id: string; start: number; createdAt: number; ephemeral: boolean; run?:ActivityRun; detached?:boolean }>();
  const capture = async (req: FastifyRequest, key: string, provenance: Parameters<Inspector['capture']>[3], data: unknown) => {
    const call = tracked.get(req);
    if (call) await inspector.capture(call.id, call.createdAt, key, provenance, data, call.ephemeral);
  };
  const finishCall = (req: FastifyRequest, status: number, cancelled = false) => {
    const call = tracked.get(req);
    if (call && !call.run) metrics.finish(call.id, performance.now() - call.start, status, cancelled);
  };
  app.addHook('onRequest', async (req, reply) => {
    received.set(req, performance.now());
    const path = req.url.split('?')[0]!;
    const match = /^\/v1\/sessions\/([^/]{1,128})\/messages$/.exec(path);
    if (req.method === 'POST' && (path === '/api/playground/chat' || path === '/chat' || path === '/v1/chat/completions' || match)) {
      const session = match ? sessions.records.get(match[1]!) : undefined;
      const id = metrics.begin(match ? '/v1/sessions/:id/messages' : path, session?.model ?? config.model, session?.effort ?? config.reasoningEffort, match?.[1] ?? null);
      tracked.set(req, { id, start: performance.now(), createdAt: Date.now(), ephemeral: path === '/api/playground/chat' });
      reply.header('X-Codex-Call-Id', id);
      req.raw.once('aborted', () => finishCall(req, 499, true));
      reply.raw.once('close', () => { if (!reply.raw.writableEnded) finishCall(req, 499, true); });
    }
    // Prevent browser requests and DNS rebinding to an unauthenticated loopback gateway.
    const host = req.headers.host ?? '';
    const hostname = /^(\[[a-fA-F0-9:]+\]|[a-zA-Z0-9.-]+)(?::[0-9]{1,5})?$/.exec(host)?.[1]?.toLowerCase();
    if (!hostname || !['localhost','127.0.0.1','[::1]','codex-server.localhost',...config.trustedHosts].includes(hostname)) throw new ApiError(403, 'invalid_host', 'Host is not allowed.');
    const runWrite = req.method === 'POST' && /^\/v1\/runs(?:\/[a-f0-9-]{36}\/(?:cancel|workflow-events))?$/.test(path);
    if (runWrite && req.headers.origin && (req.headers['x-codex-run'] !== '1' || !req.headers['content-type']?.startsWith('application/json'))) throw new ApiError(403, 'run_origin_denied', 'Browser run writes require JSON and X-Codex-Run: 1.');
    const labWrite=req.method==='POST'&&/^\/api\/lab\/batches(?:\/[a-f0-9-]{36}\/cancel)?$/.test(path);
    if(labWrite&&(req.headers['x-codex-lab']!=='1'||!req.headers['content-type']?.startsWith('application/json')))throw new ApiError(403,'lab_origin_denied','Benchmark writes require JSON and X-Codex-Lab: 1.');
    const playground = req.method === 'POST' && path === '/api/playground/chat';
    const videoWrite=['POST','PUT'].includes(req.method)&&/^\/api\/videos(?:\/[^/]{1,128})?$/.test(path);
    const inspectorWrite = req.method === 'DELETE' && (/^\/api\/stats\/calls\/[a-f0-9-]{36}\/inspector$/.test(path) || path === '/api/stats/inspector');
    const notificationWrite=['POST','PUT'].includes(req.method)&&/^\/api\/native\/notifications\/(settings|test)$/.test(path);
    if(notificationWrite&&(req.headers['x-codex-notifications']!=='1'||!req.headers['content-type']?.startsWith('application/json')||req.headers.origin&&req.headers.origin!==`http://${host}`))
      throw new ApiError(403,'notification_origin_denied','Notification settings require same-origin JSON and X-Codex-Notifications: 1.');
    if (inspectorWrite && (req.headers['x-codex-inspector'] !== '1' || !req.headers['content-type']?.startsWith('application/json') || req.headers.origin && req.headers.origin !== `http://${host}`))
      throw new ApiError(403, 'inspector_origin_denied', 'Inspector deletion requires same-origin JSON and X-Codex-Inspector: 1.');
    if(videoWrite&&(!req.headers['content-type']?.startsWith('application/json')||req.headers['x-codex-video']!=='1'||req.headers.origin&&req.headers.origin!==`http://${host}`))
      throw new ApiError(403,'video_origin_denied','Video metadata cần JSON, cùng origin và X-Codex-Video: 1.');
    if (playground && (req.headers.origin !== `http://${host}` || req.headers['x-codex-playground'] !== '1' || !req.headers['content-type']?.startsWith('application/json'))) throw new ApiError(403, 'browser_origin_denied', 'Playground requires same-origin JSON requests.');
    if (req.headers.origin && !((req.method === 'GET' && dashboardRead(path) || playground || videoWrite || inspectorWrite || runWrite || labWrite || notificationWrite) && req.headers.origin === `http://${host}`)) {
      throw new ApiError(403, 'browser_origin_denied', 'Only same-origin dashboard reads are allowed.');
    }
    // App credentials authorize only owned runs and stateless inference; dashboard and sessions remain admin-only.
    let identity = {owner:'admin',admin:true};
    if (config.apiKey && !(req.method === 'GET' && dashboardAsset(path))) {
      const header = req.headers.authorization ?? '';
      const hash = digest(header.startsWith('Bearer ') ? header.slice(7) : '');
      const equal = (expected:string) => timingSafeEqual(Buffer.from(hash), Buffer.from(expected));
      if (!equal(digest(config.apiKey))) {
        const client = config.clientKeys.find(c => equal(c.hash));
        if (!client) throw new ApiError(401, 'invalid_api_key', 'Invalid gateway Bearer token.');
        identity = {owner:`app:${client.id}`,admin:false};
        if (!['/health','/v1/models','/v1/providers','/chat','/v1/chat/completions','/v1/runs'].includes(path) && !/^\/v1\/runs\/[a-f0-9-]{36}(?:\/(?:events|cancel|workflow-events))?$/.test(path))
          throw new ApiError(403, 'admin_required', 'This endpoint requires the gateway admin key.');
      }
    }
    identities.set(req, identity);
  });
  app.addHook('preValidation', async (req) => {
    const call = tracked.get(req);
    if (!call || !req.body || typeof req.body !== 'object') return;
    const body = req.body as Record<string, unknown>;
    const session = typeof (req.params as Record<string, unknown>)?.id === 'string' ? sessions.records.get((req.params as { id: string }).id) : undefined;
    const model = typeof body.model === 'string' ? body.model.slice(0, 128) : session?.model ?? config.model;
    const effort = typeof body.reasoning_effort === 'string' ? body.reasoning_effort.slice(0, 32) : typeof body.reasoning === 'string' ? body.reasoning.slice(0, 32) : session?.effort ?? config.reasoningEffort;
    metrics.context(call.id, model, effort,body.provider==='ollama'||body.provider==='lmstudio'?body.provider:'codex');
  });
  app.addHook('onResponse', async (req, reply) => { finishCall(req, reply.statusCode); });
  app.addHook('onSend', async (req, reply, payload) => {
    if (tracked.has(req) && !tracked.get(req)?.detached && config.inspectorEnabled) {
      let body: unknown = payload;
      if (typeof payload === 'string') { try { body = JSON.parse(payload); } catch { /* serialized response text */ } }
      await capture(req,'http_response', 'Gateway generated', { status: reply.statusCode, body });
    }
    return payload;
  });
  app.setErrorHandler((error, req, reply) => {
    const call = tracked.get(req);
    if (call) metrics.error(call.id, error instanceof ApiError ? error.code : error instanceof z.ZodError ? 'invalid_request' : 'internal_error');
    if (error instanceof z.ZodError) return reply.code(400).send({ error: { message: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '), type: 'invalid_request_error', code: 'invalid_request' } });
    const known = error instanceof ApiError;
    const status = known ? error.status : ((error as { statusCode?: number }).statusCode ?? 500);
    if (status >= 500) req.log.error({ code: known ? error.code : 'internal_error' }, 'Gateway request failed');
    return reply.code(status).send({ error: { message: known ? error.message : status < 500 && error instanceof Error ? error.message : 'Internal server error.', type: status < 500 ? 'invalid_request_error' : 'server_error', code: known ? error.code : 'internal_error' } });
  });
  const execute = (request: ChatRequest, req: FastifyRequest|undefined, reply: FastifyReply|undefined, session?: Session, detached = false, idempotency?:string,benchmark?:BenchmarkTag) => {
    const selected=registry.resolve(request);
    if(session&&selected.id!=='codex')throw new ApiError(400,'local_sessions_unsupported','Legacy sessions use Codex only.');
    const captureStep=(key:string,provenance:Parameters<Inspector['capture']>[3],data:unknown)=>req?capture(req,key,provenance,data):Promise.resolve();
    if (!detached && (!req||!reply||req.raw.aborted || reply.raw.destroyed)) throw new ApiError(499,'request_cancelled','Client disconnected before admission.');
    if (request.stream_options && !request.stream) throw new ApiError(400,'invalid_stream_options','stream_options requires stream: true.');
    if (session && request.stream) throw new ApiError(400,'session_stream_unsupported','Streaming session routes are not supported yet.');
    prepareTools(request);
    if (request.reasoning && request.reasoning_effort && request.reasoning !== request.reasoning_effort) throw new ApiError(400, 'invalid_reasoning', 'reasoning and reasoning_effort conflict.');
    const history = session ? [...session.messages, ...request.messages] : request.messages;
    validateTranscript(history);
    if (history.length > 512 || Buffer.byteLength(JSON.stringify(history)) > 1_048_576) throw new ApiError(413, 'session_context_limit', 'Conversation limit reached. Start a new session.');
    if (session && sessions.busy.has(session.id)) throw new ApiError(409, 'session_busy', 'A turn is already running for this session.');
    scheduler.assertAvailable();
    const queued=scheduler.needsQueue;
    const model = request.model ?? session?.model ?? config.model;
    const effort = request.reasoning_effort ?? request.reasoning ?? session?.effort ?? config.reasoningEffort;
    const sessionEffort = session?.effort ?? config.reasoningEffort;
    if (session && ((request.model && model !== session.model) || (request.reasoning_effort && request.reasoning_effort !== sessionEffort) || (request.reasoning && request.reasoning !== sessionEffort))) {
      throw new ApiError(400, 'session_options_locked', 'Model and reasoning are fixed when the session is created.');
    }
    const identity = req?identities.get(req)!:{owner:'admin',admin:true};
    let call = req?tracked.get(req):undefined;
    if (!call) {
      const id = metrics.begin(benchmark?'/api/lab/batches':'/v1/runs', model, effort, null);
      call = {id,start:(req?received.get(req):undefined) ?? performance.now(),createdAt:Date.now(),ephemeral:Boolean(benchmark)};
      if(req)tracked.set(req,call); reply?.header('X-Codex-Call-Id',id);
    }
    metrics.context(call.id,model,effort,selected.id);
    const run = activities.create(call.id, identity.owner, model, call.ephemeral, call.start, idempotency, idempotency ? digest(JSON.stringify(request)) : undefined,queued,selected.id,benchmark);
    call.run = run; call.detached = detached;
    reply?.header('X-Codex-Run-Id',run.id);
    const controller = run.controller;
    running.add(controller); if (session) sessions.busy.add(session.id);
    const ticket=scheduler.acquire(controller.signal);
    let release:(()=>void)|undefined,providerInvoked=false;
    let timedOut = false;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const disconnect = () => { if (reply&&!reply.raw.writableEnded) run.cancel('disconnect'); };
    if (!detached&&reply) reply.raw.on('close', disconnect);
    if (!detached&&reply) reply.raw.once('finish', () => { run.responseFinished = run.elapsed(); activities.save(run); });
    const resultPromise = (async () => {
      try {
        release=await ticket;run.dequeue();
        if(controller.signal.aborted)throw new ApiError(499,'request_cancelled','Request cancelled before provider start.');
        timer=setTimeout(()=>{timedOut=true;run.cancel('timeout');},config.timeout);
        await captureStep('incoming', 'Client supplied', {payload:req?.body,
          messages:(req?.body as {messages?:unknown}|undefined)?.messages ?? request.messages,
          message_mapping:req?.url.split('?')[0] === '/chat' ? 'Gateway generated user role from client prompt' : (req?.body as {message?:unknown}|undefined)?.message ? 'Gateway generated user role from client message' : 'Original client messages'});

        if (call) { metrics.context(call.id, model, effort,selected.id); metrics.running(call.id); }
        const thread = session?.threadId ? selected.adapter.resume(session.threadId, model, effort) : selected.adapter.start(model, effort, req?.url.split('?')[0] === '/api/playground/chat');
        const forwardedMessages = session?.threadId ? request.messages : history;
        const prompt = promptFor(forwardedMessages, request);
        await captureStep('gateway', 'Gateway generated', { prompt, output_schema: outputSchema, effective_parameters: { model, reasoning_effort: effort },
          validated_request: request, session_id: session?.id ?? null, thread_id_before: thread.id,
          forwarded_messages: forwardedMessages.map((message, index) => {
            const restored = !session?.threadId && index < (session?.messages.length ?? 0);
            return { message, provenance: restored ? 'Gateway generated' : 'Client supplied', restored_by_gateway: restored,
              ...(restored && { original_source: { provenance: 'Internal / unavailable', reason: 'Legacy saved session messages do not independently track client versus Codex authorship.' } }) };
          }),
          context: session?.threadId ? { provenance: 'Internal / unavailable', reason: 'Resumed CLI history is managed by Codex; only new messages are forwarded. Gateway session history is not a reconstruction of the internal prompt.' } : { provenance: 'Gateway generated', reason: session ? 'Gateway prepends its saved session messages for the initial CLI turn.' : 'New stateless CLI thread.' } });
        if(controller.signal.aborted)throw new ApiError(499,'request_cancelled','Request cancelled before provider start.');
        run.providerStarted = run.elapsed(); run.emit('provider.started');
        let responseObserved = false;
        providerInvoked=true;
        const turn = await thread.run(prompt, { outputSchema,request:{...request,stream:selected.id==='codex'?request.stream:request.stream??true},signal: controller.signal,onProcess:(pid,active,scope)=>resources.track(pid,selected.id,active,scope),
          onEvent: event => {
            if (controller.signal.aborted) throw new ApiError(499,'request_cancelled','Request cancelled.');
            if (event.type === 'output') {
              const text = publicContent(event.text);
              if (text !== null) run.content(String(redact(withoutSecretPrefix(text,config.inspectorSecrets),config.inspectorSecrets)));
            } else if(event.type==='usage'){ run.reportUsage(event.usage); metrics.usage(run.id,event.usage); }else run.reportTiming(event.timing);
          },
          onLifecycle: timing => { run.cliLifecycle=timing; },
          observe: async context => captureStep('cli_boundary', 'Gateway generated', context),
          observeResponse: async response => { responseObserved = true; await captureStep('codex_response', 'SDK observable', response); } });
        run.providerFinished = run.elapsed(); run.emit('provider.finished');
        if (controller.signal.aborted) throw new ApiError(499,'request_cancelled','Request cancelled.');
        if (!responseObserved) await captureStep('codex_response', 'SDK observable', { final_response: turn.finalResponse,
          assistant_messages: turn.items.filter(item => item.type === 'agent_message'), usage: turn.usage, thread_id: thread.id, complete: true,
          excluded_items: turn.items.filter(item => item.type !== 'agent_message').map(item => item.type),
          internal_reasoning: { provenance: 'Internal / unavailable', available: false, reason: 'Private reasoning items are never recorded.' } });
        if (call) metrics.usage(call.id, turn.usage);
        if(turn.timing)run.reportTiming(turn.timing);
        assertNoAgentTools(turn.items);
        const result = completion(turn.finalResponse, model, request, turn.usage);
        result.id = `chatcmpl-local-${run.id}`;
        if(turn.finishReason==='length')result.choices[0]!.finish_reason='length';
        const safeResult = redact(result,config.inspectorSecrets) as typeof result;
        const toolsUnchanged = JSON.stringify(result.choices[0]!.message.tool_calls) === JSON.stringify(safeResult.choices[0]!.message.tool_calls);
        if (!toolsUnchanged && (request.stream || detached)) throw new ApiError(502,'sensitive_tool_output','Tool proposals contain redacted secrets; no validated proposal can be streamed.');
        if (turn.usage) run.reportUsage(turn.usage);
        run.content(typeof safeResult.choices[0]!.message.content === 'string' ? safeResult.choices[0]!.message.content : '');
        if (call) metrics.result(call.id, result.choices[0]!.message.tool_calls?.length ?? 0, result.choices[0]!.finish_reason);
        if (session) {
          if (!thread.id) throw new ApiError(502, 'missing_thread_id', 'Codex did not return a thread ID.');
          session.threadId = thread.id; session.effort = effort;
          session.messages = [...history, result.choices[0]!.message]; session.updatedAt = Date.now();
          await sessions.save();
        }
        if(controller.signal.aborted)throw new ApiError(499,'request_cancelled','Request cancelled before completion.');
        run.finish('completed',null,safeResult,toolsUnchanged); metrics.finish(run.id, run.elapsed(), 200);
        if (request.stream || detached) await captureStep('http_response','Gateway generated',{status:200,body:result});
        return result;
      } catch (error) {
        // Failed/aborted turns can already be written into Codex history. Do not silently resume them.
        if (session && providerInvoked) await sessions.remove(session.id);
        const timeoutCode=selected.id==='codex'?'codex_timeout':'provider_timeout';
        const code = timedOut ? timeoutCode : controller.signal.aborted ? 'request_cancelled' : error instanceof ApiError ? error.code : 'codex_error';
        run.finish(controller.signal.aborted && !timedOut ? 'cancelled' : 'failed',code);
        metrics.error(run.id,code); metrics.finish(run.id,run.elapsed(),timedOut ? 504 : controller.signal.aborted ? 499 : error instanceof ApiError ? error.status : 502,controller.signal.aborted && !timedOut);
        if (controller.signal.aborted && !timedOut) throw new ApiError(499,'request_cancelled','Request cancelled.');
        if (timedOut) throw new ApiError(504, timeoutCode, `Provider timed out.${session ? ' Session invalidated; create a new one.' : ''}`);
        if (error instanceof ApiError) throw error;
        throw new ApiError(502, 'codex_error', `Codex failed. Check login, model availability and CLI compatibility.${session ? ' Session invalidated; create a new one.' : ''}`);
      } finally {
        clearTimeout(timer); reply?.raw.off('close', disconnect);
        running.delete(controller); if (session) sessions.busy.delete(session.id);release?.();
      }
    })();
    jobs.add(resultPromise); void resultPromise.finally(() => jobs.delete(resultPromise)).catch(() => {});
    return {run,result:resultPromise};
  };
  const lab=new PerformanceLab(config,resources,(request,tag)=>execute(request,undefined,undefined,undefined,true,undefined,tag),request=>registry.resolve(request));
  const deliver = async (request:ChatRequest, req:FastifyRequest, reply:FastifyReply) => {
    if (request.stream) checkStreams();
    const execution = execute(request,req,reply);
    if (!request.stream) return execution.result;
    const {run} = execution, stream = openStream(reply);
    const id = `chatcmpl-local-${run.id}`, created = Math.floor(run.createdAt / 1000);
    const chunk = (delta:Record<string,unknown>, finish:string|null = null) => stream.send({id,object:'chat.completion.chunk',created,model:run.model,
      choices:[{index:0,delta,finish_reason:finish}]});
    chunk({role:'assistant',content:''});
    const listener = (event: import('./activity.js').ActivityEvent) => {
      if (event.type === 'output.replaced') throw new ApiError(502,'non_append_output','Provider revised previously streamed content; stream is incomplete.');
      if (event.type === 'output.delta' && event.payload.delta && chunk({content:event.payload.delta})) run.sent();
    };
    run.listeners.add(listener);
    try {
      const result = await execution.result, choice = result.choices[0]!;
      for (const [index,tool] of (choice.message.tool_calls ?? []).entries()) chunk({tool_calls:[{index,...tool}]});
      chunk({},choice.finish_reason);
      if (request.stream_options?.include_usage) stream.send({id,object:'chat.completion.chunk',created,model:run.model,choices:[],usage:result.usage ?? null});
      stream.write('data: [DONE]\n\n');
    } catch (error) {
      stream.send({error:{code:error instanceof ApiError ? error.code : 'stream_error',message:'Request incomplete; partial output is not a validated completion.'}});
    } finally { run.listeners.delete(listener); stream.end(); }
    return reply;
  };
  const identity = (req:FastifyRequest) => identities.get(req)!;
  const runId = (req:FastifyRequest) => z.uuid().parse((req.params as {id:string}).id);
  const streamQuery=(req:FastifyRequest)=>z.object({cursor:z.string().max(128).optional(),follow_workflow:z.literal('1').optional()}).strict().parse(req.query);
  const cursor = (req:FastifyRequest) => {
    const query = streamQuery(req);
    return z.string().max(128).optional().parse(req.headers['last-event-id'] ?? query.cursor);
  };
  app.post('/v1/runs',async(req,reply) => {
    const request = chatRequest.parse(req.body), key = z.string().min(1).max(128).optional().parse(req.headers['idempotency-key']);
    const who = identity(req), duplicate = key ? activities.duplicate(who.owner,key,digest(JSON.stringify(request))) : null;
    if (duplicate) return reply.code(202).send({...duplicate,events_url:`/v1/runs/${duplicate.run_id}/events`,reused:true});
    const execution = execute(request,req,reply,undefined,true,key);
    void execution.result.catch(() => {});
    return reply.code(202).send({...execution.run.snapshot(),events_url:`/v1/runs/${execution.run.id}/events`,reused:false});
  });
  app.get('/v1/runs/:id',async(req,reply) => {
    const who = identity(req); return reply.header('Cache-Control','no-store').send(activities.snapshot(runId(req),who.owner,who.admin));
  });
  app.post('/v1/runs/:id/cancel',async(req,reply) => {
    z.object({}).strict().parse(req.body);
    const id = runId(req), who = identity(req), run = activities.live(id,who.owner,who.admin);
    run?.cancel('explicit');
    return reply.send({...activities.snapshot(id,who.owner,who.admin),cancel_requested:run?.active ?? false});
  });
  app.post('/v1/runs/:id/workflow-events',{bodyLimit:4096},async(req,reply)=>{
    const who=identity(req);return reply.header('Cache-Control','no-store').send(activities.workflow(runId(req),who.owner,who.admin,req.body));
  });
  app.get('/v1/runs/:id/events',async(req,reply) => {
    const id=runId(req),who=identity(req),run=activities.live(id,who.owner,who.admin),after=cursor(req);
    const snapshot=activities.snapshot(id,who.owner,who.admin),follow=streamQuery(req).follow_workflow==='1'&&!snapshot.ephemeral;
    if(!run&&!follow)throw new ApiError(409,'cursor_reset','Output replay expired or server restarted; use the run metadata endpoint.');
    let replay:import('./activity.js').ActivityEvent[]=[];let outputAvailable=Boolean(run);
    if(run) {
      try {replay=activities.replay(run,after);} catch(error) {if(!follow||after)throw error;outputAvailable=false;}
    } else replay=activities.workflowReplay(id,after);
    const stream=openStream(reply);
    stream.send({...snapshot,replay_from:replay[0]?.seq??null,replay:{available:outputAvailable&&!snapshot.ephemeral,reason:outputAvailable?'memory_replay':'output_expired_metadata_only'}},undefined,'snapshot');
    const settled=()=>{
      const current=activities.snapshot(id,who.owner,who.admin);
      return !['queued','running'].includes(current.status)&&(!follow||['completed','failed','cancelled'].includes(current.workflow.status));
    };
    for(const event of replay)stream.send(event,`${id}:${event.seq}`,'activity');
    if(settled())stream.end();
    else {
      const unsubscribe=activities.subscribe(id,event=>{stream.send(event,`${id}:${event.seq}`,'activity');if(settled())stream.end();});
      stream.onClose(unsubscribe);
      const timer=setTimeout(()=>stream.end(),600_000);timer.unref();stream.onClose(()=>clearTimeout(timer));
    }
    return reply;
  });
  app.get('/api/runs/latency',async(req,reply)=>{
    const input=z.object({range:z.enum(['1h','24h','7d','30d']).default('24h'),model:z.string().min(1).max(128).optional(),provider:z.enum(['codex','ollama','lmstudio']).optional(),status:z.enum(['all','queued','running','completed','failed','cancelled','interrupted']).default('completed')}).strict().parse(req.query);
    return reply.header('Cache-Control','no-store').send(activities.latency(input));
  });
  app.get('/api/runs',async(_req,reply) => reply.header('Cache-Control','no-store').send({runs:activities.list()}));
  app.get('/api/runs/events',async(req,reply) => {
    const replay = activities.feedReplay(cursor(req)), stream = openStream(reply);
    stream.send({runs:activities.list()},undefined,'snapshot');
    for (const event of replay) stream.send(event.event,event.cursor,'activity');
    const listener = (id:string,event:import('./activity.js').ActivityEvent) => stream.send(event,id,'activity');
    activities.listeners.add(listener); stream.onClose(() => activities.listeners.delete(listener));
    return reply;
  });
  app.get('/api/lab',async(_req,reply)=>reply.header('Cache-Control','no-store').send({...lab.catalog(),providers:registry.describe()}));
  app.get('/api/lab/batches',async(_req,reply)=>reply.header('Cache-Control','no-store').send({batches:lab.list()}));
  app.post('/api/lab/batches',{bodyLimit:8192},async(req,reply)=>{const key=z.string().min(1).max(128).optional().parse(req.headers['idempotency-key']);const result=lab.start(req.body,key);return reply.code(result.reused?200:202).header('Cache-Control','no-store').send(result);});
  app.get('/api/lab/batches/:id',async(req,reply)=>reply.header('Cache-Control','no-store').send(lab.detail(runId(req))));
  app.post('/api/lab/batches/:id/cancel',async(req,reply)=>reply.header('Cache-Control','no-store').send(lab.stop(runId(req))));
  app.get('/api/lab/batches/:id/export',async(req,reply)=>{const id=runId(req),{format}=z.object({format:z.enum(['json','csv']).default('json')}).strict().parse(req.query);return reply.header('Cache-Control','no-store').header('Content-Disposition',`attachment; filename="benchmark-${id}.${format}"`).type(format==='csv'?'text/csv; charset=utf-8':'application/json; charset=utf-8').send(format==='csv'?lab.csv(id):lab.detail(id));});
  app.get('/api/lab/batches/:id/events',async(req,reply)=>{
    const id=runId(req),snapshot=lab.detail(id),after=cursor(req);
    if(after){const [scope,seq,...extra]=after.split(':');if(scope!==id||extra.length||!Number.isSafeInteger(Number(seq))||Number(seq)<0||Number(seq)>snapshot.seq)throw new ApiError(409,'cursor_reset','Reload batch snapshot.');}
    const stream=openStream(reply);stream.send(snapshot,`${id}:${snapshot.seq}`,'snapshot');
    if(!['running','cancelling'].includes(snapshot.status))stream.end();else{const unsubscribe=lab.subscribe(id,batch=>{stream.send(batch,`${id}:${batch.seq}`,'snapshot');if(!['running','cancelling'].includes(batch.status))stream.end();});stream.onClose(unsubscribe);}
    return reply;
  });
  app.get('/health', async () => ({ ok: true, provider: 'codex', active_requests: scheduler.active,queued_requests:scheduler.queued }));
  app.get('/v1/providers',async()=>({providers:registry.describe()}));
  app.get('/v1/models',async(req)=>{const {provider:id}=z.object({provider:z.enum(['codex','ollama','lmstudio']).default('codex')}).strict().parse(req.query);return {object:'list',data:(await registry.models(id)).map(model=>({...model,object:'model',created:0,owned_by:id==='codex'?'local-codex':id}))};});
  app.get('/api/resources',async(_req,reply)=>reply.header('Cache-Control','no-store').send({...resources.snapshot(),providers:await registry.resources()}));
  app.post('/v1/chat/completions', async (req, reply) => deliver(chatRequest.parse(req.body), req, reply));
  app.post('/api/playground/chat', async (req, reply) => deliver(chatRequest.parse(req.body), req, reply));
  app.post('/chat', async (req, reply) => {
    const input = simpleRequest.parse(req.body);
    const { prompt, ...options } = input;
    const result = await execute(chatRequest.parse({ ...options, messages: [{ role: 'user', content: prompt }] }), req, reply).result;
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
    const result = await execute(request, req, reply, session).result;
    return { ...result, session_id: session.id };
  });
  app.delete<{ Params: { id: string } }>('/v1/sessions/:id', async (req, reply) => {
    sessions.get(req.params.id);
    if (sessions.busy.has(req.params.id)) throw new ApiError(409, 'session_busy', 'Cannot delete a running session.');
    await sessions.remove(req.params.id); return reply.code(204).send();
  });
  app.addHook('preClose', async () => {
    const labClosed=lab.close();
    resources.close();scheduler.close();
    for (const controller of running) controller.abort();
    for (const stream of streams) stream.end();
    await Promise.allSettled([...jobs]);
    await labClosed;
  });
  app.addHook('onClose', async () => { try { await provider.close(); } finally { await inspector.close(); await native.close(); activities.close(); metrics.close(); } });
  try { await registerDashboard(app, metrics, config, () => scheduler.active, native, inspector); }
  catch (error) { resources.close();await lab.close();await inspector.close(); await native.close(); activities.close(); metrics.close(); throw error; }
  return app;
}
