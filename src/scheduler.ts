import { ApiError } from './errors.js';

interface Waiting {
  start():void;
  reject(error:ApiError):void;
}
/** Single-process FIFO admission. A slot remains reserved until provider cleanup. */
export class Scheduler {
  active = 0;
  private waiting:Waiting[] = [];
  private closed = false;
  constructor(private concurrency:number, private limit:number, private timeout:number) {}
  get queued() { return this.waiting.length; }
  get needsQueue() { return this.active >= this.concurrency || this.queued > 0; }
  assertAvailable() {
    if (this.closed) throw new ApiError(503,'server_shutdown','Server is shutting down.');
    if (this.needsQueue && this.queued >= this.limit) throw new ApiError(429,'server_busy','Concurrency/queue limit reached. Retry later.');
  }
  acquire(signal:AbortSignal):Promise<() => void> {
    this.assertAvailable();
    if (signal.aborted) return Promise.reject(new ApiError(499,'request_cancelled','Request cancelled before admission.'));
    const lease = () => {
      this.active++; let released = false;
      return () => { if (!released) {released=true;this.active--;this.drain();} };
    };
    if (!this.needsQueue) return Promise.resolve(lease());
    return new Promise((resolve,reject) => {
      const cleanup = () => { clearTimeout(timer);signal.removeEventListener('abort',abort);const i=this.waiting.indexOf(waiter);if(i>=0)this.waiting.splice(i,1); };
      const abort = () => {cleanup();reject(new ApiError(499,'request_cancelled','Queued request cancelled.'));};
      const waiter:Waiting = {start:()=>{cleanup();resolve(lease());},reject:error=>{cleanup();reject(error);}};
      const timer=setTimeout(()=>waiter.reject(new ApiError(504,'queue_timeout','Queue wait limit reached.')),this.timeout);
      signal.addEventListener('abort',abort,{once:true});this.waiting.push(waiter);
    });
  }
  private drain() { while (!this.closed && this.active < this.concurrency && this.waiting.length) this.waiting[0]!.start(); }
  close() {this.closed=true;for(const waiter of [...this.waiting])waiter.reject(new ApiError(503,'server_shutdown','Server is shutting down.'));}
}
