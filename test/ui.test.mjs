import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startUi } from '../dist/server.js';
import { startDemo } from '../dist/demo.js';
import { scriptedDecision, benchmark } from './helpers.mjs';

test('workbench reviews three cases, runs, inspects, saves, replays, stops and stays local',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'jev-ui-'));const originalFetch=globalThis.fetch;const previousKey=process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY='sk-or-unit-test-private-provider-value';
  globalThis.fetch=async(url,options)=>{
    if(String(url).includes('openrouter.ai')){
      if(!options?.body)return Response.json({data:{endpoints:[{pricing:{prompt:'0',completion:'0'}}]}});
      const payload=JSON.parse(options.body);payload.state.text=payload.state.visibleText;payload.state.controls=payload.state.controls.map(c=>({...c,tag:c.role==='combobox'?'select':c.role==='textbox'||c.role==='checkbox'?'input':'button'}));const selection=await scriptedDecision(payload.state,payload.state.task);
      return Response.json({model:'typesafe/jev-1.13-test',answers:{target:{type:'choice',choice:selection.target},navigation:{type:'choice',choice:selection.navigation}},usage:{cost:0}});
    }
    return originalFetch(url,options);
  };
  const demo=await startDemo(0),ui=await startUi(0,join(directory,'ui'));const fixturePath=await demo.writeFixtures(join(directory,'demo'));const browser=await chromium.launch();
  try{
    const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(ui.url);
    await page.getByText('OpenRouter configured',{exact:false}).waitFor();await page.getByLabel('App URL').fill(demo.url);
    const suite=await benchmark();const cases=[2,6,7].map(index=>suite.cases[index].source).join('\n\n');await page.getByLabel('Cases and expected outcomes').fill(cases);
    await page.getByLabel('Interpret freeform language').uncheck();await page.getByText('Fixtures and saved flows',{exact:true}).click();await page.getByLabel('Local fixtures JSON path').fill(fixturePath);
    await page.getByRole('button',{name:'Review plan'}).click();await page.getByRole('button',{name:'Run reviewed plan'}).waitFor();await page.waitForFunction(()=>!document.querySelector('#run').disabled);
    assert.equal(await page.locator('#plan .case-card').count(),3);await page.getByRole('button',{name:'Run reviewed plan'}).click();await page.waitForFunction(()=>!document.querySelector('#review').disabled&&document.querySelector('#status').textContent.startsWith('PASS'),{},{timeout:30000});assert.equal(await page.locator('#results .PASS').count(),3);assert.equal(await page.locator('#results img').count(),3);
    const reportPath=await page.locator('#report').getAttribute('href'),jobId=reportPath.split('/')[2];await writeFile(join(directory,'ui','runs',jobId,'99.mp4'),'private pixels');assert.equal((await originalFetch(ui.url+`/runs/${jobId}/99.mp4`)).status,404);
    await page.getByRole('button',{name:'Save plan / flow'}).click();await page.waitForFunction(()=>document.querySelector('#saved').value.length>0);const saved=await page.getByLabel('Saved plan path (optional)').inputValue();assert.ok((await readFile(saved,'utf8')).includes('Acme'));
    demo.reset();await page.getByRole('button',{name:'Run reviewed plan'}).click();await page.waitForFunction(()=>!document.querySelector('#review').disabled&&document.querySelector('#status').textContent.startsWith('PASS'),{},{timeout:30000});
    assert.ok(!(await page.content()).includes(process.env.OPENROUTER_API_KEY));assert.equal(await page.evaluate(()=>localStorage.length),0);
    for(const width of [1440,768,390]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:join(directory,`ui-${width}.png`),fullPage:true});}
    await page.emulateMedia({reducedMotion:'reduce'});await page.getByLabel('Saved plan path (optional)').fill('');await page.getByLabel('Cases and expected outcomes').fill('Case: Stop\nAuth: @signed-in\nGoal: Stop\nStep: Wait for text "Never appears"\nStep: Click "New project"\nExpect: text "Done" is visible');await page.getByRole('button',{name:'Review plan'}).click();await page.waitForFunction(()=>!document.querySelector('#run').disabled);await page.getByRole('button',{name:'Run reviewed plan'}).click();await page.waitForFunction(()=>document.querySelector('#log').textContent.includes('wait Never appears'));const start=Date.now();await page.getByRole('button',{name:'Stop',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#status').textContent.startsWith('BLOCKED'));assert.ok(Date.now()-start<5000);assert.equal(await page.locator('#results .BLOCKED').count(),1);
    assert.deepEqual(errors,[]);
    const unauthorized=await originalFetch(ui.url+'/api/run',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(unauthorized.status,403);
    const crossOrigin=await originalFetch(ui.url+'/api/session',{headers:{Origin:'http://attacker.test'}});assert.equal(crossOrigin.status,403);
    const bundle=await originalFetch(ui.url+'/app.js').then(r=>r.text());assert.ok(!bundle.includes(process.env.OPENROUTER_API_KEY));
  }finally{globalThis.fetch=originalFetch;if(previousKey===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=previousKey;await browser.close();await ui.close();await demo.close();await rm(directory,{recursive:true,force:true});}
});
