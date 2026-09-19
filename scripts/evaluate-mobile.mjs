// Real native matrix, explicitly opt-in. Ordinary CI never invokes this file.
import {parseArgs} from 'node:util';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {runSuite,savedHash} from '../dist/runner.js';
import {loadEnvironment} from '../dist/config.js';
import {startLab} from '../examples/mobile-app/control.mjs';
const {values}=parseArgs({options:{live:{type:'boolean'},platform:{type:'string',default:'both'},'ios-device':{type:'string'},'android-device':{type:'string'},app:{type:'string',default:'dev.jev.e2e.shopping'},rounds:{type:'string',default:'10'},'max-cost':{type:'string',default:'2'},out:{type:'string'}}});
if(!values.live)throw Error('Paid native evaluation requires --live. Use npm test for free contract checks.');
const rounds=Number(values.rounds),cap=Number(values['max-cost']);
if(!Number.isInteger(rounds)||rounds<1||rounds>10||!Number.isFinite(cap)||cap<=0||cap>10)throw Error('rounds 1–10, aggregate max-cost (0,10].');
loadEnvironment();if(!process.env.OPENROUTER_API_KEY)throw Error('Set OPENROUTER_API_KEY.');
const platforms=values.platform==='both'?['ios','android']:[values.platform];
if(platforms.some(p=>!['ios','android'].includes(p)||!values[`${p}-device`]))throw Error('Pass --ios-device and/or --android-device with exact virtual-device IDs.');
const directory=resolve(values.out??join('.jev-e2e','mobile-evaluation',new Date().toISOString().replaceAll(':','-')));await mkdir(directory,{recursive:true,mode:0o700});
const source=await readFile(new URL('../examples/mobile.cases',import.meta.url),'utf8');
const fixtures={inputs:{email:{value:'demo@example.test'},password:{value:'correct-horse'},invalidPassword:{value:'wrong-horse'}},auth:{}};
const faults=['invalid-login','wrong-filter','wrong-total','ineffective-removal','lost-persistence'];
const lab=await startLab(),trials=[],replays={};let spent=0;
const controller=new AbortController(),stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
let writing=Promise.resolve();
const persist=()=>{const data=JSON.stringify({date:new Date().toISOString(),cap,spent,trials},null,2);writing=writing.then(()=>writeFile(join(directory,'trials.json'),data,{mode:0o600}));return writing;};
async function matrix(platform){
  for(const mode of ['healthy','broken','replay'])for(let round=1;round<=rounds;round++){
    if(controller.signal.aborted)return;
    // Each platform has a reserved half of the aggregate budget while concurrent.
    const ownSpent=trials.filter(t=>t.platform===platform).reduce((n,t)=>n+t.result.model.cost,0),remaining=cap/platforms.length-ownSpent;
    if(remaining<=0)throw Error('Aggregate evaluation budget reached.');
    const baselines=[];
    const result=await runSuite({platform,app:values.app,device:values[`${platform}-device`],planner:'off',casesText:mode==='replay'?undefined:source,replay:mode==='replay'?replays[platform]:undefined,fixtures,signal:controller.signal,timeoutMs:90000,maxCost:Math.min(.20,remaining),outputDirectory:false,beforeCase:async index=>{const config=lab.reset(mode==='broken'?faults[index]:'healthy',platform);baselines.push({index,...config});},onProgress:event=>{if(event.type==='result')console.log(platform,mode,event.caseName,event.message);}});
    const baselineVerified=baselines.length===5&&baselines.every(b=>lab.reads.some(read=>read.platform===platform&&read.id===b.id));
    const correctFaults=mode==='broken'?result.cases.map((test,index)=>test.verdict==='FAIL'&&test.checks.some(check=>!check.passed&&[
      check.assertion.target?.text==='Invalid credentials'&&check.observed===false,
      check.assertion.target?.text==='AirPods'&&check.observed===true,
      check.assertion.target?.text==='cart-total'&&check.observed===77,
      check.assertion.target?.text==='Your cart is empty'&&check.observed===false,
      check.assertion.target?.text==='Desk Lamp'&&check.assertion.afterStep===6&&check.observed===false,
    ][index])):[];
    spent+=result.model.cost;trials.push({platform,mode,round,baselines,baselineVerified,correctFaults,result});
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
      const durations=cases.map(c=>c.durationMs).sort((a,b)=>a-b);return [mode,{...counts,perFlow,medianMs:durations[Math.floor(durations.length/2)],modelCost:runs.reduce((n,t)=>n+t.result.model.cost,0),plannerRequests:runs.reduce((n,t)=>n+t.result.model.plannerRequests,0),jevRequests:runs.reduce((n,t)=>n+t.result.model.jevRequests,0)}];
    }));
    const verified=trials.filter(t=>t.platform===platform).every(t=>t.baselineVerified);
    const passed=verified&&rounds===10&&groups.healthy.PASS>=48&&groups.healthy.perFlow.every(n=>n>=9)&&groups.broken.PASS===0&&groups.broken.correctFAIL>=48&&groups.replay.PASS>=48&&groups.replay.plannerRequests===0;
    return {platform,passed,groups};
  });await writeFile(join(directory,'summary.json'),JSON.stringify({summary,spent,directory,canceled:controller.signal.aborted},null,2),{mode:0o600});console.log(JSON.stringify({summary,spent,directory},null,2));process.exitCode=controller.signal.aborted?130:summary.every(s=>s.passed)?0:1;
}finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);await persist();await lab.close();}
