import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = z.object({
    PORT: z.coerce.number().int().min(1).max(65535).default(15600),
    DEFAULT_MODEL: z.string().min(1).default('gpt-6-luna'),
    DEFAULT_REASONING_EFFORT: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent']).default('low'),
    REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1).default(180_000),
    MAX_CONCURRENT: z.coerce.number().int().min(1).default(2),
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
  return { port: parsed.PORT, model: parsed.DEFAULT_MODEL, reasoningEffort: parsed.DEFAULT_REASONING_EFFORT, timeout: parsed.REQUEST_TIMEOUT_MS,
    concurrency: parsed.MAX_CONCURRENT, maxSessions: parsed.MAX_SESSIONS, sessionTtl: parsed.SESSION_TTL_MS,
    apiKey: parsed.LOCAL_API_KEY, dataDir: resolve(parsed.DATA_DIR), codexBin: parsed.CODEX_BIN,
    nativeCodexHome: resolve(parsed.NATIVE_CODEX_HOME ?? env.CODEX_HOME ?? join(homedir(), '.codex')), nativeUsageInterval: parsed.NATIVE_USAGE_INTERVAL_MS,
    statsDbPath: resolve(parsed.STATS_DB_PATH ?? join(parsed.DATA_DIR, 'stats.sqlite')),
    inspectorEnabled: parsed.INSPECTOR_ENABLED, inspectorRetention: parsed.INSPECTOR_RETENTION_MS, inspectorMaxBytes: parsed.INSPECTOR_MAX_BYTES,
    inspectorSecrets: Object.entries(env).filter(([key,value]) => value && /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)).map(([,value]) => value!) };
}
export type Config = ReturnType<typeof readConfig>;
