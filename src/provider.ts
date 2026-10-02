import type { ThreadItem, TurnOptions, Usage } from '@openai/codex-sdk';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { ApiError } from './errors.js';
import type { Config } from './config.js';
import type { ChatRequest } from './schema.js';

interface ProviderTurn {
  items: ThreadItem[];
  finalResponse: string;
  usage: Usage | null;
}

interface ProviderThread {
  readonly id: string | null;
  run(input: string, options?: TurnOptions): Promise<ProviderTurn>;
}

export interface Provider {
  start(model: string, effort?: ChatRequest['reasoning_effort'], ephemeral?: boolean): ProviderThread;
  resume(id: string, model: string, effort?: ChatRequest['reasoning_effort']): ProviderThread;
  close(): Promise<void>;
}

interface CliEvent {
  type: string;
  thread_id?: string;
  item?: ThreadItem;
  usage?: Usage;
  error?: { message: string };
}

class CliThread implements ProviderThread {
  #id: string | null;

  constructor(
    private readonly command: string,
    private readonly commandPrefix: string[],
    private readonly env: Record<string, string>,
    private readonly runtime: string,
    private readonly instructions: string,
    private readonly model: string,
    private readonly effort?: ChatRequest['reasoning_effort'],
    id: string | null = null,
    private readonly ephemeral = false,
  ) { this.#id = id; }

  get id() { return this.#id; }

  async run(input: string, options: TurnOptions = {}): Promise<ProviderTurn> {
    const schemaPath = options.outputSchema ? join(this.runtime, `schema-${randomUUID()}.json`) : undefined;
    if (schemaPath) await writeFile(schemaPath, JSON.stringify(options.outputSchema), 'utf8');
    const config = (key: string, value: unknown) => ['--config', `${key}=${JSON.stringify(value)}`];
    const args = [
      ...this.commandPrefix, 'exec', '--ignore-user-config', '--ignore-rules', '--experimental-json',
      ...config('forced_login_method', 'chatgpt'),
      ...config('model_instructions_file', this.instructions),
      ...config('project_doc_max_bytes', 0),
      ...config('web_search', 'disabled'),
      ...config('features.shell_tool', false),
      ...config('features.unified_exec', false),
      ...config('features.apps', false),
      ...config('features.plugins', false),
      ...config('features.multi_agent', false),
      ...config('features.multi_agent_v2', false),
      ...config('features.computer_use', false),
      ...config('features.shell_snapshot', false),
      ...config('apps._default.enabled', false),
      '--model', this.model,
      '--sandbox', 'read-only',
      '--cd', this.runtime,
      '--skip-git-repo-check',
      ...config('sandbox_workspace_write.network_access', false),
      ...config('approval_policy', 'never'),
      ...(this.effort ? config('model_reasoning_effort', this.effort) : []),
      ...(this.ephemeral ? ['--ephemeral'] : []),
      ...(schemaPath ? ['--output-schema', schemaPath] : []),
      ...(this.#id ? ['resume', this.#id] : []),
    ];

    try {
      const child = spawn(this.command, args, { env: this.env, signal: options.signal });
      const stderr: Buffer[] = [];
      child.stderr.on('data', chunk => stderr.push(chunk));
      const exited = new Promise<void>((resolveExit, rejectExit) => {
        child.once('error', rejectExit);
        child.once('exit', (code, signal) => {
          if (code === 0 && !signal) resolveExit();
          else rejectExit(new Error(`Codex Exec exited with ${signal ? `signal ${signal}` : `code ${code ?? 1}`}: ${Buffer.concat(stderr).toString('utf8')}`));
        });
      });
      child.stdin.end(input);
      const items: ThreadItem[] = [];
      let finalResponse = '';
      let usage: Usage | null = null;
      let failure: string | undefined;
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          const event = JSON.parse(line) as CliEvent;
          if (event.type === 'thread.started' && event.thread_id) this.#id = event.thread_id;
          else if (event.type === 'item.completed' && event.item) {
            items.push(event.item);
            if (event.item.type === 'agent_message') finalResponse = event.item.text;
          } else if (event.type === 'turn.completed' && event.usage) {
            event.usage.cache_write_input_tokens ??= 0;
            usage = event.usage;
          }
          else if (event.type === 'turn.failed') failure = event.error?.message ?? 'Codex turn failed.';
        }
        await exited;
      } finally {
        lines.close();
        if (!child.killed) child.kill();
      }
      if (failure) throw new Error(failure);
      return { items, finalResponse, usage };
    } finally {
      if (schemaPath) await rm(schemaPath, { force: true });
    }
  }
}

export async function createProvider(config: Config): Promise<Provider> {
  const runtime = await mkdtemp(join(tmpdir(), 'codex-gateway-'));
  const require = createRequire(import.meta.url);
  const bundledCli = require.resolve('@openai/codex/bin/codex.js');
  const instructions = join(runtime, 'instructions.md');
  await writeFile(instructions, 'You are a text assistant for a local chat gateway. Respond to the provided conversation using the requested JSON schema. Do not use local tools, read files, modify files, run shell commands, search the web, or contact integrations. Function calls in your final JSON are proposals for the caller to execute.');
  const command = config.codexBin ? resolve(config.codexBin) : process.execPath;
  const commandPrefix = config.codexBin ? [] : [bundledCli];
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: homedir() };
  for (const key of ['CODEX_HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  // API keys, caller env, provider overrides and custom proxy endpoints are deliberately not inherited.
  const make = (model: string, effort?: ChatRequest['reasoning_effort'], id: string | null = null, ephemeral = false) =>
    new CliThread(command, commandPrefix, env, runtime, instructions, model, effort, id, ephemeral);
  return {
    start: (model, effort, ephemeral) => make(model, effort, null, ephemeral),
    resume: (id, model, effort) => make(model, effort, id),
    close: () => rm(runtime, { recursive: true, force: true }),
  };
}

export function assertNoAgentTools(items: { type: string }[]) {
  if (items.some(i => ['command_execution', 'file_change', 'mcp_tool_call', 'web_search'].includes(i.type))) {
    throw new ApiError(502, 'unexpected_agent_tool', 'Codex attempted an agent tool. Request rejected.');
  }
}
