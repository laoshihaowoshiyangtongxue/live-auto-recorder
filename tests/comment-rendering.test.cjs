const {test}=require('node:test'),assert=require('node:assert/strict');
const {genAss}=require('../src/core/postprocess');
test('subtitle output contains message bodies, excludes system notifications and legacy list snapshots',()=>{
 const ass=genAss([{vt:0,text:'甲：几点：10:30'},{vt:1,text:'甲：为主播点赞了'},
  {vt:2,text:'又*****：甲*****：好听 乙*****：谢谢'},
  {vt:3,text:'名字：旧内容',body:'结构化正文：保留冒号'}]);
 assert.match(ass,/几点：10:30/);assert.match(ass,/结构化正文：保留冒号/);
 assert.doesNotMatch(ass,/为主播点赞了|甲[：:]|又\*|甲\*|乙\*|名字[：:]|旧内容/);
 assert.equal(ass.split('\n').filter(x=>x.startsWith('Dialogue:')).length,2);
});
