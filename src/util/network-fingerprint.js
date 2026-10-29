const os=require('node:os'),crypto=require('node:crypto');
function networkFingerprint(interfaces=os.networkInterfaces()){
  const entries=[];
  for(const [name,items] of Object.entries(interfaces||{}))for(const item of items||[])if(!item.internal)entries.push([name,item.family,item.address].join('|'));
  entries.sort();return {count:entries.length,hash:crypto.createHash('sha256').update(entries.join('\n')).digest('hex').slice(0,12)};
}
module.exports={networkFingerprint};
