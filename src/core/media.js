// FFmpeg packet fingerprints: compare an entire suffix/prefix, never just one frame.
function createPacketHashParser({edgesOnly=true,windowSec=30,maxEdgePackets=20000}={}) {
  let scale=null,buffer='',start=Infinity,end=-Infinity,count=0,tailStart=0,headTruncated=false,tailDropped=-Infinity;
  const packets=[],head=[],tail=[];
  function line(text){
    text=text.replace(/\r$/,'');
    const tb=text.match(/^#tb 0:\s*(\d+)\/(\d+)/);
    if(tb&&scale===null){if(+tb[2]===0)throw Error('视频时间基无效');scale=+tb[1]/+tb[2];return;}
    if(!text||text.startsWith('#'))return;
    const p=text.split(',').map(v=>v.trim());
    if(p.length<6||p[0]!=='0'||![p[1],p[2],p[3]].every(v=>Number.isFinite(+v)))return;
    if(scale===null)throw Error('无法读取视频时间基');
    const packet={dts:+p[1]*scale,pts:+p[2]*scale,duration:Math.max(0,+p[3]*scale),hash:p[5]};
    count++;if(count<=100)start=Math.min(start,packet.dts);
    if(!edgesOnly)packets.push(packet);
    else{
      if(packet.dts-start<=windowSec){if(head.length<maxEdgePackets)head.push(packet);else headTruncated=true;}
      tail.push(packet);
      while(tailStart<tail.length-1&&packet.dts-tail[tailStart].dts>windowSec)tailStart++;
      if(tail.length-tailStart>maxEdgePackets)tailDropped=tail[tailStart++].dts;
      if(tailStart>4096){tail.splice(0,tailStart);tailStart=0;}
    }
    end=Math.max(end,packet.pts+packet.duration);
  }
  return {
    write(chunk){buffer+=String(chunk);let at;while((at=buffer.indexOf('\n'))>=0){line(buffer.slice(0,at));buffer=buffer.slice(at+1);}if(buffer.length>131072)throw Error('视频检测输出行过长');},
    finish(){
      if(buffer){line(buffer);buffer='';}if(scale===null)throw Error('无法读取视频时间基');if(!count)throw Error('视频没有有效数据包');
      if(!edgesOnly)return {packets,start,duration:Math.max(start,end)-start,packetCount:count};
      const tailPackets=tail.slice(tailStart),seen=new Set(head),retained=[...head,...tailPackets.filter(p=>!seen.has(p))];
      return {packets:retained,headPackets:head,tailPackets,packetCount:count,start,duration:Math.max(start,end)-start,headTruncated,tailTruncated:tailPackets.at(-1).dts-tailDropped<=windowSec};
    },
  };
}
function parsePacketHashes(text){const parser=createPacketHashParser();parser.write(text);return parser.finish();}

function overlapCut(previous, next) {
  const a = previous.tailPackets || previous.packets, b = next.headPackets || next.packets;
  if(previous.tailTruncated||next.headTruncated||!a.length||!b.length)return null;
  // Static scenes and looping GOPs can have identical encoded packets. An
  // ambiguous fingerprint is not sufficient evidence to discard any footage.
  const candidates = a.filter((p) => a.at(-1).dts - p.dts <= 30 && p.hash === b[0].hash);
  if (candidates.length !== 1) return null;
  for (let i = a.length - 6; i >= 0; i--) {
    if (a.at(-1).dts - a[i].dts > 30) break;
    const count = a.length - i;
    if (count > b.length || a[i].hash !== b[0].hash) continue;
    let matches = true;
    for (let k = 1; k < count; k++) if (a[i + k].hash !== b[k].hash) { matches = false; break; }
    if (matches) return Math.max(previous.start, a[i].dts);
  }
  return null;
}

function hasMediaErrors(stderr) {
  return /invalid|corrupt|error|failed|missing picture|non.monoton|damaged|truncat/i.test(String(stderr));
}

module.exports = { parsePacketHashes, createPacketHashParser, overlapCut, hasMediaErrors };
