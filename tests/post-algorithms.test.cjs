const test=require('node:test'),assert=require('node:assert/strict');
const {createTimelineMapper,partitionComments,textWidth,genAss}=require('../src/core/postprocess');
test('one-pass comment partition preserves selection, ordering, and exact boundary behavior',()=>{
 let seed=42;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
 for(let trial=0;trial<50;trial++){
  const count=2+Math.floor(random()*80),starts=[0];let at=100;
  for(let i=1;i<=count;i++){at+=Math.floor(random()*20);starts.push(at);}
  const entries=Array.from({length:300},(_,i)=>({t:i<count?starts[i+1]:Math.floor(random()*(at+100)),text:String(i)}));
  const buckets=partitionComments(entries,starts,100,count);
  for(let i=1;i<=count;i++){const from=starts[i]||100,to=i<count?(starts[i+1]||Infinity):Infinity;assert.deepEqual(buckets[i-1],entries.filter(e=>e.t>=from&&e.t<to));}
 }
 assert.equal(partitionComments([{t:1}],[0,100,0,300],100,3),null);
 assert.equal(partitionComments([{t:1}],[0,100,300,200],100,3),null);
});
function original(t,partT0,durs,starts,offsets){
 if(!(durs&&starts&&durs.length>1))return (t-partT0)/1000;
 let seg=starts.length-1;for(let i=0;i<starts.length;i++)if(t<starts[i]){seg=i-1;break;}if(seg<0)seg=0;
 let before=0;for(let i=0;i<seg;i++)before+=durs[i]||0;
 const offset=(offsets&&offsets[seg])||0,within=Math.min((t-starts[seg])/1000+offset,durs[seg]||Infinity);
 return before+Math.max(0,within);
}
test('optimized timeline matches the previous algorithm at boundaries and on unusual records',()=>{
 const cases=[
  {d:[3.333,2.2,7.3],s:[1000,5000,9000],o:[0,0.4,1.1]},
  {d:[0,4,1],s:[1000,1000,2000],o:[0,-1,0]},
  {d:[3,4,5],s:[1000,3000,2000],o:[0,1,0]},
  {d:[3,undefined,7],s:[1000,undefined,5000],o:[]},
  {d:[3,4,5],s:[1000,,5000],o:[0,0,0]},
  {d:[3,4],s:[],o:[]},{d:null,s:null,o:null},
 ];
 for(const {d,s,o} of cases){const map=createTimelineMapper(1000,d,s,o);for(const t of [0,999,1000,1001,1999,2000,3000,4999,5000,9000,20000])assert.deepEqual(map(t),original(t,1000,d,s,o));}
});
test('randomized merged timelines and final ASS remain byte-for-byte identical',()=>{
 let seed=713;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
 for(let iteration=0;iteration<80;iteration++){
  const n=2+Math.floor(random()*100),starts=[],durs=[],offsets=[];let t=1000;
  for(let i=0;i<n;i++){t+=Math.floor(random()*5000);starts.push(t);durs.push(Math.floor(random()*100000)/1000);offsets.push(Math.floor(random()*500)/1000);}
  const values=Array.from({length:300},(_,i)=>i<n?starts[i]:Math.floor(random()*(t+5000)));const map=createTimelineMapper(1000,durs,starts,offsets);
  const fast=values.map((v,i)=>({vt:map(v),text:`测试${i}`})),reference=values.map((v,i)=>({vt:original(v,1000,durs,starts,offsets),text:`测试${i}`}));
  assert.deepEqual(fast,reference);assert.equal(genAss(fast),genAss(reference));
 }
});
test('character-width calculation matches the original for every Unicode code point',()=>{
 for(let cp=0;cp<=0x10ffff;cp++){const ch=String.fromCodePoint(cp),expected=/[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch)?57:57*0.56;assert.equal(textWidth(ch,57),expected,`U+${cp.toString(16)}`);}
 const s='中文，ASCII 😀 \ud800 文本';let expected=0;for(const ch of s)expected+=/[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch)?57:57*0.56;assert.equal(textWidth(s,57),expected);
});
