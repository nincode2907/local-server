import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import {validateLocalEndpoint} from './local-endpoint.js';

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = z.object({
    PORT: z.coerce.number().int().min(1).max(65535).default(15600),
    HOST: z.string().refine(v => v === 'localhost' || isIP(v) !== 0, 'HOST must be an IP address or localhost.').default('127.0.0.1'),
    TRUSTED_HOSTS: z.string().default(''),
    APP_API_KEYS: z.string().default('[]'),
    DEFAULT_MODEL: z.string().min(1).default('gpt-6-luna'),
    DEFAULT_REASONING_EFFORT: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent']).default('low'),
    REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1).default(180_000),
    MAX_CONCURRENT: z.coerce.number().int().min(1).default(2),
    MAX_QUEUE: z.coerce.number().int().min(0).max(64).default(0),
    QUEUE_TIMEOUT_MS:z.coerce.number().int().min(1).max(600_000).default(30_000),
    OLLAMA_BASE_URL:z.string().optional(),
    LM_STUDIO_BASE_URL:z.string().optional(),
    LOCAL_PROVIDER_HOSTS:z.string().default(''),
    OLLAMA_API_KEY:z.string().min(1).optional(),
    LM_STUDIO_API_KEY:z.string().min(1).optional(),
    LM_STUDIO_API:z.enum(['openai','v0']).default('openai'),
    LOCAL_PROVIDER_TIMEOUT_MS:z.coerce.number().int().min(100).max(600_000).default(180_000),
    OLLAMA_PID:z.coerce.number().int().positive().optional(),
    LM_STUDIO_PID:z.coerce.number().int().positive().optional(),
    LAB_ALLOW_CODEX:z.enum(['true','false']).default('false'),
    LAB_MAX_REQUESTS_PER_DAY:z.coerce.number().int().min(1).max(10000).default(200),
    LAB_RETENTION_DAYS:z.coerce.number().int().min(1).max(30).default(7),
    LAB_MIN_INTERVAL_MS:z.coerce.number().int().min(1).max(60000).default(1000),
    MAX_SESSIONS: z.coerce.number().int().min(1).default(100),
    SESSION_TTL_MS: z.coerce.number().int().min(1).default(86_400_000),
    LOCAL_API_KEY: z.string().min(1).optional(),
    DATA_DIR: z.string().default('.local'),
    STATS_DB_PATH: z.string().min(1).optional(),
    NATIVE_CODEX_HOME: z.string().min(1).optional(),
    NATIVE_USAGE_INTERVAL_MS: z.coerce.number().int().min(5000).default(30000),
    CODEX_BIN: z.string().optional(),
    INSPECTOR_ENABLED: z.enum(['true', 'false', '1', '0']).default('false').transform(v => v === 'true' || v === '1'),
    INSPECTOR_RETENTION_MS: z.coerce.number().int().min(1000).max(2_592_000_000).default(86_400_000),
    INSPECTOR_MAX_BYTES: z.coerce.number().int().min(4096).max(67_108_864).default(8_388_608),
  }).parse(env);
  const clients = z.array(z.object({id:z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),key:z.string().min(24).max(512)}).strict()).max(64).parse(JSON.parse(parsed.APP_API_KEYS));
  const trustedHosts = parsed.TRUSTED_HOSTS.split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
  if (trustedHosts.some(v => !/^(?:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?|\[[a-f0-9:]+\])$/.test(v))) throw new Error('TRUSTED_HOSTS must contain exact hostnames without ports or wildcards.');
  const localHosts=parsed.LOCAL_PROVIDER_HOSTS.split(',').map(h=>h.trim().toLowerCase()).filter(Boolean);
  const ollamaUrl=parsed.OLLAMA_BASE_URL?validateLocalEndpoint(parsed.OLLAMA_BASE_URL,localHosts):undefined;
  const lmstudioUrl=parsed.LM_STUDIO_BASE_URL?validateLocalEndpoint(parsed.LM_STUDIO_BASE_URL,localHosts):undefined;
  const keys = clients.map(c => c.key);
  if (new Set(clients.map(c => c.id)).size !== clients.length || new Set(keys).size !== clients.length || keys.includes(parsed.LOCAL_API_KEY ?? '')) throw new Error('Application identities and keys must be unique.');
  if ((!['localhost','::1'].includes(parsed.HOST) && !parsed.HOST.startsWith('127.') || trustedHosts.length || clients.length) && !parsed.LOCAL_API_KEY) throw new Error('LOCAL_API_KEY is required for application keys, extra trusted hosts or non-loopback binds.');
  return { localProviders:{ollama:ollamaUrl?{url:ollamaUrl,key:parsed.OLLAMA_API_KEY,pid:parsed.OLLAMA_PID}:undefined,lmstudio:lmstudioUrl?{url:lmstudioUrl,key:parsed.LM_STUDIO_API_KEY,pid:parsed.LM_STUDIO_PID,api:parsed.LM_STUDIO_API}:undefined},
    localProviderTimeout:parsed.LOCAL_PROVIDER_TIMEOUT_MS,labAllowCodex:parsed.LAB_ALLOW_CODEX==='true',labDailyLimit:parsed.LAB_MAX_REQUESTS_PER_DAY,labRetentionDays:parsed.LAB_RETENTION_DAYS,labMinInterval:parsed.LAB_MIN_INTERVAL_MS,
    port: parsed.PORT, host: parsed.HOST, trustedHosts,
    clientKeys: clients.map(c => ({id:c.id,hash:createHash('sha256').update(c.key).digest('hex')})),
    model: parsed.DEFAULT_MODEL, reasoningEffort: parsed.DEFAULT_REASONING_EFFORT, timeout: parsed.REQUEST_TIMEOUT_MS,
    concurrency: parsed.MAX_CONCURRENT, maxSessions: parsed.MAX_SESSIONS, sessionTtl: parsed.SESSION_TTL_MS,
    maxQueue:parsed.MAX_QUEUE,queueTimeout:parsed.QUEUE_TIMEOUT_MS,
    apiKey: parsed.LOCAL_API_KEY, dataDir: resolve(parsed.DATA_DIR), codexBin: parsed.CODEX_BIN,
    nativeCodexHome: resolve(parsed.NATIVE_CODEX_HOME ?? env.CODEX_HOME ?? join(homedir(), '.codex')), nativeUsageInterval: parsed.NATIVE_USAGE_INTERVAL_MS,
    statsDbPath: resolve(parsed.STATS_DB_PATH ?? join(parsed.DATA_DIR, 'stats.sqlite')),
    inspectorEnabled: parsed.INSPECTOR_ENABLED, inspectorRetention: parsed.INSPECTOR_RETENTION_MS, inspectorMaxBytes: parsed.INSPECTOR_MAX_BYTES,
    inspectorSecrets: [...keys, ...Object.entries(env).filter(([key,value]) => value && /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)).map(([,value]) => value!)] };
}
export type Config = ReturnType<typeof readConfig>;
