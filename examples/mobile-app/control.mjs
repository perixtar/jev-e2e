// Evaluator-only baseline/fault service. The test agent never calls this API.
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
export async function startLab(port=8089){
  const configs={ios:{id:randomUUID(),fault:'healthy'},android:{id:randomUUID(),fault:'healthy'}};
  const reads=[];
  const server=createServer((req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');
    if(url.pathname!=='/config'||req.method!=='GET'){res.writeHead(404).end();return;}
    const platform=url.searchParams.get('platform')==='android'?'android':'ios';
    reads.push({platform,id:configs[platform].id});
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(configs[platform]));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return {reads,reset(fault='healthy',platform){for(const key of platform?[platform]:['ios','android'])configs[key]={id:randomUUID(),fault};return platform?configs[platform]:configs;},close:()=>new Promise(resolve=>server.close(resolve))};
}
if(process.argv[1]?.endsWith('/control.mjs')){
  const lab=await startLab();console.log('Jev Shop baseline service: http://127.0.0.1:8089/config');
  process.once('SIGINT',()=>lab.close());process.once('SIGTERM',()=>lab.close());
}
