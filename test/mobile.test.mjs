import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseNative,compileNative,authoredNativeSteps} from '../dist/mobile-plan.js';
import {provider} from './helpers.mjs';
import {nativeCheck,normalizeNative} from '../dist/mobile.js';
import {selectDevice} from '../dist/device.js';
import {readSavedPlan,savedHash} from '../dist/runner.js';
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
  const provider={stats:{plannerRequests:0},fetchImpl:()=>{throw Error('No model call allowed');}};
  assert.deepEqual(await compileNative(source,'ios','off',{inputs:{},auth:{}},provider,new AbortController().signal,[]),plan);
  assert.throws(()=>validateSuite({...plan,version:1,platform:undefined}),BlockedError);
  for(const step of ['Reload','Select "Theme" with "Dark"','Swipe forever','Fill "Password" with "literal"']){
    const bad=parseNative(`Case: Unsupported\nGoal: Check\nStep: ${step}\nExpect: text "Done" is visible`,'ios');assert.ok(bad.cases[0].blockedReason);assert.equal(bad.cases[0].steps.length,0);
  }
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
