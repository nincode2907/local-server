import type { NativeUsage } from './native-usage.js';
import { catalog } from './catalog.js';
import { ApiError } from './errors.js';
import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Metrics } from './metrics.js';
import { VideoBuilds } from './video-builds.js';
import type { Inspector } from './inspector.js';

export function dashboardAsset(path: string) {
  if (/^\/dashboard\/requests\/[a-f0-9-]{36}$/.test(path)) return true;
  return ['/', '/dashboard', '/dashboard/assets/style.css', '/dashboard/assets/app.js', '/dashboard/assets/live.js', '/dashboard/assets/lab.js', '/dashboard/assets/activity-client.js', '/dashboard/assets/usage-insights.css', '/dashboard/assets/usage-insights.js', '/dashboard/assets/favicon.svg'].includes(path);
}
export function dashboardRead(path: string) {
  if(path==='/api/resources'||path==='/v1/providers'||path==='/v1/models'||/^\/api\/lab(?:\/batches(?:\/[a-f0-9-]{36}(?:\/(?:events|export))?)?)?$/.test(path))return true;
  if (['/api/runs','/api/runs/events','/api/runs/latency'].includes(path) || /^\/v1\/runs\/[a-f0-9-]{36}(?:\/events)?$/.test(path)) return true;
  return /^\/api\/videos(?:\/[^/]{1,128})?$/.test(path) || /^\/api\/native\/(overview|insights|sessions\/[^/]{1,128})$/.test(path) || dashboardAsset(path) || ['/api/models', '/api/stats/costs', '/api/stats/overview', '/api/stats/calls'].includes(path) || /^\/api\/stats\/calls\/[a-f0-9-]{36}(?:\/inspector)?$/.test(path);
}
export async function registerDashboard(app: FastifyInstance, metrics: Metrics, config: Config, active: () => number, native: NativeUsage, inspector: Inspector) {
  const html = await readFile(new URL('../public/dashboard.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../public/dashboard.css', import.meta.url), 'utf8');
  const js = await readFile(new URL('../public/dashboard.js', import.meta.url), 'utf8');
  const insightsCss = await readFile(new URL('../public/usage-insights.css', import.meta.url), 'utf8');
  const insightsJs = await readFile(new URL('../public/usage-insights.js', import.meta.url), 'utf8');
  const liveJs = await readFile(new URL('../public/live.js', import.meta.url), 'utf8');
  const labJs=await readFile(new URL('../public/lab.js',import.meta.url),'utf8');
  const activityClient = await readFile(new URL('../clients/activity-client/index.js', import.meta.url), 'utf8');
  const favicon = await readFile(new URL('../public/favicon.svg', import.meta.url), 'utf8');
  const videos = new VideoBuilds(config.statsDbPath);
  app.addHook('onClose', async()=>videos.close());
  const security = {
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  };
  app.get('/', async (_req, reply) => reply.redirect('/dashboard'));
  app.get('/dashboard/requests/:id', async(req,reply)=>{z.uuid().parse((req.params as {id:string}).id);return reply.headers(security).type('text/html; charset=utf-8').send(html);});
  app.get('/dashboard', async (_req, reply) => reply.headers(security).type('text/html; charset=utf-8').send(html));
  app.get('/dashboard/assets/style.css', async (_req, reply) => reply.headers(security).type('text/css; charset=utf-8').send(css));
  app.get('/dashboard/assets/app.js', async (_req, reply) => reply.headers(security).type('text/javascript; charset=utf-8').send(js));
  app.get('/dashboard/assets/usage-insights.css', async (_req, reply) => reply.headers(security).type('text/css; charset=utf-8').send(insightsCss));
  app.get('/dashboard/assets/usage-insights.js', async (_req, reply) => reply.headers(security).type('text/javascript; charset=utf-8').send(insightsJs));
  app.get('/dashboard/assets/live.js', async (_req, reply) => reply.headers(security).type('text/javascript; charset=utf-8').send(liveJs));
  app.get('/dashboard/assets/lab.js',async(_req,reply)=>reply.headers(security).type('text/javascript; charset=utf-8').send(labJs));
  app.get('/dashboard/assets/activity-client.js', async (_req, reply) => reply.headers(security).type('text/javascript; charset=utf-8').send(activityClient));
  app.get('/dashboard/assets/favicon.svg', async (_req, reply) => reply.headers(security).type('image/svg+xml; charset=utf-8').send(favicon));
  app.get('/api/videos', async (_req,reply)=>reply.headers(security).send(videos.overview()));
  app.get('/api/videos/sessions', async(req,reply)=>{
    const input=z.object({search:z.string().max(240).default('')}).strict().parse(req.query);
    return reply.headers(security).send({sessions:videos.sessionOptions(input.search)});
  });
  app.get<{Params:{id:string}}>('/api/videos/:id',async(req,reply)=>{
    const id=z.string().min(1).max(128).parse(req.params.id),build=videos.detail(id);
    if(!build)throw new ApiError(404,'video_not_found','Không tìm thấy video build.');
    return reply.headers(security).send({build,manifest:videos.manifest(id)});
  });
  app.post('/api/videos',async(req,reply)=>reply.headers(security).code(201).send(videos.save(req.body)));
  app.post('/api/videos/import',async(req,reply)=>reply.headers(security).code(201).send(videos.save(req.body)));
  app.put<{Params:{id:string}}>('/api/videos/:id',async(req,reply)=>{
    if((req.body as any)?.build?.id!==req.params.id)throw new ApiError(400,'video_id_mismatch','ID manifest phải khớp URL.');
    return reply.headers(security).send(videos.save(req.body,true));
  });
  app.get('/api/native/overview', async (req, reply) => {
    const input = z.object({range:z.enum(['today','yesterday','7d','30d','all','24h']).default('today'),group:z.enum(['day','week','month']).default('day'),model:z.string().max(128).optional(),source:z.string().max(128).optional(),project:z.string().max(4096).optional(),page:z.coerce.number().int().min(1).max(100000).default(1)}).strict().parse(req.query);
    return reply.headers(security).send(native.overview(input));
  });
  app.get('/api/native/insights', async (req, reply) => {
    const input = z.object({range:z.enum(['today','yesterday','7d','30d','all','24h']).default('today'),model:z.string().max(128).optional(),source:z.string().max(128).optional(),project:z.string().max(4096).optional()}).strict().parse(req.query);
    return reply.headers(security).send(native.insights(input));
  });
  app.get<{ Params: { id: string } }>('/api/native/sessions/:id', async (req, reply) => {
    const result = native.detail(z.string().min(1).max(128).parse(req.params.id));
    if (!result) throw new ApiError(404,'session_not_found','Native session not found.');
    return reply.headers(security).send({...result,video_tags:videos.links(req.params.id)});
  });
  app.get('/api/models' , async (_req, reply) => reply.headers(security).send(catalog));
  app.get<{ Params: { id: string } }>('/api/stats/calls/:id/inspector', async (req, reply) => {
    const id = z.uuid().parse(req.params.id), row = metrics.detail(id);
    if (!row) throw new ApiError(404, 'call_not_found', 'Call not found.');
    return reply.headers(security).send(await inspector.detail(id, row.endpoint === '/api/playground/chat'));
  });
  app.delete<{ Params: { id: string } }>('/api/stats/calls/:id/inspector', async (req, reply) => {
    const id = z.uuid().parse(req.params.id);
    if (!metrics.detail(id)) throw new ApiError(404, 'call_not_found', 'Call not found.');
    if (!await inspector.delete(id)) throw new ApiError(503, 'inspector_storage_error', 'Could not delete inspector snapshot.');
    return reply.headers(security).code(204).send();
  });
  app.delete('/api/stats/inspector', async (_req, reply) => {
    if (!await inspector.delete()) throw new ApiError(503, 'inspector_storage_error', 'Could not delete inspector snapshots.');
    return reply.headers(security).code(204).send();
  });
  app.get<{ Params: { id: string } }>('/api/stats/calls/:id', async (req, reply) => {
    const row = metrics.detail(z.uuid().parse(req.params.id));
    if (!row) throw new ApiError(404, 'call_not_found', 'Call not found.');
    return reply.headers(security).send(row);
  });
  app.get('/api/stats/costs', async (req, reply) => {
    const input = z.object({ group: z.enum(['day','week','month']).default('day'), model: z.string().min(1).max(128).optional() }).strict().parse(req.query);
    return reply.headers(security).send(metrics.costs(input.group, input.model));
  });
  const query = z.object({ range: z.enum(['1h', '24h', '7d', '30d']).default('24h'), model: z.string().min(1).max(128).optional() }).strict();
  app.get('/api/stats/overview', async (req, reply) => {
    const input = query.parse(req.query);
    return reply.headers(security).send({ ...metrics.overview(input.range, input.model), server: {
      active_requests: active(), max_concurrent: config.concurrency, default_model: config.model,
      default_reasoning: config.reasoningEffort, uptime_seconds: Math.floor(process.uptime()),
    } });
  });
  app.get('/api/stats/calls', async (req, reply) => {
    const input = query.extend({
      page: z.coerce.number().int().min(1).max(100_000).default(1),
      status: z.enum(['pending', 'running', 'success', 'error', 'rejected', 'cancelled', 'interrupted']).optional(),
    }).parse(req.query);
    return reply.headers(security).send(metrics.list(input.range, input.page, input.status, input.model));
  });
}
