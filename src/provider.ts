import type { ThreadItem, TurnOptions } from '@openai/codex-sdk';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { ApiError } from './errors.js';
import type { Config } from './config.js';
import { openEgress, egressEnv, type EgressFactory } from './egress-forwarder.js';
import type { ChatRequest } from './schema.js';
import type {ProviderUsage as Usage,ProviderTiming,CliLifecycleTiming,AppServerLifecycleTiming} from './provider-types.js';

export interface ProviderTurn {
  timing?:ProviderTiming;
  cliLifecycle?:CliLifecycleTiming;
  finishReason?:'stop'|'length'|'tool_calls';
  items: ThreadItem[];
  finalResponse: string;
  usage: Usage | null;
}

export const gatewayInstructions = 'You are a text assistant for a local chat gateway. Respond to the provided conversation using the requested JSON schema. Do not use local tools, read files, modify files, run shell commands, search the web, or contact integrations. Function calls in your final JSON are proposals for the caller to execute.';
export type PublicProviderEvent = {type:'output'; item_id:string; text:string} | {type:'usage'; usage:Usage} | {type:'timing';timing:ProviderTiming};
export type ObservedTurnOptions = TurnOptions & { observe?: (context: unknown) => Promise<void>; observeResponse?: (response: unknown) => Promise<void>; onEvent?: (event:PublicProviderEvent) => void; onLifecycle?:(timing:CliLifecycleTiming)=>void; onAppServerLifecycle?:(timing:AppServerLifecycleTiming)=>void; request?:ChatRequest; onProcess?:(pid:number,active:boolean,scope?:string)=>void;
  /** Return at `turn.completed` once the final answer and usage are in hand; the CLI is reaped in the background. Only for turns that are never resumed. */
  returnOnTurnCompleted?:boolean;
  /** Called when a CLI that was already answered from exits non-zero or by signal. stderr is never passed. */
  onLateExit?:(exit:{code:number|null;signal:string|null})=>void };
export interface ProviderThread {
  readonly id: string | null;
  run(input: string, options?: ObservedTurnOptions): Promise<ProviderTurn>;
}

export interface Provider {
  canResume?(id: string): boolean;
  warmup?(): Promise<void>;
  /** `stateless` marks a request that owns no session; only such threads may be recycled by a provider. */
  start(model: string, effort?: ChatRequest['reasoning_effort'], ephemeral?: boolean, options?: { stateless?: boolean }): ProviderThread;
  /** Admin-only metadata about the gateway-owned egress forwarder (hosts, counts, timings), or null. */
  egress?(): unknown;
  resume(id: string, model: string, effort?: ChatRequest['reasoning_effort']): ProviderThread;
  close(): Promise<void>;
}

interface CliEvent {
  type: string;
  thread_id?: string;
  item?: ThreadItem;
  usage?: Usage;
  error?: { message: string };
  message?: string;
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

