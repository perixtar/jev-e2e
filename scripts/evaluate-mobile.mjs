// Real native matrix, explicitly opt-in. Ordinary CI never invokes this file.
import {parseArgs} from 'node:util';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {runSuite,savedHash} from '../dist/runner.js';
import {loadEnvironment} from '../dist/config.js';
import {startLab} from '../examples/mobile-app/control.mjs';
const {values}=parseArgs({options:{live:{type:'boolean'},platform:{type:'string',default:'both'},'ios-device':{type:'string'},'android-device':{type:'string'},app:{type:'string',default:'dev.jev.e2e.shopping'},rounds:{type:'string',default:'10'},'max-cost':{type:'string',default:'2'},out:{type:'string'}}});
if(!values.live)throw Error('Paid native evaluation requires --live. Use npm test for free contract checks.');
const rounds=Number(values.rounds),cap=Number(values['max-cost']);
if(!Number.isInteger(rounds)||rounds<1||rounds>10||!Number.isFinite(cap)||cap<=0||cap>10)throw Error('rounds 1–10, aggregate max-cost (0,10].');
loadEnvironment();if(!process.env.OPENROUTER_API_KEY)throw Error('Set OPENROUTER_API_KEY.');
const repo=resolve(fileURLToPath(new URL('..',import.meta.url))),execute=promisify(execFile);
const [{stdout:implementationSha},{stdout:dirty}]=await Promise.all([execute('git',['rev-parse','HEAD'],{cwd:repo}),execute('git',['status','--porcelain'],{cwd:repo})]);
if(dirty.trim())throw Error('Commit the implementation before a release-gate evaluation so every trial has an exact package SHA.');
const platforms=values.platform==='both'?['ios','android']:[values.platform];
if(platforms.some(p=>!['ios','android'].includes(p)||!values[`${p}-device`]))throw Error('Pass --ios-device and/or --android-device with exact virtual-device IDs.');
const directory=resolve(values.out??join('.jev-e2e','mobile-evaluation',new Date().toISOString().replaceAll(':','-')));await mkdir(directory,{recursive:true,mode:0o700});
const source=await readFile(new URL('../examples/mobile.cases',import.meta.url),'utf8');
const fixtures={inputs:{email:{value:'demo@example.test'},password:{value:'correct-horse'},invalidPassword:{value:'wrong-horse'}},auth:{}};
const faults=['invalid-login','wrong-filter','wrong-total','ineffective-removal','lost-persistence'];
const lab=await startLab(),trials=[],replays={};let spent=0;
const controller=new AbortController(),stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
let writing=Promise.resolve();
const persist=()=>{const data=JSON.stringify({date:new Date().toISOString(),implementationSha:implementationSha.trim(),cap,spent,trials},null,2);writing=writing.then(()=>writeFile(join(directory,'trials.json'),data,{mode:0o600}));return writing;};
async function matrix(platform){
  for(const mode of ['healthy','broken','replay'])for(let round=1;round<=rounds;round++){
    if(controller.signal.aborted)return;
    // Each platform has a reserved half of the aggregate budget while concurrent.
    const ownSpent=trials.filter(t=>t.platform===platform).reduce((n,t)=>n+t.result.model.cost,0),remaining=cap/platforms.length-ownSpent;
    if(remaining<=0)throw Error('Aggregate evaluation budget reached.');
    const baselines=[],trialDirectory=join(directory,'artifacts',platform,mode,String(round));
    // Keep final screenshot/report collection inside the measured case duration.
    // Preview streaming stays off so this matrix measures the ordinary CLI path.
    const result=await runSuite({platform,app:values.app,device:values[`${platform}-device`],planner:'off',casesText:mode==='replay'?undefined:source,replay:mode==='replay'?replays[platform]:undefined,fixtures,signal:controller.signal,timeoutMs:90000,maxCost:Math.min(.20,remaining),outputDirectory:trialDirectory,beforeCase:async index=>{const config=lab.reset(mode==='broken'?faults[index]:'healthy',platform);baselines.push({index,...config});}});
    const baselineVerified=baselines.length===5&&baselines.every(b=>lab.reads.some(read=>read.platform===platform&&read.id===b.id));
    const correctFaults=mode==='broken'?result.cases.map((test,index)=>test.verdict==='FAIL'&&test.checks.some(check=>!check.passed&&[
      check.assertion.target?.text==='Invalid credentials'&&check.observed===false,
      check.assertion.target?.text==='AirPods'&&check.observed===true,
      check.assertion.target?.text==='cart-total'&&check.observed===77,
      check.assertion.target?.text==='Your cart is empty'&&check.observed===false,
      check.assertion.target?.text==='Desk Lamp'&&check.assertion.afterStep===6&&check.observed===false,
    ][index])):[];
    spent+=result.model.cost;trials.push({implementationSha:implementationSha.trim(),platform,mode,round,baselines,baselineVerified,correctFaults,result});
    if(mode==='healthy'&&result.verdict==='PASS'&&!replays[platform]){const flows=result.cases.map(c=>c.flow);replays[platform]={version:2,plan:result.plan,target:result.target,hash:savedHash(result.plan,result.target,flows),flows};}
    await persist();
    if(controller.signal.aborted)return;
    if(mode==='healthy'&&round===rounds&&!replays[platform])throw Error('No complete healthy native flow available for replay.');
    await persist();console.log(`${platform} ${mode} ${round}/${rounds}: ${result.cases.map(c=>c.verdict).join(' ')} · ${(result.durationMs/1000).toFixed(1)}s · $${result.model.cost.toFixed(6)}`);
  }
}
try{
  const results=await Promise.allSettled(platforms.map(matrix));for(const r of results)if(r.status==='rejected')throw r.reason;
  const summary=platforms.map(platform=>{
    const groups=Object.fromEntries(['healthy','broken','replay'].map(mode=>{
      const runs=trials.filter(t=>t.platform===platform&&t.mode===mode),cases=runs.flatMap(t=>t.result.cases);
      const counts=Object.fromEntries(['PASS','FAIL','BLOCKED'].map(v=>[v,cases.filter(c=>c.verdict===v).length]));
      if(mode==='broken')counts.correctFAIL=runs.flatMap(t=>t.correctFaults).filter(Boolean).length;
      const perFlow=Array.from({length:5},(_,i)=>runs.filter(t=>t.result.cases[i]?.verdict===(mode==='broken'?'FAIL':'PASS')).length);
      const durations=cases.map(c=>c.durationMs).sort((a,b)=>a-b),warmDurations=runs.filter(t=>t.round>1).flatMap(t=>t.result.cases.map(c=>c.durationMs)).sort((a,b)=>a-b);
      const percentile=(values,p)=>values.length?values[Math.min(values.length-1,Math.ceil(values.length*p)-1)]:null;
      return [mode,{...counts,perFlow,medianMs:percentile(durations,.5),p95Ms:percentile(durations,.95),warmMedianMs:percentile(warmDurations,.5),artifactMs:runs.reduce((n,t)=>n+(t.result.timings?.artifact??0),0),modelCost:runs.reduce((n,t)=>n+t.result.model.cost,0),plannerRequests:runs.reduce((n,t)=>n+t.result.model.plannerRequests,0),jevRequests:runs.reduce((n,t)=>n+t.result.model.jevRequests,0)}];
    }));
    const verified=trials.filter(t=>t.platform===platform).every(t=>t.baselineVerified);
    // A stale saved control may use Jev for semantic repair; replay must skip prose planning.
    const passed=verified&&rounds===10&&groups.healthy.PASS>=48&&groups.healthy.perFlow.every(n=>n>=9)&&groups.healthy.warmMedianMs!==null&&groups.healthy.warmMedianMs<=60000&&groups.healthy.artifactMs>0&&groups.broken.PASS===0&&groups.broken.correctFAIL>=48&&groups.replay.PASS>=48&&groups.replay.plannerRequests===0;
    return {platform,passed,groups};
  });await writeFile(join(directory,'summary.json'),JSON.stringify({implementationSha:implementationSha.trim(),summary,spent,canceled:controller.signal.aborted},null,2),{mode:0o600});console.log(JSON.stringify({implementationSha:implementationSha.trim(),summary,spent,directory},null,2));process.exitCode=controller.signal.aborted?130:summary.every(s=>s.passed)?0:1;
}finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);await persist();await lab.close();}
