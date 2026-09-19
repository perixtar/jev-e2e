import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseNative,compileNative,authoredNativeSteps} from '../dist/mobile-plan.js';
import {provider} from './helpers.mjs';
import {MobileDriver,nativeCheck,normalizeNative,nativeVersions} from '../dist/mobile.js';
import {selectDevice,nativeToolEnvironment} from '../dist/device.js';
import {runSuite,readSavedPlan,savedHash} from '../dist/runner.js';
import {writeReport} from '../dist/report.js';
import {validateSuite,BlockedError} from '../dist/types.js';
import {androidCheckedEvidence,androidFocusedEvidence} from '../dist/android-state.js';

const app='dev.example.app';
const frame={x:0,y:0,width:400,height:800};
const node=(index,type,label,extra={})=>({index,type,label,rect:frame,enabled:true,ref:`e${index+1}`,...extra});
const snapshot=nodes=>({nodes,appBundleId:app,identifiers:{appBundleId:app},truncated:false,visibility:{partial:false,visibleNodeCount:nodes.length,totalNodeCount:nodes.length,reasons:[]},snapshotQuality:{state:'healthy'},refsGeneration:7});
const assertion=(kind,text,expected,by='text')=>({kind,target:{by,text,role:null,within:null},expected});

test('native cases preserve every action, fixture and intermediate milestone; web v1 stays distinct',async()=>{
  const source=await readFile(new URL('../examples/mobile.cases',import.meta.url),'utf8');
  const plan=parseNative(source,'ios');assert.equal(plan.version,2);assert.equal(plan.cases.length,5);assert.ok(plan.cases.every(c=>!c.blockedReason));
  const persistence=plan.cases[4];assert.deepEqual(persistence.steps.map(s=>s.action),['fill','fill','click','click','click','relaunch','click']);assert.deepEqual(persistence.assertions.map(a=>a.afterStep),[4,6,6]);
  assert.equal(persistence.steps[0].fixture,'email');assert.equal(persistence.steps[1].fixture,'password');
  const noModel={stats:{plannerRequests:0},fetchImpl:()=>{throw Error('No model call allowed');}};
  assert.deepEqual(await compileNative(source,'ios','off',{inputs:{},auth:{}},noModel,new AbortController().signal,[]),plan);
  assert.throws(()=>validateSuite({...plan,version:1,platform:undefined}),BlockedError);
  for(const step of ['Reload','Select "Theme" with "Dark"','Swipe forever','Fill "Password" with "literal"']){
    const bad=parseNative(`Case: Unsupported\nGoal: Check\nStep: ${step}\nExpect: text "Done" is visible`,'ios');assert.ok(bad.cases[0].blockedReason);assert.equal(bad.cases[0].steps.length,0);
  }
  for(const action of ['Tap "Purchase"','Tap "Send message"','Tap "Buy now"','Tap "Place order"','Tap "Transfer funds"','Tap "Send"'])await assert.rejects(compileNative(`Case: Unsupported\nGoal: Do it\nStep: ${action}\nExpect: text "Done" is visible`,'ios','off',{inputs:{},auth:{}},noModel,new AbortController().signal,[]),/unsupported capability/);
  for(const source of ['Goal: Fill "OTP" with "123456", then tap "Verify".','Goal: Enter "123456" into "Verification code", then tap "Verify".','Goal: Fill "Credit card" using "4111111111111111", then tap "Continue".'])await assert.rejects(compileNative(`Case: Private literal\n${source}\nExpect: text "Done" is visible`,'ios','on',{inputs:{},auth:{}},noModel,new AbortController().signal,[]),/fixture references for private inputs/);
  let requests=0;const remote=provider({fetchImpl:async()=>{requests++;throw Error('Private source reached provider');}});for(const goal of ['Sign in with "alice@example.com" and "correct-horse", then tap "Sign in".','The OTP is 123456, then tap "Verify".','Log in with alice and correct-horse.','Enter 123456 into verification code, then tap "Verify".','Type 123456 into "OTP", then tap "Verify".','Use correct-horse as the password, then tap "Sign in".'])await assert.rejects(compileNative(`Case: Private prose\nGoal: ${goal}\nExpect: text "Welcome" is visible`,'ios','on',{inputs:{},auth:{}},remote,new AbortController().signal,[]),/fixture references for private inputs/);assert.equal(requests,0);
});
test('native metadata subprocesses receive only toolchain variables and obey cancellation',async()=>{
 const env=nativeToolEnvironment({PATH:'/bin',HOME:'/home/test',ANDROID_HOME:'/sdk',OPENROUTER_API_KEY:'secret',E2E_TEST_EMAIL:'private@example.test',CUSTOM_LOGIN_ID:'arbitrary-fixture-secret',PASSWORD:'private'});
 assert.deepEqual(env,{PATH:'/bin',HOME:'/home/test',ANDROID_HOME:'/sdk'});assert.ok(!JSON.stringify(env).includes('secret'));assert.ok(!JSON.stringify(env).includes('private'));
 await assert.rejects(nativeVersions({platform:'ios',app,device:'sim',baseline:'preserve'},AbortSignal.abort()),error=>error?.name==='AbortError');
});
test('native verification distinguishes an actual mismatch from incomplete or ambiguous evidence',()=>{
  const state=snapshot([node(0,'Application','Example'),node(1,'StaticText','Desk Lamp',{parentIndex:0}),node(2,'StaticText','Desk Lamp',{parentIndex:1}),node(3,'StaticText','Total',{value:'72.00',identifier:'total',parentIndex:0})]);
  assert.equal(nativeCheck(state,assertion('count','Desk Lamp',1)).passed,true);
  assert.equal(nativeCheck(state,assertion('number','Total',72,'label')).passed,true);
  assert.equal(nativeCheck(state,assertion('number','Total',36,'label')).passed,false);
  for(const incomplete of [{...state,truncated:true},{...state,visibility:{...state.visibility,partial:true}},{...state,nodes:[...state.nodes,node(4,'ScrollView','List',{hiddenContentBelow:true})]}]) assert.throws(()=>nativeCheck(incomplete,assertion('absent','AirPods',false)),BlockedError);
  assert.throws(()=>nativeCheck({...state,nodes:[...state.nodes,node(4,'StaticText','Total',{value:'36.00'})]},assertion('number','Total',72,'label')),BlockedError);
  assert.throws(()=>nativeCheck({...state,nodes:[node(0,'StaticText','Total',{value:'72.00 USD nonsense'})]},assertion('number','Total',72,'label')),BlockedError);
  assert.throws(()=>nativeCheck(state,{...assertion('absent','AirPods',false),target:{...assertion('absent','AirPods',false).target,within:'Missing region'}}),BlockedError);
  assert.equal(nativeCheck(snapshot([node(0,'Switch','Notifications',{value:'1',selected:false})]),assertion('checked','Notifications',true,'label')).passed,true);
  assert.throws(()=>nativeCheck(snapshot([node(0,'android.widget.Switch','Notifications',{selected:false})]),assertion('checked','Notifications',false,'label')),BlockedError);
  assert.equal(nativeCheck(snapshot([node(0,'StaticText','Email',{value:'Email'})]),assertion('visible','Email',true,'label')).passed,false);
  assert.equal(nativeCheck(snapshot([node(0,'android.widget.EditText','Search',{value:'Search',hintShowing:true})]),assertion('value','Search','','label')).passed,true);
});
test('native switch actions cannot succeed when the state does not change',async()=>{
 const state=snapshot([node(0,'Application','Example'),node(1,'Switch','Notifications',{identifier:'notifications',checked:false,parentIndex:0})]),d=new MobileDriver({platform:'ios',app,device:'sim',baseline:'preserve'},[]);d.ready=true;let presses=0;
 d.connection.call=async command=>{if(command==='snapshot')return state;if(command==='press'){presses++;return{verification:'confirmed'};}throw Error(command);};
 const observation=normalizeNative(state,app,[]),control=observation.controls.find(item=>item.role==='checkbox');await assert.rejects(d.execute(observation,control,{action:'check',target:'Notifications',value:null,fixture:null},null,AbortSignal.timeout(5000)),/not confirmed/);assert.equal(presses,1);
});
test('unsafe model-selected navigation is blocked before native dispatch',async()=>{
 const state=snapshot([node(0,'Application','Example'),node(1,'Button','Buy now',{identifier:'buy-now',parentIndex:0})]),observation=normalizeNative(state,app,[]),unsafe=observation.controls[0];
 const plan={version:2,platform:'android',cases:[{name:'Safe target',source:'Case: Safe target',goal:'Open details',auth:null,steps:[{action:'click',target:'Details',value:null,fixture:null}],assertions:[{...assertion('visible','Done',true),afterStep:0}],blockedReason:null}]};
 const original={open:MobileDriver.prototype.open,observe:MobileDriver.prototype.observe,execute:MobileDriver.prototype.execute,close:MobileDriver.prototype.close};let dispatches=0;
 try{MobileDriver.prototype.open=async function(){this.ready=true;};MobileDriver.prototype.observe=async()=>observation;MobileDriver.prototype.execute=async()=>{dispatches++;};MobileDriver.prototype.close=async()=>{};
  const result=await runSuite({platform:'android',app,device:'not-a-real-device',plan,outputDirectory:false,timeoutMs:10000,decide:async()=>({target:'none',navigation:unsafe.id})});assert.equal(result.verdict,'BLOCKED');assert.equal(result.cases[0].actions.length,0);assert.equal(dispatches,0);
 }finally{Object.assign(MobileDriver.prototype,original);}
});
test('Android checked evidence must match one app, identifier, class and exact bounds',()=>{
 const state=snapshot([node(0,'android.widget.Switch','Notifications',{identifier:'notifications',selected:false})]);
 const entry='<node package="dev.example.app" resource-id="notifications" class="android.widget.Switch" bounds="[0,0][400,800]" checkable="true" checked="true" />';
 const xml=`<hierarchy>${entry}</hierarchy>`;
 assert.equal(nativeCheck(androidCheckedEvidence(state,xml,app),assertion('checked','Notifications',true,'label')).passed,true);
 for(const bad of [xml.replace('dev.example.app','dev.other'),xml.replace('[400,800]','[401,800]'),xml.replace('checkable="true"','checkable="false"'),xml.replace('checked="true"','checked="unknown"'),`<hierarchy>${entry}${entry}</hierarchy>`,xml.slice(0,-10)]) assert.throws(()=>nativeCheck(androidCheckedEvidence(state,bad,app),assertion('checked','Notifications',false,'label')),BlockedError);
});
test('native normalization omits field values and masks known secrets without inventing action capabilities',()=>{
  const secret='unique-private-fixture-123';
  const state=snapshot([node(0,'Application','Example'),node(1,'TextField','Email',{value:secret,identifier:secret,parentIndex:0}),node(2,'SecureTextField','Password',{value:secret,parentIndex:0}),node(3,'Button',`Account ${secret}`,{parentIndex:0}),node(4,'StaticText','Not a button',{parentIndex:0})]);
  const normalized=normalizeNative(state,app,[secret]);assert.equal(normalized.controls.length,3);assert.ok(!normalized.text.includes(secret));assert.ok(!JSON.stringify(normalized.controls.map(({fingerprint,...c})=>c)).includes(secret));assert.deepEqual(normalized.controls[0].capabilities,['fill']);
  assert.throws(()=>normalizeNative({...state,appBundleId:'dev.other.app'},app,[secret]),BlockedError);
});
test('Android typing requires one focused input from the same app and exact geometry',()=>{
 const input=node(0,'android.widget.EditText','Search',{identifier:'search'});
 const entry='<node package="dev.example.app" resource-id="search" class="android.widget.EditText" bounds="[0,0][400,800]" focused="true" />';
 const xml=`<hierarchy>${entry}</hierarchy>`;
 assert.equal(androidFocusedEvidence(input,xml,app),true);
 for(const bad of [xml.replace('dev.example.app','dev.other'),xml.replace('[400,800]','[401,800]'),xml.replace('focused="true"','focused="false"'),`<hierarchy>${entry}${entry}</hierarchy>`,xml.slice(0,-10)])assert.equal(androidFocusedEvidence(input,bad,app),false);
});
test('native device selection never silently chooses duplicate names or a physical phone',()=>{
  const device=(id,name,extra={})=>({id,name,platform:'ios',kind:'simulator',target:'mobile',booted:true,identifiers:{},...extra});
  const devices=[device('a','iPhone'),device('b','iPhone'),device('c','Real',{kind:'device'})];
  assert.throws(()=>selectDevice(devices,'ios','iPhone'),BlockedError);assert.throws(()=>selectDevice(devices,'ios'),BlockedError);assert.throws(()=>selectDevice(devices,'ios','c'),BlockedError);assert.equal(selectDevice(devices,'ios','b').id,'b');assert.throws(()=>selectDevice([device('a','iPhone',{claimedBy:{session:'other'}})],'ios','a'),BlockedError);
});
test('prose compiler rejects reordered actions, exchanged input bindings and early checks',async()=>{
 const source='Case: Login\nGoal: Fill "Email" using @email, fill "Password" using @password, then tap "Sign in".\nExpect: text "Welcome" is visible';
 const steps=authoredNativeSteps(source);
 assert.deepEqual(steps.map(s=>[s.action,s.target,s.fixture]),[['fill','Email','email'],['fill','Password','password'],['click','Sign in',null]]);
 const plan={version:2,platform:'ios',cases:[{name:'Login',source,goal:'Sign in',auth:null,steps,assertions:[{...assertion('visible','Welcome',true),afterStep:2}],blockedReason:null}]};
 const fixtures={inputs:{email:{value:'local-only-email'},password:{value:'local-only-password'}},auth:{}};
 const compile=p=>compileNative(source,'ios','on',fixtures,provider({fetchImpl:async()=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(p)}}],usage:{cost:0}})}),new AbortController().signal,[]);
 assert.deepEqual(await compile(plan),plan);
 for(const change of [p=>p.cases[0].steps.reverse(),p=>{p.cases[0].steps[0].fixture='password';p.cases[0].steps[1].fixture='email';},p=>p.cases[0].steps.splice(1,1),p=>p.cases[0].assertions[0].afterStep=0]){
  const p=structuredClone(plan);change(p);await assert.rejects(compile(p),BlockedError);
 }
 const tripSource='Case: Trip\nGoal: In "Origin" use @origin and in "Destination" use @destination, then tap "Search".\nExpect: text "Results" is visible';
 const tripSteps=authoredNativeSteps(tripSource);assert.deepEqual(tripSteps.map(s=>[s.target,s.fixture]),[['Origin','origin'],['Destination','destination'],['Search',null]]);
 const trip={version:2,platform:'ios',cases:[{name:'Trip',source:tripSource,goal:'Search',auth:null,steps:structuredClone(tripSteps),assertions:[{...assertion('visible','Results',true),afterStep:2}],blockedReason:null}]};
 const tripFixtures={inputs:{origin:{value:'SFO'},destination:{value:'LAX'}},auth:{}};
 const compileTrip=p=>compileNative(tripSource,'ios','on',tripFixtures,provider({fetchImpl:async()=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(p)}}],usage:{cost:0}})}),new AbortController().signal,[]);
 assert.deepEqual(await compileTrip(trip),trip);
 const swapped=structuredClone(trip);swapped.cases[0].steps[0].fixture='destination';swapped.cases[0].steps[1].fixture='origin';await assert.rejects(compileTrip(swapped),/added or changed/);
 const catalogSource='Case: Catalog\nGoal: Tap "Catalog".\nExpect: text "Welcome" is visible',catalogSteps=authoredNativeSteps(catalogSource);
 const invented={version:2,platform:'ios',cases:[{name:'Catalog',source:catalogSource,goal:'Open',auth:null,steps:[{action:'click',target:'Delete account',value:null,fixture:null},...catalogSteps],assertions:[{...assertion('visible','Welcome',true),afterStep:1}],blockedReason:null}]};
 await assert.rejects(compileNative(catalogSource,'ios','on',{inputs:{},auth:{}},provider({fetchImpl:async()=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(invented)}}],usage:{cost:0}})}),new AbortController().signal,[]),/added or changed/);
});
test('installed app IDs are not mistaken for build paths and recording fails closed',async()=>{
 const makeDriver=()=>{const d=new MobileDriver({platform:'ios',app:'com.example.app',device:'sim',baseline:'preserve'},[]);d.connection.interrupt=()=>{};return d;};
 const opened=makeDriver(),calls=[];opened.connection.call=async(command,args)=>{calls.push([command,args]);if(command==='devices')return[{id:'sim',name:'Owned',platform:'ios',kind:'simulator',target:'mobile',booted:true,identifiers:{}}];if(command==='open')return{device:{id:'sim'},appBundleId:'com.example.app'};return{};};
 await opened.open(AbortSignal.timeout(1000));await opened.close();assert.ok(!calls.some(([command])=>command==='install'));assert.ok(calls.some(([command,args])=>command==='open'&&args.app==='com.example.app'));
 const directory=await mkdtemp(join(tmpdir(),'jev-native-recording-'));
 try{
  const buildPath=join(directory,'Fixture.app');await mkdir(buildPath);const built=new MobileDriver({platform:'ios',app:buildPath,device:'sim',baseline:'preserve'},[]),buildCalls=[];built.connection.interrupt=()=>{};built.connection.call=async(command,args)=>{buildCalls.push([command,args]);if(command==='devices')return[{id:'sim',name:'Owned',platform:'ios',kind:'simulator',target:'mobile',booted:true,identifiers:{}}];if(command==='install')return{bundleId:'dev.fixture.installed'};if(command==='open')return{device:{id:'sim'},appBundleId:'dev.fixture.installed'};return{};};
  await built.open(AbortSignal.timeout(1000));await built.close();assert.equal(built.target.app,buildPath);assert.equal(built.resolvedApp,'dev.fixture.installed');assert.ok(buildCalls.some(([command,args])=>command==='install'&&args.appPath===buildPath));
  const unsafe=makeDriver(),unsafePath=join(directory,'unsafe.mp4');unsafe.connection.call=async(command,args)=>{if(command==='record'&&args.action==='start')return{recording:'started',outPath:unsafePath,showTouches:false,recordingScope:'app',activeSessionApp:{bundleId:'com.example.app'}};if(command==='record')return{recording:'stopped',outPath:unsafePath,durationMs:1000,capturedDurationMs:1000,showTouches:false,recordingScope:'app',activeSessionApp:{bundleId:'com.example.app'},recorder:'confirmed',nativePathDisposition:'retired'};if(command==='snapshot')return snapshot([node(0,'TextField','Private input')]);throw Error(command);};
  await unsafe.startRecording(unsafePath,AbortSignal.timeout(1000));await writeFile(unsafePath,'private pixels');assert.equal(await unsafe.stopRecording(AbortSignal.timeout(1000)),null);await assert.rejects(readFile(unsafePath),/ENOENT/);assert.match(unsafe.recordingDiscardedReason,/final screen/);
  const malformed=makeDriver(),malformedPath=join(directory,'malformed.mp4'),unexpectedPath=join(directory,'unexpected.mp4');malformed.connection.call=async(command,args)=>{if(command==='record'&&args.action==='start')return{recording:'started',outPath:malformedPath,showTouches:false,recordingScope:'app',activeSessionApp:{bundleId:'com.example.app'}};if(command==='record'){await writeFile(unexpectedPath,'unexpected private pixels');return{recording:'stopped',outPath:unexpectedPath,durationMs:1000,showTouches:false};}if(command==='snapshot')return snapshot([node(0,'Button','Done')]);throw Error(command);};
  await malformed.startRecording(malformedPath,AbortSignal.timeout(1000));await writeFile(malformedPath,'private pixels');await assert.rejects(malformed.stopRecording(AbortSignal.timeout(1000)),/invalid artifact identity/);await malformed.close();for(const path of [malformedPath,unexpectedPath])await assert.rejects(readFile(path),/ENOENT/);
  const lifecycle=makeDriver(),lifecyclePath=join(directory,'lifecycle.mp4'),safeState={...snapshot([node(0,'Application','Example'),node(1,'Button','Done',{parentIndex:0})]),appBundleId:'com.example.app',identifiers:{appBundleId:'com.example.app'}};lifecycle.connection.call=async(command,args)=>{if(command==='record'&&args.action==='start')return{recording:'started',outPath:lifecyclePath,showTouches:false,recordingScope:'app',activeSessionApp:{bundleId:'com.example.app'}};if(command==='record')return{recording:'stopped',outPath:lifecyclePath,durationMs:1000,capturedDurationMs:1000,showTouches:false,recorder:'unconfirmed',nativePathDisposition:'pending'};if(command==='snapshot')return safeState;throw Error(command);};
  await lifecycle.startRecording(lifecyclePath,AbortSignal.timeout(1000));await writeFile(lifecyclePath,'unconfirmed pixels');await assert.rejects(lifecycle.stopRecording(AbortSignal.timeout(1000)),/unsafe lifecycle evidence/);await lifecycle.close();await assert.rejects(readFile(lifecyclePath),/ENOENT/);
  const uncertain=makeDriver(),uncertainPath=join(directory,'uncertain.mp4');uncertain.connection.call=async(command,args)=>{if(command==='record'&&args.action==='start'){await writeFile(uncertainPath,'possibly finalized pixels');throw new BlockedError('Lost start response');}throw Error(command);};
  await assert.rejects(uncertain.startRecording(uncertainPath,AbortSignal.timeout(1000)),/Lost start response/);assert.equal(await readFile(uncertainPath,'utf8'),'possibly finalized pixels');await uncertain.close();await assert.rejects(readFile(uncertainPath),/ENOENT/);assert.match(uncertain.recordingDiscardedReason,/not confirmed/);
  const stale=makeDriver(),stalePath=join(directory,'stale.mp4');await writeFile(stalePath,'OLD SECRET VIDEO');stale.connection.call=async(command,args)=>{if(command==='record'&&args.action==='start')return{recording:'started',outPath:stalePath,showTouches:false,recordingScope:'app',activeSessionApp:{bundleId:'com.example.app'}};if(command==='record')return{recording:'stopped',outPath:stalePath,durationMs:1000,showTouches:false,recordingScope:'app',activeSessionApp:{bundleId:'com.example.app'},recorder:'confirmed',nativePathDisposition:'retired'};if(command==='snapshot')return safeState;throw Error(command);};
  await stale.startRecording(stalePath,AbortSignal.timeout(1000));await assert.rejects(readFile(stalePath),/ENOENT/);await assert.rejects(stale.stopRecording(AbortSignal.timeout(1000)),/fresh usable artifact/);await stale.close();
  const screenshot=makeDriver(),screenshotPath=join(directory,'stale.png');screenshot.ready=true;await writeFile(screenshotPath,'OLD SECRET IMAGE');screenshot.connection.call=async(command,args)=>{if(command==='snapshot')return safeState;if(command==='screenshot')return{path:screenshotPath};throw Error(command);};await assert.rejects(screenshot.screenshot(screenshotPath,AbortSignal.timeout(1000)),/fresh local artifact/);await assert.rejects(readFile(screenshotPath),/ENOENT/);await screenshot.close();
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('native saved plans bind platform/app/baseline and reject altered targets or checks',async()=>{
  const plan=parseNative('Case: Persist\nGoal: Inspect saved state\nStep: Relaunch\nExpect: text "Saved" is visible','ios');
  const target={platform:'ios',app,device:'a',baseline:'preserve'},saved={version:2,target,plan,hash:savedHash(plan,target),flows:[null]};
  const directory=await mkdtemp(join(tmpdir(),'jev-native-contract-')),path=join(directory,'plan.json');
  await writeFile(path,JSON.stringify(saved));assert.deepEqual(await readSavedPlan(path),saved);
  await writeFile(path,JSON.stringify({...saved,target:{...target,app:'dev.other'}}));await assert.rejects(readSavedPlan(path),BlockedError);
  await writeFile(path,JSON.stringify({...saved,plan:{...plan,cases:[{...plan.cases[0],assertions:[]} ]}}));await assert.rejects(readSavedPlan(path),BlockedError);
  await writeFile(path,JSON.stringify({...saved,flows:[[{step:0,navigation:false,control:null}]]}));await assert.rejects(readSavedPlan(path),BlockedError);
  await rm(directory,{recursive:true,force:true});
});
test('native report keeps duplicate unchecked milestones and zero/false observations distinct',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'jev-native-report-')),a={...assertion('visible','Ready',true),afterStep:0},plan={version:2,platform:'ios',cases:[{name:'Evidence',source:'Case: Evidence',goal:'Show evidence',auth:null,steps:[{action:'click',target:'Go',value:null,fixture:null}],assertions:[a,a],blockedReason:null}]};
 const result={version:2,id:'id',startedAt:new Date(0).toISOString(),url:'app://dev.example.app',verdict:'BLOCKED',canceled:false,durationMs:1,model:{requests:0,plannerRequests:0,jevRequests:0,cost:0,models:[]},plan,reportDirectory:directory,target:{platform:'ios',app:'dev.example.app',device:'sim',baseline:'preserve'},versions:{backend:'test'},timings:{check:0},cases:[{name:'Evidence',goal:'Show evidence',verdict:'BLOCKED',reason:'Stopped after one check.',checks:[{assertion:a,passed:false,observed:false}],actions:[{step:0,action:'click',target:'Go',replay:false}],durationMs:1,screenshot:null,flow:[]}]};
 try{await writeReport(result,directory);const html=await readFile(join(directory,'report.html'),'utf8');assert.equal(html.match(/NOT CHECKED/g)?.length,1);assert.match(html,/>false<\/td>/);assert.match(html,/Environment and full-run timings/);}finally{await rm(directory,{recursive:true,force:true});}
});
