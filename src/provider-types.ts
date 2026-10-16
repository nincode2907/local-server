export type ProviderId='codex'|'ollama'|'lmstudio';
export interface ProviderUsage {
  input_tokens:number;output_tokens:number;cached_input_tokens:number|null;
  reasoning_output_tokens?:number|null;cache_write_input_tokens?:number;
}
export interface ProviderTiming {generation_duration_ms?:number;ttft_ms?:number;tokens_per_second?:number;load_duration_ms?:number;prompt_duration_ms?:number}
export interface CliLifecycleTiming {
  spawn_requested_ms:number|null;process_spawned_ms:number|null;stdin_finished_ms:number|null;stdin_closed_ms:number|null;
  first_stdout_event_ms:number|null;turn_completed_event_received_ms:number|null;turn_completed_event_delivered_ms:number|null;
  stdout_iterator_completed_ms:number|null;stdout_ended_ms:number|null;stdout_closed_ms:number|null;
  stderr_ended_ms:number|null;stderr_closed_ms:number|null;child_process_exited_ms:number|null;child_process_closed_ms:number|null;
  response_observer_started_ms:number|null;response_observer_finished_ms:number|null;
  schema_cleanup_started_ms:number|null;schema_cleanup_finished_ms:number|null;provider_returned_ms:number|null;
  stdout_event_count:number;events_after_turn_completed_count:number;last_post_turn_event_type:string|null;last_post_turn_event_ms:number|null;
}
export const codexCapabilities={provider:'codex',transport:'cli-jsonl',public_output:'item_updates_when_available',live_tokens:false,final_usage:true,provider_ttft:false,generation_duration:false,cancellation:true,policy:'isolated-cli',output_limit:false,seed:false,tools:'validated_proposals'};
export function providerCapabilities(id:ProviderId) {
  return id==='codex'?codexCapabilities:{provider:id,transport:id==='ollama'?'ndjson':'sse',public_output:'content_deltas',live_tokens:false,final_usage:true,provider_ttft:id==='lmstudio'?'when_reported':false,generation_duration:'when_reported',cancellation:true,policy:'configured-local-http',output_limit:true,seed:true,tools:'validated_proposals'};
}
