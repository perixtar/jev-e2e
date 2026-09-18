// Opt-in paid evaluation. Normal npm test never calls a model.
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { startDemo } from '../dist/demo.js';
import { loadEnvironment, readFixtures, secretValues } from '../dist/config.js';
import { runSuite, providerOptions, readSavedPlan } from '../dist/runner.js';
import { compileCases, parseExplicit } from '../dist/plan.js';
import { faults } from '../test/helpers.mjs';

const {values}=parseArgs({options:{rounds:{type:'string'},budget:{type:'string'},interpretation:{type:'boolean'},replay:{type:'boolean'},mode:{type:'string'},out:{type:'string'}}});
const rounds=Number(values.rounds??1),budget=Number(values.budget??0.2);if(!Number.isInteger(rounds)||rounds<1||rounds>10||!(budget>0&&budget<=1))throw Error('Use rounds 1–10 and budget in (0,1].');
loadEnvironment();if(!process.env.OPENROUTER_API_KEY)throw Error('Set OPENROUTER_API_KEY.');
const explicit=parseExplicit(await readFile(new URL('../examples/benchmark.cases',import.meta.url),'utf8'));
const prose=[
  'Sign in using Email @valid.email and Password @valid.password. Verify the authenticated welcome page and URL.',
  'Attempt sign-in with Email @valid.email and Password @invalid.password. This is an invalid password test; it must remain unauthenticated.',
  'Add a new project named "Acme" and check that exactly one project persists after refreshing the page.',
  'Change the project "Demo" to the new name "Acme", then refresh and verify the new name and disappearance of the old name.',
  'Find the project "Demo" and archive it. Check that this particular record now says "Archived".',
  'Show only Archived projects using the status filter. The known Active project must disappear and the known Archived project must remain.',
  'Go to settings, choose "Dark" in the "Theme" control, and refresh. The choice must persist.',
  'Go to settings, turn on "Enable notifications", and refresh. It should still be checked.',
  'Try adding a project with its Project name left empty. Save it and verify the required-field error and that no Untitled record is added.',
  'Type "Demo" in the project search. Wait for asynchronous results and check that Demo appears and Legacy does not.'
];
function freeform(index,variant=0){const c=explicit.cases[index];const prefix=['','Please test this journey: ','A user wants to do the following: '][variant];return `Case: ${c.name}\n${c.auth?'Auth: @'+c.auth+'\n':''}${prefix}${prose[index]}\n${c.source.split('\n').filter(line=>/^Expect:/.test(line)).join('\n')}`;}
function orderedSteps(expected,actual){
  let cursor=0;
  for(const step of expected){
    const index=actual.findIndex((candidate,index)=>index>=cursor&&candidate.action===step.action&&candidate.value===step.value&&candidate.fixture===step.fixture&&(step.target===null||candidate.target?.toLowerCase()===step.target.toLowerCase()));
    if(index<0)return false;
    cursor=index+1;
  }
  return true;
}
const directory=resolve(values.out??join('.jev-e2e','evaluations',new Date().toISOString().replace(/[:.]/g,'-')));await mkdir(directory,{recursive:true,mode:0o700});
const fixturesDirectory=await mkdtemp(join(tmpdir(),'jev-live-fixtures-'));const demo=await startDemo(0);const fixtures=readFixtures(await demo.writeFixtures(fixturesDirectory));
const controller=new AbortController();const stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
const record={schema:1,startedAt:new Date().toISOString(),packageVersion:'0.1.0-alpha.1',rounds,budget,spent:0,interpretation:[],trials:[],summary:null,stoppedReason:null};
const persist=()=>writeFile(join(directory,'evaluation.json'),JSON.stringify(record,null,2),{mode:0o600});
const remaining=()=>budget-record.spent;
const models=new Set();const saved=new Map();
const account=(stats)=>{record.spent+=stats.cost;for(const model of stats.models)models.add(model);};
try{
  if(values.interpretation){for(let index=0;index<30;index++){
    if(remaining()<0.012||controller.signal.aborted){record.stoppedReason='Evaluation budget/cancellation stopped interpretation.';break;}
    const caseIndex=index%10;const provider=providerOptions({maxCost:Math.min(0.025,remaining())});const started=Date.now();let faithful=false,reason='';
    try{const plan=await compileCases(freeform(caseIndex,Math.floor(index/10)),'on',fixtures,provider,controller.signal,secretValues(fixtures));const c=plan.cases[0],expected=explicit.cases[caseIndex];faithful=!c.blockedReason&&JSON.stringify(c.assertions)===JSON.stringify(expected.assertions)&&c.auth===expected.auth&&orderedSteps(expected.steps,c.steps);if(!faithful)reason=c.blockedReason??'Required contract mismatch';record.interpretation.push({index,case:expected.name,faithful,reason,plan,durationMs:Date.now()-started,model:provider.stats});}catch(error){record.interpretation.push({index,case:explicit.cases[caseIndex].name,faithful:false,reason:error.message,durationMs:Date.now()-started,model:provider.stats});}
    account(provider.stats);console.log(`Interpret ${index+1}/30 ${record.interpretation.at(-1).faithful?'faithful':'BLOCKED/mismatch'} · $${record.spent.toFixed(4)}`);await persist();
  }}
  const modes=values.mode?[values.mode]:['off','on'];if(modes.some(m=>!['on','off'].includes(m)))throw Error('Mode must be on/off.');
  for(const mode of modes)for(const condition of ['healthy','broken'])for(let round=0;round<rounds;round++)for(let index=0;index<10;index++){
    if(remaining()<0.012||controller.signal.aborted){record.stoppedReason='Evaluation budget/cancellation stopped discovery.';break;}
    demo.reset(condition==='broken'?faults[index]:'');const c=explicit.cases[index];const artifact=join(directory,`${mode}-${condition}-${round+1}-${index+1}`);const started=Date.now();
    const result=await runSuite({url:demo.url,casesText:mode==='on'?freeform(index):c.source,planner:mode,fixtures,signal:controller.signal,outputDirectory:artifact,maxCost:Math.min(0.025,remaining()),assertionTimeoutMs:1000});account(result.model);
    record.trials.push({mode,condition,round:round+1,index,case:c.name,verdict:result.verdict,reason:result.cases[0]?.reason,wallMs:Date.now()-started,model:result.model,checks:result.cases[0]?.checks,actions:result.cases[0]?.actions.length,artifact});
    if(condition==='healthy'&&result.verdict==='PASS'&&!saved.has(index))saved.set(index,join(artifact,'plan.json'));
    console.log(`${mode} ${condition} ${round+1}/${rounds} ${c.name}: ${result.verdict} · $${record.spent.toFixed(4)}`);await persist();
  }
  if(values.replay)for(let round=0;round<10;round++)for(let index=0;index<10;index++){
    if(controller.signal.aborted||!saved.has(index)){record.stoppedReason='Replay requires a successful saved flow for every case.';break;}
    demo.reset();const plan=await readSavedPlan(saved.get(index));const started=Date.now();const result=await runSuite({url:demo.url,replay:plan,fixtures,signal:controller.signal,outputDirectory:join(directory,`replay-${round+1}-${index+1}`),maxCost:Math.max(0.000001,Math.min(0.025,remaining())),assertionTimeoutMs:1000});account(result.model);record.trials.push({mode:'replay',condition:'healthy',round:round+1,index,case:explicit.cases[index].name,verdict:result.verdict,reason:result.cases[0]?.reason,wallMs:Date.now()-started,model:result.model,checks:result.cases[0]?.checks,actions:result.cases[0]?.actions.length});console.log(`replay ${round+1}/10 ${explicit.cases[index].name}: ${result.verdict}`);await persist();
  }
}finally{
  await demo.close();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
  const groups={};for(const t of record.trials){const key=`${t.mode}-${t.condition}`;const g=groups[key]??={total:0,PASS:0,FAIL:0,BLOCKED:0,times:[],perCase:{},plannerRequests:0,jevRequests:0};g.total++;g[t.verdict]++;g.times.push(t.wallMs);g.plannerRequests+=t.model.plannerRequests;g.jevRequests+=t.model.jevRequests;const per=g.perCase[t.case]??={total:0,PASS:0,FAIL:0,BLOCKED:0};per.total++;per[t.verdict]++;}for(const g of Object.values(groups)){g.times.sort((a,b)=>a-b);g.medianMs=g.times[Math.floor(g.times.length/2)];g.p95Ms=g.times[Math.ceil(g.times.length*.95)-1];delete g.times;}
  record.summary={models:[...models],interpretationFaithful:record.interpretation.filter(t=>t.faithful).length,interpretationTotal:record.interpretation.length,groups};record.finishedAt=new Date().toISOString();await persist();console.log(JSON.stringify(record.summary,null,2));console.log(`Evaluation: ${directory}`);process.exitCode=record.stoppedReason||record.trials.some(t=>t.verdict!==(t.condition==='broken'?'FAIL':'PASS'))||record.interpretation.some(t=>!t.faithful)?1:0;
}
