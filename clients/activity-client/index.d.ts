export interface Metric {value:number|null;unit:string;source:string;reason?:string|null;total_observed?:number;window?:string}
export interface Sample {index:number;seq:number;elapsed_ms:number;bytes:number;characters:number;tokens:number|null;kind:'output'|'usage'}
export interface WorkflowStage {id:string;status:string;started_at:number;finished_at:number|null;progress:{completed:number;total:number}|null;label?:string;message?:string}
export interface Workflow {status:string;version:number;source:'client_reported';stages?:WorkflowStage[];label?:string;message?:string}
export interface RunSnapshot {
  run_id:string;call_id:string;model:string;provider:string;status:'queued'|'running'|'completed'|'failed'|'cancelled'|'interrupted';
  created_at:number;seq:number;ephemeral:boolean;error_code:string|null;
  benchmark?:{batch_id:string;phase:'warmup'|'measured';iteration:number;scenario:string};
  metrics:Record<string,Metric>;timeline:Record<string,number|null>;capabilities:Record<string,unknown>;
  history?:{available:boolean;samples:Sample[];sample_count:number;truncated:boolean};workflow?:Workflow;
  replay?:{available:boolean;reason:string};
}
export interface ActivityState {run:RunSnapshot|null;output:string;outputSeq:number;lastSeq:number;replayUnavailable:boolean;partial:boolean}
export interface Packet {data:any;id?:string;type?:string}
export type Connection='connecting'|'connected'|'reconnecting'|'ended'|'unauthorized'|'error'|'replay_reset';
export interface ClientError extends Error {status?:number;code?:string}
export interface WatchOptions {signal?:AbortSignal;onState?:(state:ActivityState)=>void;onConnection?:(status:Connection,error?:ClientError)=>void;followWorkflow?:boolean}
export interface ActivityClient {
  getRun(id:string,signal?:AbortSignal):Promise<RunSnapshot>;
  cancel(id:string,signal?:AbortSignal):Promise<RunSnapshot>;
  readEvents(path:string,options:{signal?:AbortSignal;cursor?:string;onPacket:(packet:Packet)=>void}):Promise<void>;
  watchRun(id:string,options?:WatchOptions):Promise<void>;
  watchFeed(options:{signal?:AbortSignal;onPacket:(packet:Packet)=>void;onConnection?:(status:Connection,error?:ClientError)=>void}):Promise<void>;
}
export function initialActivityState():ActivityState;
export function reduceActivity(state:ActivityState,packet:Packet):ActivityState;
export function readEventStream(response:Response,onPacket:(packet:Packet)=>void,signal?:AbortSignal):Promise<void>;
export function createActivityClient(options?:{baseUrl?:string;runPath?:string;feedPath?:string;fetch?:typeof fetch;headers?:()=>Record<string,string>|Promise<Record<string,string>>}):ActivityClient;
export function outputChart(history:RunSnapshot['history'],unit?:'bytes'|'characters'|'tokens',width?:number,height?:number,extentMs?:number):{paths:string[];points:{x:number;y:number;elapsed_ms:number;value:number;index:number}[];maxX:number;maxY:number;truncated:boolean;width:number;height:number};
