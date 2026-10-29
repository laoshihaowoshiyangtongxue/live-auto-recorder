// One budget for remuxing, repair, validation and caption encoding. Capture
// processes never enter this queue. Paused processes surrender their lease.
class MediaPool {
  constructor(limit=()=>1){this.limit=limit;this.active=new Set();this.queue=[];this.timer=setInterval(()=>this.drain(),2000);this.timer.unref?.();}
  acquire(ready=()=>true,priority=false,order=()=>0){return new Promise(resolve=>{const request={ready,resolve,priority,order};priority?this.queue.unshift(request):this.queue.push(request);this.drain();});}
  drain(){
    const max=Math.max(1,Math.min(4,Number(this.limit())||1));
    this.queue.sort((a,b)=>Number(b.priority)-Number(a.priority)||(a.order?.()||0)-(b.order?.()||0));
    while(this.active.size<max){const i=this.queue.findIndex(r=>r.ready());if(i<0)break;
      const request=this.queue.splice(i,1)[0],lease={release:()=>{if(this.active.delete(lease))this.drain();}};
      this.active.add(lease);request.resolve(lease);
    }
  }
  close(){clearInterval(this.timer);}
}
module.exports={MediaPool};
