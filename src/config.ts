import { resolve } from 'node:path';
import { z } from 'zod';

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = z.object({
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    DEFAULT_MODEL: z.string().min(1).default('gpt-6.1-sol'),
    DEFAULT_REASONING_EFFORT: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent']).default('medium'),
    REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1).default(180_000),
    MAX_CONCURRENT: z.coerce.number().int().min(1).default(2),
    MAX_SESSIONS: z.coerce.number().int().min(1).default(100),
    SESSION_TTL_MS: z.coerce.number().int().min(1).default(86_400_000),
    LOCAL_API_KEY: z.string().min(1).optional(),
    DATA_DIR: z.string().default('.local'),
    CODEX_BIN: z.string().optional(),
  }).parse(env);
  return { port: parsed.PORT, model: parsed.DEFAULT_MODEL, reasoningEffort: parsed.DEFAULT_REASONING_EFFORT, timeout: parsed.REQUEST_TIMEOUT_MS,
    concurrency: parsed.MAX_CONCURRENT, maxSessions: parsed.MAX_SESSIONS, sessionTtl: parsed.SESSION_TTL_MS,
    apiKey: parsed.LOCAL_API_KEY, dataDir: resolve(parsed.DATA_DIR), codexBin: parsed.CODEX_BIN };
}
export type Config = ReturnType<typeof readConfig>;