  async run(input: string, options: ObservedTurnOptions = {}): Promise<ProviderTurn> {
    const lifecycle:CliLifecycleTiming={spawn_requested_ms:null,process_spawned_ms:null,stdin_finished_ms:null,stdin_closed_ms:null,
      first_stdout_event_ms:null,turn_completed_event_received_ms:null,turn_completed_event_delivered_ms:null,stdout_iterator_completed_ms:null,
      stdout_ended_ms:null,stdout_closed_ms:null,stderr_ended_ms:null,stderr_closed_ms:null,child_process_exited_ms:null,child_process_closed_ms:null,
      child_process_exit_code:null,child_process_signal:null,
      response_observer_started_ms:null,response_observer_finished_ms:null,schema_cleanup_started_ms:null,schema_cleanup_finished_ms:null,provider_returned_ms:null,
      stdout_event_count:0,events_after_turn_completed_count:0,last_post_turn_event_type:null,last_post_turn_event_ms:null,
      reconnect_count:0,first_reconnect_ms:null,last_reconnect_message:null,returned_before_exit:false};
    const lifecycleStarted=performance.now();
    const mark=(point:Exclude<keyof CliLifecycleTiming,'stdout_event_count'|'events_after_turn_completed_count'|'last_post_turn_event_type'|'last_post_turn_event_ms'|'child_process_exit_code'|'child_process_signal'|'reconnect_count'|'first_reconnect_ms'|'last_reconnect_message'|'returned_before_exit'>)=>{lifecycle[point]=performance.now()-lifecycleStarted;options.onLifecycle?.({...lifecycle});};
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

    let result:ProviderTurn|undefined;
    try {
      await options.observe?.({ stdin: input, instructions: gatewayInstructions, output_schema: options.outputSchema ?? null,
        model: this.model, reasoning_effort: this.effort ?? null, thread_id: this.#id, ephemeral: this.ephemeral,
        policy: { sandbox: 'read-only', approval: 'never', network: false, agent_tools: false, ignore_user_config: true, ignore_rules: true },
        internal_context: { provenance: 'Internal / unavailable', available: false, description: 'Provider-internal prompt and resumed CLI history are not exposed by this gateway.' } });
      mark('spawn_requested_ms');
      const child = spawn(this.command, args, { env: this.env, signal: options.signal });
      child.once('spawn',()=>mark('process_spawned_ms'));
      child.stdin.once('finish',()=>mark('stdin_finished_ms'));
      child.stdin.once('close',()=>mark('stdin_closed_ms'));
      child.stdout.once('end',()=>mark('stdout_ended_ms'));
      child.stdout.once('close',()=>mark('stdout_closed_ms'));
      child.stderr.once('end',()=>mark('stderr_ended_ms'));
      child.stderr.once('close',()=>mark('stderr_closed_ms'));
      child.once('exit',(code,signal)=>{lifecycle.child_process_exit_code=code;lifecycle.child_process_signal=signal;mark('child_process_exited_ms');});
      const processClosed=new Promise<void>(resolveClose=>child.once('close',()=>{mark('child_process_closed_ms');resolveClose();}));
      let forceKillTimer:ReturnType<typeof setTimeout>|undefined;
      const terminateCancelledProcess=()=>{
        if(child.exitCode!==null||child.signalCode!==null)return;
        child.kill('SIGTERM');
        forceKillTimer=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');},2_000);
        forceKillTimer.unref();
      };
      options.signal?.addEventListener('abort',terminateCancelledProcess,{once:true});
      child.once('close',()=>{if(forceKillTimer)clearTimeout(forceKillTimer);options.signal?.removeEventListener('abort',terminateCancelledProcess);});
      if(options.signal?.aborted)terminateCancelledProcess();
      if(child.pid)options.onProcess?.(child.pid,true,this.commandPrefix.length?'codex_cli_launcher_process':'codex_cli_process');
      child.once('close',()=>{if(child.pid)options.onProcess?.(child.pid,false,this.commandPrefix.length?'codex_cli_launcher_process':'codex_cli_process');});
      const stderr: Buffer[] = [];
      child.stderr.on('data', chunk => stderr.push(chunk));
      const exited = new Promise<void>((resolveExit, rejectExit) => {
        child.once('error', rejectExit);
        child.once('exit', (code, signal) => {
          if (code === 0 && !signal) resolveExit();
          else rejectExit(new Error(`Codex Exec exited with ${signal ? `signal ${signal}` : `code ${code ?? 1}`}: ${Buffer.concat(stderr).toString('utf8')}`));
        });
      });
      // stdout may close after the exit event; keep rejection handled until awaited below.
      void exited.catch(() => {});
      child.stdin.end(input);
      const items: ThreadItem[] = [];
      let finalResponse = '';
      let usage: Usage | null = null;
      let failure: string | undefined;
      let turnCompleted=false;
      const publicErrors: { type: string; message: string }[] = [];
      let exitedSuccessfully = false;
      let earlyReturn=false;
      let stdoutCompleted=false;
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (Buffer.byteLength(line) > 2_097_152) throw new ApiError(502, 'provider_event_limit', 'Provider event exceeds limit.');
          const event = JSON.parse(line) as CliEvent;
          if(lifecycle.first_stdout_event_ms===null)mark('first_stdout_event_ms');
          lifecycle.stdout_event_count++;
          if(lifecycle.turn_completed_event_received_ms!==null){
            lifecycle.events_after_turn_completed_count++;
            lifecycle.last_post_turn_event_type=event.type;
            lifecycle.last_post_turn_event_ms=performance.now()-lifecycleStarted;
          }
          if (event.item) {
            assertNoAgentTools([event.item]);
            if (['item.started','item.updated','item.completed'].includes(event.type) && event.item.type === 'agent_message')
              options.onEvent?.({type:'output',item_id:event.item.id,text:event.item.text});
          }
          if (event.type === 'thread.started' && event.thread_id) this.#id = event.thread_id;
          else if (event.type === 'item.completed' && event.item) {
            items.push(event.item);
            if (event.item.type === 'agent_message') finalResponse = event.item.text;
          } else if (event.type === 'turn.completed') {
            turnCompleted=true;
            mark('turn_completed_event_received_ms');
            if(event.usage){event.usage.cache_write_input_tokens ??= 0;usage = event.usage;options.onEvent?.({type:'usage',usage});}
            mark('turn_completed_event_delivered_ms');
            if(options.returnOnTurnCompleted&&usage&&finalResponse&&!failure){earlyReturn=true;break;}
          }
          else if (event.type === 'turn.failed') failure = event.error?.message ?? 'Codex turn failed.';
          else if (event.type === 'error' && typeof event.message === 'string') {
            publicErrors.push({type:'error',message:event.message});
            // The CLI retries upstream timeouts itself and reports them as "Reconnecting... n/5 (reason)"; keep a bounded, content-free trace.
            if(/^Reconnecting\b/.test(event.message)){lifecycle.reconnect_count++;lifecycle.first_reconnect_ms??=performance.now()-lifecycleStarted;lifecycle.last_reconnect_message=event.message.slice(0,160);options.onLifecycle?.({...lifecycle});}
          }
        }
        mark('stdout_iterator_completed_ms');
        stdoutCompleted=true;
        if(earlyReturn){
          lifecycle.returned_before_exit=true;exitedSuccessfully=true;
          child.stdout.resume();
          // Bounded background reap: late stdout is discarded, a hung child is terminated, a failed exit is reported but never changes the answer.
          const reapTimer=setTimeout(terminateCancelledProcess,30_000);reapTimer.unref();
          void processClosed.then(()=>clearTimeout(reapTimer));
          const lateExit=(code:number|null,signal:NodeJS.Signals|null)=>{if(code!==0||signal)options.onLateExit?.({code,signal});};
          if(child.exitCode!==null||child.signalCode!==null)lateExit(child.exitCode,child.signalCode);else child.once('exit',lateExit);
        }else{
          await exited;
          exitedSuccessfully = true;
          if(!turnCompleted)failure='Codex exited without a terminal turn event.';
        }
      } finally {
        lines.close();
        if ((options.signal?.aborted||!stdoutCompleted)&&child.exitCode===null&&child.signalCode===null) terminateCancelledProcess();
        if(!earlyReturn)await processClosed;
        mark('response_observer_started_ms');
        await options.observeResponse?.({ final_response: finalResponse, assistant_messages: items.filter(item => item.type === 'agent_message'),
          usage, thread_id: this.#id, complete: exitedSuccessfully && turnCompleted && !failure, turn_error: failure ?? null,
          errors: publicErrors,
          error_code: !exitedSuccessfully ? 'cli_incomplete' : !turnCompleted ? 'cli_missing_terminal' : failure ? 'turn_failed' : null,
          internal_reasoning: { provenance: 'Internal / unavailable', available: false, reason: 'Private reasoning and stderr are never recorded.' } });
        mark('response_observer_finished_ms');
      }
      if (failure) throw new Error(failure);
      result={items,finalResponse,usage,cliLifecycle:lifecycle};
    } finally {
      if (schemaPath) {mark('schema_cleanup_started_ms');await rm(schemaPath, { force: true });mark('schema_cleanup_finished_ms');}
      options.onLifecycle?.({...lifecycle});
    }
    if(!result)throw new Error('Codex provider completed without a result.');
    mark('provider_returned_ms');
    result.cliLifecycle={...lifecycle};
    options.onLifecycle?.({...lifecycle});
    return result;
  }
}

