import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {basename} from 'node:path';
import {hostname,platform} from 'node:os';

const exec=promisify(execFile);
export interface ResourcePoint {timestamp:number;host:string;interval_ms:number;gateway:{pid:number;cpu_percent:number|null;rss_bytes:number;scope:string;source:string};processes:{pid:number;provider:string;scope:string;cpu_percent:number|null;rss_bytes:number|null;source:string;method:string;available:boolean}[];gpu:{value:null;reason:string};inference:{value:null;reason:string}}
export class Resources {
  readonly history:ResourcePoint[]=[];
  private tracked=new Map<number,{provider:string;scope:string;identity?:string}>();
  private timer:ReturnType<typeof setInterval>;
  private cpu=process.cpuUsage();private at=performance.now();private pending=false;private closed=false;
  constructor() {this.sampleGateway();this.timer=setInterval(()=>void this.sample(),1000);this.timer.unref();}
  track(pid:number,provider:string,active:boolean,scope='codex_cli_process') {if(!Number.isSafeInteger(pid)||pid<=0||pid===process.pid)return;if(active)this.tracked.set(pid,{provider,scope});else this.tracked.delete(pid);}
  private sampleGateway(publish=true):ResourcePoint {
    const now=performance.now(),cpu=process.cpuUsage(),elapsed=now-this.at;
    const point:ResourcePoint={timestamp:Date.now(),host:hostname(),interval_ms:elapsed,gateway:{pid:process.pid,cpu_percent:elapsed>=100?((cpu.user-this.cpu.user)+(cpu.system-this.cpu.system))/elapsed/10:null,rss_bytes:process.memoryUsage().rss,scope:'gateway_process_not_model_inference',source:'node_process'},processes:[],gpu:{value:null,reason:'No GPU utilization/VRAM sampler available; model allocation is reported separately when supported.'},inference:{value:null,reason:'Cloud inference resources unavailable; local process values require explicit PID and are shared, not per-request.'}};
    this.cpu=cpu;this.at=now;if(publish)this.publish(point);return point;
  }
  private publish(point:ResourcePoint){this.history.push(point);if(this.history.length>300)this.history.shift();}
  async sample() {
    if(this.pending||this.closed)return;this.pending=true;const point=this.sampleGateway(false);
    try {
      if(!['darwin','linux'].includes(platform()))return;
      const tracked:[number,{provider:string;scope:string;identity?:string}][]=[...this.tracked.entries()].slice(0,64);
      if(!tracked.length)return;
      const launchers=new Map(tracked.filter(([,value])=>value.scope==='codex_cli_launcher_process'));
      if(launchers.size){try{
        const {stdout}=await exec('/bin/ps',['-axo','pid=,ppid=,comm='],{timeout:750,maxBuffer:524288,env:{PATH:'/usr/bin:/bin',LC_ALL:'C'}});
        for(const line of stdout.split('\n')){const row=/^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);if(!row)continue;const owner=launchers.get(Number(row[2]));if(owner&&/^codex(?:[-._a-zA-Z0-9]*)?$/.test(basename(row[3]!))&&tracked.length<64)tracked.push([Number(row[1]),{provider:owner.provider,scope:'codex_cli_native_child_process'}]);}
      }catch{/* Native child not observable on this host; launcher stays separately scoped. */}}
      let lines:string[]=[];
      try {const {stdout}=await exec('/bin/ps',['-p',tracked.map(([pid])=>pid).join(','),'-o','pid=,%cpu=,rss=,lstart=,comm='],{timeout:750,maxBuffer:65536,env:{PATH:'/usr/bin:/bin',LC_ALL:'C'}});lines=stdout.split('\n');}catch { /* Missing/unsupported process observations remain unknown. */ }
      const rows=new Map(lines.map(line=>/^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(line)).filter((m):m is RegExpExecArray=>Boolean(m)).map(m=>[Number(m[1]),m]));
      for(const[pid,track]of tracked){
        const row=rows.get(pid),identity=row?.[4],cpu=row?Number(row[2]):null,rss=row?Number(row[3])*1024:null;
        const available=Boolean(row&&identity&&(!track.identity||track.identity===identity)&&Number.isFinite(cpu)&&Number.isFinite(rss));
        if(available)track.identity=identity;else if(track.identity&&identity&&track.identity!==identity)this.tracked.delete(pid);
        point.processes.push({pid,provider:track.provider,scope:track.scope,cpu_percent:available?cpu:null,rss_bytes:available?rss:null,source:available?'os_ps':'unavailable',method:available?'ps_cpu_average_not_interval_or_request_attribution':'process_missing_or_unsupported',available});
      }
    }finally{this.publish(point);this.pending=false;}
  }
  snapshot() {return {sample_interval_ms:1000,retained_samples:this.history.length,latest:this.history.at(-1),scope:'shared_host_processes_not_per_request',gpu_supported:false};}
  close() {this.closed=true;clearInterval(this.timer);}
}
