import type {Config} from './config.js';
import type {Provider} from './provider.js';
import {providerCapabilities,type ProviderId} from './provider-types.js';
import {LocalProvider} from './local-provider.js';
import type {ChatRequest} from './schema.js';
import {ApiError} from './errors.js';
import {catalog} from './catalog.js';

export class ProviderRegistry {
  private local=new Map<ProviderId,LocalProvider>();
  constructor(private config:Config,readonly codex:Provider) {
    for(const id of ['ollama','lmstudio'] as const){const settings=config.localProviders[id];if(settings)this.local.set(id,new LocalProvider(id,settings,config.localProviderTimeout));}
  }
  describe() {return (['codex','ollama','lmstudio'] as const).map(id=>({id,enabled:id==='codex'||this.local.has(id),capabilities:providerCapabilities(id)}));}
  resolve(request:ChatRequest) {
    const id=request.provider??'codex';
    if(id==='codex') {if(request.max_tokens!==undefined||request.seed!==undefined)throw new ApiError(400,'unsupported_provider_option','Codex does not support max_tokens or seed.');return {id,adapter:this.codex};}
    const adapter=this.local.get(id);if(!adapter)throw new ApiError(400,'provider_disabled','Provider is not configured on this server.');
    if(!request.model)throw new ApiError(400,'local_model_required','Select an explicit model for a local provider.');
    if(request.reasoning||request.reasoning_effort)throw new ApiError(400,'unsupported_provider_option','Codex reasoning options do not apply to local providers.');
    return {id,adapter};
  }
  async models(id:ProviderId) {
    if(id==='codex')return [...new Set([this.config.model,...catalog.models.filter(m=>m.chat_supported).map(m=>m.id)])].map(id=>({id,provider:'codex',state:'remote',quantization:null,context_length:null}));
    const adapter=this.local.get(id);if(!adapter)throw new ApiError(400,'provider_disabled','Provider is not configured.');return adapter.models();
  }
  async resources() {return Promise.all((['ollama','lmstudio'] as const).map(async id=>{
    const adapter=this.local.get(id);if(!adapter)return {provider:id,available:false,reason:'Provider is not configured.'};
    try{return {provider:id,...await adapter.resources()};}catch{return {provider:id,available:false,reason:'Provider resource API unavailable.'};}
  }));}
}
