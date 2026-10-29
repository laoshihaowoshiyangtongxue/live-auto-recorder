// Conservative tail recovery: never skip corruption followed by valid video.
const fs = require('node:fs');
function inspectFlvTail(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const read = (at, length) => { const b=Buffer.alloc(length); const n=fs.readSync(fd,b,0,length,at);return b.subarray(0,n); };
    const head=read(0,9);
    if(head.length<9 || head.toString('ascii',0,3)!=='FLV') return {recoverable:false,reason:'not-flv'};
    let at=head.readUInt32BE(5)+4, lengthSize=4, lastVideo=null, bad=null, tags=0;
    const fail=(reason,timestamp)=>{if(!bad)bad={cut:at,reason,timestamp};};
    while(at<size){
      const h=read(at,11);
      if(h.length<11){fail('incomplete-tag-header',lastVideo);break;}
      const type=h[0]&31, n=h.readUIntBE(1,3), timestamp=h.readUIntBE(4,3)+h[7]*16777216;
      if(![8,9,18].includes(type)||h.readUIntBE(8,3)!==0) return {recoverable:false,reason:'invalid-tag-header',offset:at};
      if(at+11+n+4>size){fail('incomplete-tag',timestamp);break;}
      const previous=read(at+11+n,4);
      if(previous.readUInt32BE(0)!==11+n){fail('invalid-tag-size',timestamp);if(at+15+n<size)return {recoverable:false,reason:'interior-tag-corruption',offset:at};break;}
      if(type===9&&n>=5){
        const info=read(at+11,Math.min(n,10));
        if((info[0]&15)!==7) return {recoverable:false,reason:'unsupported-video-codec'};
        if(info[1]===0&&n>=10)lengthSize=(info[9]&3)+1;
        if(info[1]===1){
          let offset=5,valid=true;
          while(offset<n){
            if(offset+lengthSize>n){valid=false;break;}
            const length=read(at+11+offset,lengthSize).readUIntBE(0,lengthSize);
            offset+=lengthSize;
            if(length>n-offset){valid=false;break;}
            offset+=length;
          }
          if(!valid)fail('incomplete-avc-packet',timestamp);
          else if(bad)return {recoverable:false,reason:'video-after-corruption',offset:bad.cut};
          else lastVideo=timestamp;
        }
      }
      at+=15+n;tags++;
    }
    if(!bad)return {recoverable:false,reason:'no-tail-damage',size,tags};
    const droppedBytes=size-bad.cut, lostMs=bad.timestamp===null||lastVideo===null?null:bad.timestamp-lastVideo;
    if(lastVideo===null||droppedBytes>1048576||lostMs===null||lostMs<0||lostMs>1000)return {recoverable:false,reason:'tail-outside-safe-limit',...bad,size,droppedBytes,lostMs};
    return {recoverable:true,...bad,size,droppedBytes,lostMs,tags};
  } finally {fs.closeSync(fd);}
}
module.exports={inspectFlvTail};