export async function createProvider(config: Config, hooks: { egress?: EgressFactory } = {}): Promise<Provider> {
  if (config.codexTransport === 'app-server') {
    const { createAppServerProvider } = await import('./app-server-provider.js');
    return createAppServerProvider(config, hooks);
  }
  const runtime = await mkdtemp(join(tmpdir(), 'codex-gateway-'));
  const require = createRequire(import.meta.url);
  const bundledCli = require.resolve('@openai/codex/bin/codex.js');
  const instructions = join(runtime, 'instructions.md');
  await writeFile(instructions, gatewayInstructions);
  const command = config.codexBin ? resolve(config.codexBin) : process.execPath;
  const commandPrefix = config.codexBin ? [] : [bundledCli];
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: homedir() };
  for (const key of ['CODEX_HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  // API keys, caller env, provider overrides and custom proxy endpoints are deliberately not inherited.
  // The only proxy is the gateway-owned loopback forwarder (see egress-forwarder.ts).
  const forwarder = await openEgress(config.codexEgressForwarder ?? false, hooks.egress);
  Object.assign(env, egressEnv(forwarder));
  const make = (model: string, effort?: ChatRequest['reasoning_effort'], id: string | null = null, ephemeral = false) =>
    new CliThread(command, commandPrefix, env, runtime, instructions, model, effort, id, ephemeral);
  return {
    canResume: id => !id.startsWith('app-server:'),
    start: (model, effort, ephemeral) => make(model, effort, null, ephemeral),
    resume: (id, model, effort) => make(model, effort, id),
    egress: () => forwarder ? { enabled: true, ...forwarder.snapshot() } : null,
    close: async () => { await forwarder?.close(); await rm(runtime, { recursive: true, force: true }); },
  };
}

export function assertNoAgentTools(items: { type: string }[]) {
  if (items.some(i => ['command_execution', 'file_change', 'mcp_tool_call', 'web_search'].includes(i.type))) {
    throw new ApiError(502, 'unexpected_agent_tool', 'Codex attempted an agent tool. Request rejected.');
  }
}
