import { catalog } from './catalog.js';
import { ApiError } from './errors.js';
import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Metrics } from './metrics.js';

export function dashboardAsset(path: string) {
  return ['/', '/dashboard', '/dashboard/assets/style.css', '/dashboard/assets/app.js'].includes(path);
}
export function dashboardRead(path: string) {
  return dashboardAsset(path) || ['/api/models', '/api/stats/costs', '/api/stats/overview', '/api/stats/calls'].includes(path) || /^\/api\/stats\/calls\/[a-f0-9-]{36}$/.test(path);
}
export async function registerDashboard(app: FastifyInstance, metrics: Metrics, config: Config, active: () => number) {
  const html = await readFile(new URL('../public/dashboard.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../public/dashboard.css', import.meta.url), 'utf8');
  const js = await readFile(new URL('../public/dashboard.js', import.meta.url), 'utf8');
  const security = {
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  };
  app.get('/', async (_req, reply) => reply.redirect('/dashboard'));
  app.get('/dashboard', async (_req, reply) => reply.headers(security).type('text/html; charset=utf-8').send(html));
  app.get('/dashboard/assets/style.css', async (_req, reply) => reply.headers(security).type('text/css; charset=utf-8').send(css));
  app.get('/dashboard/assets/app.js', async (_req, reply) => reply.headers(security).type('text/javascript; charset=utf-8').send(js));
  app.get('/api/models', async (_req, reply) => reply.headers(security).send(catalog));
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
