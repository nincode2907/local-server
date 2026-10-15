export type ProviderId='codex'|'ollama'|'lmstudio';
export interface ProviderUsage {
  input_tokens:number;output_tokens:number;cached_input_tokens:number|null;
  reasoning_output_tokens?:number|null;cache_write_input_tokens?:number;
}
export interface ProviderTiming {generation_duration_ms?:number;ttft_ms?:number;tokens_per_second?:number;load_duration_ms?:number;prompt_duration_ms?:number}
export const codexCapabilities={provider:'codex',transport:'cli-jsonl',public_output:'item_updates_when_available',live_tokens:false,final_usage:true,provider_ttft:false,generation_duration:false,cancellation:true,policy:'isolated-cli',output_limit:false,seed:false,tools:'validated_proposals'};
export function providerCapabilities(id:ProviderId) {
  return id==='codex'?codexCapabilities:{provider:id,transport:id==='ollama'?'ndjson':'sse',public_output:'content_deltas',live_tokens:false,final_usage:true,provider_ttft:id==='lmstudio'?'when_reported':false,generation_duration:'when_reported',cancellation:true,policy:'configured-local-http',output_limit:true,seed:true,tools:'validated_proposals'};
}
