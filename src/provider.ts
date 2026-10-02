import { Codex, type Thread, type ThreadOptions } from '@openai/codex-sdk';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { ApiError } from './errors.js';
import type { Config } from './config.js';
import type { ChatRequest } from './schema.js';

export interface Provider {
  start(model: string, effort?: ChatRequest['reasoning_effort']): Thread;
  resume(id: string, model: string, effort?: ChatRequest['reasoning_effort']): Thread;
  close(): Promise<void>;
}
export async function createProvider(config: Config): Promise<Provider> {
  if (process.platform === 'win32') throw new Error('V1 supports macOS/Linux. Use WSL on Windows.');
  const runtime = await mkdtemp(join(tmpdir(), 'codex-gateway-'));
  const require = createRequire(import.meta.url);
  const bundledCli = require.resolve('@openai/codex/bin/codex.js');
  const instructions = join(runtime, 'instructions.md');
  await writeFile(instructions, 'You are a text assistant for a local chat gateway. Respond to the provided conversation using the requested JSON schema. Do not use local tools, read files, modify files, run shell commands, search the web, or contact integrations. Function calls in your final JSON are proposals for the caller to execute.');
  const quote = (v: string) => `'${v.replaceAll("'", "'\\''")}'`;
  const wrapper = join(runtime, 'codex-safe');
  // exec preserves PID/signals; the npm CLI also forwards termination to its native child.
  const command = config.codexBin ? quote(resolve(config.codexBin)) : `${quote(process.execPath)} ${quote(bundledCli)}`;
  await writeFile(wrapper, `#!/bin/sh\nif [ "$1" != exec ]; then exit 64; fi\nshift\nexec ${command} exec --ignore-user-config --ignore-rules "$@"\n`, { mode: 0o700 });
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: homedir() };
  for (const key of ['CODEX_HOME', 'TMPDIR', 'LANG', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) if (process.env[key]) env[key] = process.env[key]!;
  // API keys, caller env, provider overrides and custom proxy endpoints are deliberately not inherited.
  const codex = new Codex({ codexPathOverride: wrapper, env, config: {
    forced_login_method: 'chatgpt', model_instructions_file: instructions,
    project_doc_max_bytes: 0, web_search: 'disabled',
    features: { shell_tool: false, unified_exec: false, apps: false, plugins: false,
      multi_agent: false, multi_agent_v2: false, computer_use: false, shell_snapshot: false },
    apps: { _default: { enabled: false } },
  } });
  const options = (model: string, effort?: ChatRequest['reasoning_effort']): ThreadOptions => ({
    model, ...(effort && { modelReasoningEffort: effort }), workingDirectory: runtime,
    skipGitRepoCheck: true, sandboxMode: 'read-only', approvalPolicy: 'never',
    networkAccessEnabled: false, webSearchMode: 'disabled',
  });
  return {
    start: (model, effort) => codex.startThread(options(model, effort)),
    resume: (id, model, effort) => codex.resumeThread(id, options(model, effort)),
    close: () => rm(runtime, { recursive: true, force: true }),
  };
}

export function assertNoAgentTools(items: { type: string }[]) {
  if (items.some(i => ['command_execution', 'file_change', 'mcp_tool_call', 'web_search'].includes(i.type))) {
    throw new ApiError(502, 'unexpected_agent_tool', 'Codex attempted an agent tool. Request rejected.');
  }
}
