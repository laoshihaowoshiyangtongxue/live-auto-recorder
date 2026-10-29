const {parentPort,workerData}=require('node:worker_threads');
const {inspectFlvTail}=require('./flv-tail');
try{parentPort.postMessage({result:inspectFlvTail(workerData.file)});}
catch(e){parentPort.postMessage({error:e.message});}
