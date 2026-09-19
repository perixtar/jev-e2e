// Opt-in real SDK checks against the owned Jev Shop fixture; no model calls.
import assert from 'node:assert/strict';
import {parseArgs} from 'node:util';
import {mkdir,writeFile,stat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {MobileDriver} from '../dist/mobile.js';
import {runSuite} from '../dist/runner.js';

const {values}=parseArgs({options:{live:{type:'boolean'},platform:{type:'string'},device:{type:'string'},out:{type:'string'}}});
if(!values.live||!['ios','android'].includes(values.platform)||!values.device)throw Error('Use --live --platform ios|android --device EXACT_ID, after installing/signing into the owned Jev Shop fixture.');
const directory=resolve(values.out??`.jev-e2e/mobile-contract-${values.platform}`);await mkdir(directory,{recursive:true,mode:0o700});
const target={platform:values.platform,device:values.device,app:'dev.jev.e2e.shopping',baseline:'preserve'};
const evidence=[];
const signal=()=>AbortSignal.timeout(60000);
const driver=()=>new MobileDriver({...target},['privacy-canary@example.test']);
const step=(action,target,value=null)=>({action,target,value,fixture:null});
const check=(kind,id,expected)=>({kind,target:{by:'id',text:id,role:null,within:null},expected});
const tap=async(d,name)=>{const s=signal(),o=await d.observe(s),matches=o.controls.filter(c=>c.label===name);assert.equal(matches.length,1);await d.execute(o,matches[0],step('click',name),null,s);};
async function ready(d,login=false){const end=Date.now()+10000;let previous;while(Date.now()<end){const o=await d.observe(signal()),c=o.controls.find(c=>c.identifier==='search-products'||login&&c.identifier==='email');if(c&&previous===c.fingerprint)return o;previous=c?.fingerprint;await delay(150);}throw Error('Fixture controls did not become stable.');}
const catalog=d=>ready(d);
async function gate(name,fn){const start=Date.now();await fn();evidence.push({name,passed:true,durationMs:Date.now()-start});await writeFile(join(directory,'sdk-checks.json'),JSON.stringify({platform:target.platform,device:target.device,evidence},null,2),{mode:0o600});console.log('PASS',name);}

await gate('stale refs reject before dispatch; competing session cannot claim the device',async()=>{
 const d=driver(),other=driver();try{
  await d.open(signal());let o=await ready(d,true);
  if(o.controls.some(c=>c.identifier==='email')){
    for(const [id,text] of [['email','demo@example.test'],['password','correct-horse']]){o=await d.observe(signal());await d.execute(o,o.controls.find(c=>c.identifier===id),step('fill',id,text),text,signal());}await tap(d,'Sign in');o=await catalog(d);
  }
  const c=o.controls.find(c=>c.label==='Cart'),n=o.nodes.get(c.id);await d.observe(signal());
  await assert.rejects(d.connection.call('press',{ref:`@${n.ref}~s${o.native.refsGeneration}`},signal()),/superseded|stale/i);
  await assert.rejects(other.open(signal()),/in use|claim|lock|another session/i);await other.close();
  assert.ok((await d.observe(signal())).controls.some(c=>c.label==='Cart'),'Rejecting the contender must leave the first owner usable.');
 }finally{await other.close();await d.close();}
});
await gate('fill replaces text and preserves Unicode; inputs are omitted from pixels',async()=>{
 const d=driver();try{await d.open(signal());await catalog(d);
  for(const text of ['first value','café ☕']){const o=await d.observe(signal()),c=o.controls.find(c=>c.identifier==='search-products');assert.ok(c);await d.execute(o,c,step('fill','Search products',text),text,signal());assert.equal((await d.check(check('value','search-products',text),signal())).observed,text);}
  assert.equal(await d.screenshot(join(directory,'must-not-exist.png'),signal()),false);
  assert.equal(await stat(join(directory,'must-not-exist.png')).catch(()=>null),null);
 }finally{await d.close();}
});
await gate('switch check is idempotent; uncheck reads the actual state',async()=>{
 const d=driver();try{await d.open(signal());await catalog(d);await tap(d,'Settings');let presses=0;const call=d.connection.call.bind(d.connection);d.connection.call=(command,args,...rest)=>{if(command==='press')presses++;return call(command,args,...rest);};
  for(const action of ['uncheck','check','check','uncheck']){const o=await d.observe(signal()),c=o.controls.find(c=>c.identifier==='notifications');assert.ok(c);const before=presses;await d.execute(o,c,step(action,'Notifications'),null,signal());assert.equal((await d.check(check('checked','notifications',action==='check'),signal())).passed,true);if(c.checked===(action==='check'))assert.equal(presses,before);}
 }finally{await d.close();}
});
await gate('native recording produces a private clip; a later input screen discards it',async()=>{
 const d=driver();try{await d.open(signal());await catalog(d);await tap(d,'Settings');const valid=join(directory,'sdk-uncut.mp4');await d.startRecording(valid,signal());for(const action of ['check','uncheck']){const o=await d.observe(signal()),c=o.controls.find(c=>c.identifier==='notifications');await d.execute(o,c,step(action,'Notifications'),null,signal());await delay(600);}assert.equal(await d.stopRecording(signal()),valid);assert.ok((await stat(valid)).size>1000);assert.ok((d.recordingMetrics?.capturedDurationMs??0)>1000,d.recordingMetrics);
  const discarded=join(directory,'must-be-discarded.mp4');await d.startRecording(discarded,signal());await tap(d,'Sign out');await d.observe(signal());assert.equal(await d.stopRecording(signal()),null);assert.equal(await stat(discarded).catch(()=>null),null);assert.equal(await d.screenshot(join(directory,'credentials.png'),signal()),false);
  for(const [id,text] of [['email','demo@example.test'],['password','correct-horse']]){const o=await d.observe(signal()),c=o.controls.find(c=>c.identifier===id);await d.execute(o,c,step('fill',id,text),text,signal());}await tap(d,'Sign in');
 }finally{await d.close();}
});
await gate('cancel while selecting a control dispatches no action and releases within five seconds',async()=>{
 const controller=new AbortController();let stopped=0;
 const r=await runSuite({...target,planner:'off',outputDirectory:false,signal:controller.signal,casesText:'Case: Stop selecting\nGoal: Stop before a tap\nStep: Tap "Settings"\nExpect: text "Make it yours." is visible',decide:async(_o,_s,signal)=>{setTimeout(()=>{stopped=Date.now();controller.abort();},120);await delay(10000,undefined,{signal});throw Error('Must not resume');}});
 assert.equal(r.canceled,true);assert.equal(r.verdict,'BLOCKED');assert.equal(r.cases[0].actions.length,0);assert.ok(Date.now()-stopped<5000);assert.ok(!r.cases[0].reason.includes('cleanup could not'));
 evidence.push({name:'provider-stop-latency',ms:Date.now()-stopped});
});
await gate('cancel an SDK snapshot releases the session within five seconds',async()=>{
 const d=driver();await d.open(signal());const start=Date.now();try{await assert.rejects(d.connection.call('snapshot',{forceFull:true,timeoutMs:15000},AbortSignal.timeout(10)));}finally{await d.close();}
 assert.ok(Date.now()-start<5000);const reopened=driver();try{await reopened.open(signal());}finally{await reopened.close();}
 evidence.push({name:'snapshot-stop-latency',ms:Date.now()-start});
});
for(const command of ['fill','press'])await gate(`cancel native ${command}/settle dispatches once, with no following step`,async()=>{
 const controller=new AbortController(),original=MobileDriver.prototype.execute;let dispatches=0,stopped=0;
 MobileDriver.prototype.execute=async function(...args){const call=this.connection.call.bind(this.connection);this.connection.call=(kind,input,...rest)=>{
  if(kind===command){dispatches++;setTimeout(()=>{stopped=Date.now();controller.abort();},command==='press'?1000:80);if(kind==='press')input={...input,settleQuietMs:3000,timeoutMs:5000};}
  return call(kind,input,...rest);
 };try{return await original.apply(this,args);}finally{this.connection.call=call;}};
 try{
  const text=command==='fill'?'Step: Fill "Search products" with "abcdefghijklmnopqrstuvwxyz"':'Step: Tap "Settings"';
  const r=await runSuite({...target,planner:'off',outputDirectory:false,signal:controller.signal,casesText:`Case: Stop ${command}\nGoal: Cancel native work\n${text}\nStep: Tap "Cart"\nExpect: text "Your cart." is visible`,decide:async(o,s)=>({target:o.controls.find(c=>s.action==='fill'?c.identifier==='search-products':c.label===s.target)?.id??'none',navigation:'wait'})});
  assert.equal(dispatches,1);assert.equal(r.canceled,true);assert.equal(r.verdict,'BLOCKED');assert.equal(r.cases[0].actions.length,1);assert.ok(Date.now()-stopped<5000);assert.ok(!r.cases[0].reason.includes('cleanup could not'));
  evidence.push({name:`${command}-stop-latency`,ms:Date.now()-stopped});
 }finally{MobileDriver.prototype.execute=original;}
 const reopened=driver();try{await reopened.open(signal());}finally{await reopened.close();}
});
console.log('All real SDK gates passed.',directory);
