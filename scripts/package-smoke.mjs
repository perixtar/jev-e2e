// Run from a clean directory after npm install /path/to/jev-e2e.tgz.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
const root=new URL('./',import.meta.resolve('jev-e2e'));
const {startDemo}=await import(new URL('demo.js',root));
const demo=await startDemo(0);const fixtures=await demo.writeFixtures('.fixtures');
const replay=resolve(process.argv[2]);const cases=await readFile(new URL('../examples/simple.cases',root),'utf8');await writeFile('cases.txt',cases);
const cli=fileURLToPath(new URL('cli.js',root));const environment={...process.env,OPENROUTER_API_KEY:'',OPENAI_API_KEY:'',TYPESAFE_API_KEY:''};
const run=(args,onOutput,extraEnvironment={})=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[cli,...args],{env:{...environment,...extraEnvironment}});let out='',err='';
  const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('CLI smoke deadline exceeded'));},20000);
  child.stdout.on('data',chunk=>{out+=chunk;onOutput?.(child,out+err);});child.stderr.on('data',chunk=>{err+=chunk;onOutput?.(child,out+err);});
  child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal,out,err});});
});
try{
  assert.ok(execFileSync('npx',['--no-install','jev-e2e','--help'],{env:environment,encoding:'utf8'}).includes('natural-language web tests'));
  const plan=await run(['plan','--cases','cases.txt','--planner','off','--out','plan.json']);assert.equal(plan.code,0,plan.err);
  const flags=['run','--url',demo.url,'--replay',replay,'--fixtures',fixtures,'--json','--out','reports'];
  const healthy=await run(flags);assert.equal(healthy.code,0,healthy.err+healthy.out);assert.equal(JSON.parse(healthy.out).verdict,'PASS');assert.equal(JSON.parse(healthy.out).model.requests,0);
  demo.reset('create');const broken=await run(flags);assert.equal(broken.code,1,broken.err+broken.out);assert.equal(JSON.parse(broken.out).verdict,'FAIL');
  demo.reset();const blocked=await run(['run','--url',demo.url,'--cases','cases.txt','--fixtures',fixtures,'--planner','off','--json']);assert.equal(blocked.code,2,blocked.err);assert.equal(JSON.parse(blocked.out).verdict,'BLOCKED');
  await writeFile('cancel.cases','Case: Cancel\nAuth: @signed-in\nGoal: Cancel\nStep: Wait for text "Never appears"\nStep: Click "New project"\nExpect: text "Done" is visible');let sent=false;
  const canceled=await run(['run','--url',demo.url,'--cases','cancel.cases','--fixtures',fixtures,'--planner','off'],(child,text)=>{if(!sent&&text.includes('wait Never appears')){sent=true;child.kill('SIGINT');}});assert.equal(canceled.code,130,canceled.err);
  await writeFile('fake-abort-fetch.mjs',`globalThis.fetch=async(_url,options)=>{if(!options?.body)return Response.json({data:{endpoints:[{pricing:{prompt:'0',completion:'0'}}]}});return new Promise((_resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Fake request deadline.')),10000);const abort=()=>{clearTimeout(timer);reject(options.signal.reason);};if(options.signal.aborted)abort();else options.signal.addEventListener('abort',abort,{once:true});process.stderr.write('Planner request waiting\\n');});};`);
  let planStopSent=false;const canceledPlan=await run(['plan','--cases','cases.txt','--planner','on','--fixtures',fixtures,'--out','canceled-plan.json'],(child,text)=>{if(!planStopSent&&text.includes('Planner request waiting')){planStopSent=true;child.kill('SIGINT');}},{OPENROUTER_API_KEY:'fake-test-key',NODE_OPTIONS:'--import='+resolve('fake-abort-fetch.mjs')});assert.equal(canceledPlan.code,130,canceledPlan.err);
  const child=spawn(process.execPath,[cli,'ui','--port','0'],{env:environment});let uiUrl;
  try{
    uiUrl=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('UI startup timed out')),5000);child.once('error',reject);child.stdout.on('data',chunk=>{const match=String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});});
    assert.equal((await fetch(uiUrl)).status,200);const session=await fetch(uiUrl+'/api/session').then(r=>r.json());assert.equal(session.configured,false);
    const review=await fetch(uiUrl+'/api/plan',{method:'POST',headers:{'Content-Type':'application/json','X-Jev-Token':session.token},body:JSON.stringify({casesText:cases,fixtures,planner:'off',url:demo.url})});assert.equal(review.status,202);
    const job=await review.json();let result;for(let i=0;i<50;i++){result=await fetch(`${uiUrl}/api/jobs/${job.id}/result`).then(r=>r.json());if(result.done)break;await new Promise(resolve=>setTimeout(resolve,50));}assert.ok(result.done);assert.equal(result.plan.cases[0].blockedReason,null);
  }finally{child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}
  console.log(JSON.stringify({platform:process.platform,node:process.version,installedCli:'PASS',healthyExit:healthy.code,brokenExit:broken.code,blockedExit:blocked.code,canceledExit:canceled.code,canceledPlanExit:canceledPlan.code,ui:'PASS',zeroModelReplay:true}));
}finally{await demo.close();}
