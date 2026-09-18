import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDemo } from '../dist/demo.js';
import { runSuite } from '../dist/runner.js';
import { parseExplicit } from '../dist/plan.js';
import { readFixtures } from '../dist/config.js';
import { scriptedDecision } from './helpers.mjs';

const waiting=signal=>new Promise((_,reject)=>{signal.addEventListener('abort',()=>reject(new Error('Aborted')),{once:true});});
test('cancel during planner HTTP work dispatches no browser actions',async()=>{
  const controller=new AbortController();let posts=0;const started=Date.now();const result=await runSuite({url:'http://127.0.0.1:1',casesText:'Case: Cancel\nCreate a project named "Acme".\nExpect: project named "Acme" exists exactly once',planner:'on',apiKey:'fake-private-key',outputDirectory:false,signal:controller.signal,fetchImpl:async(url,options)=>{if(!options?.body)return Response.json({data:{endpoints:[{pricing:{prompt:'0',completion:'0'}}]}});posts++;setTimeout(()=>controller.abort(),30);return waiting(options.signal);}});
  assert.equal(result.verdict,'BLOCKED');assert.equal(result.canceled,true);assert.equal(result.cases[0].actions.length,0);assert.equal(posts,1);assert.ok(Date.now()-started<5000);
});
test('cancel during Jev HTTP work closes its context and dispatches no action',async()=>{
  const demo=await startDemo(0),directory=await mkdtemp(join(tmpdir(),'jev-http-cancel-'));try{
    const controller=new AbortController();let posts=0,closed=false;const fixtures=readFixtures(await demo.writeFixtures(directory));const started=Date.now();
    const result=await runSuite({url:demo.url,casesText:'Case: Cancel\nAuth: @signed-in\nGoal: Create project named "Acme"\nExpect: project named "Acme" exists exactly once',planner:'off',fixtures,apiKey:'fake-private-key',signal:controller.signal,outputDirectory:false,onProgress:event=>{if(event.type==='context.closed')closed=true;},fetchImpl:async(url,options)=>{if(!options?.body)return Response.json({data:{endpoints:[{pricing:{prompt:'0',completion:'0'}}]}});posts++;setTimeout(()=>controller.abort(),30);return waiting(options.signal);}});
    assert.equal(result.verdict,'BLOCKED');assert.equal(result.canceled,true);assert.equal(result.cases[0].actions.length,0);assert.equal(posts,1);assert.ok(closed);assert.ok(Date.now()-started<5000);
  }finally{await demo.close();await rm(directory,{recursive:true,force:true});}
});
test('unknown navigation mutation is dispatched once and never retried',async()=>{
  let mutations=0;const server=createServer((request,response)=>{if(request.url==='/hang'){mutations++;return;}response.setHeader('Content-Type','text/html');response.end('<button onclick="location.href=\'/hang\'">Submit</button>');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}`;
  try{const plan=parseExplicit('Case: Unknown\nGoal: Submit once\nStep: Click "Submit"\nExpect: text "Done" is visible');const result=await runSuite({url,plan,decide:scriptedDecision,outputDirectory:false,timeoutMs:10000});assert.equal(result.verdict,'BLOCKED');assert.equal(mutations,1);assert.equal(result.cases[0].actions.length,1);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
test('navigation outside the app origin is blocked before an outside request is sent',async()=>{
  let outsideRequests=0;const outside=createServer((_,response)=>{outsideRequests++;response.end('Outside');});await new Promise(resolve=>outside.listen(0,'127.0.0.1',resolve));
  const app=createServer((_,response)=>{response.setHeader('Content-Type','text/html');response.end(`<a href="http://127.0.0.1:${outside.address().port}/">Continue</a>`);});await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  try{const result=await runSuite({url:`http://127.0.0.1:${app.address().port}`,plan:parseExplicit('Case: Origin\nGoal: Continue\nStep: Click "Continue"\nExpect: text "Outside" is visible'),decide:scriptedDecision,outputDirectory:false});assert.equal(result.verdict,'BLOCKED');assert.equal(outsideRequests,0);}finally{app.closeAllConnections();outside.closeAllConnections();await Promise.all([new Promise(resolve=>app.close(resolve)),new Promise(resolve=>outside.close(resolve))]);}
});
test('planning obeys the configured deadline without opening a browser',async()=>{
  const started=Date.now();const result=await runSuite({url:'http://127.0.0.1:1',casesText:'Case: Timeout\nCreate project named "Acme".\nExpect: project named "Acme" exists exactly once',planner:'on',timeoutMs:100,apiKey:'fake-private-key',outputDirectory:false,fetchImpl:async(url,options)=>{if(!options?.body)return Response.json({data:{endpoints:[{pricing:{prompt:'0',completion:'0'}}]}});return waiting(options.signal);}});assert.equal(result.verdict,'BLOCKED');assert.equal(result.canceled,false);assert.match(result.cases[0].reason,/Planning deadline/);assert.equal(result.cases[0].actions.length,0);assert.ok(Date.now()-started<1000);
});
