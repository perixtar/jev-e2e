// Handwritten Playwright comparison on exactly the owned benchmark app.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDemo, demoCredentials } from '../dist/demo.js';
import { readFixtures, secretValues } from '../dist/config.js';
import { checkAssertion } from '../dist/assertions.js';
import { maskedScreenshot } from '../dist/browser.js';
import { benchmark } from '../test/helpers.mjs';
const output=process.argv[2]??'.jev-e2e/evaluations/playwright-baseline';await mkdir(output,{recursive:true,mode:0o700});
const demo=await startDemo(0),fixturesDirectory=await mkdtemp(join(tmpdir(),'jev-baseline-'));const fixtures=readFixtures(await demo.writeFixtures(fixturesDirectory));const suite=await benchmark();const trials=[];
const settle=page=>page.waitForLoadState('networkidle',{timeout:1500}).catch(()=>{});
try{for(let round=0;round<3;round++)for(let index=0;index<10;index++){
  demo.reset();const started=Date.now();const browser=await chromium.launch();try{const context=await browser.newContext({viewport:{width:1280,height:800},storageState:index>1?fixtures.auth['signed-in'].storageState:undefined});const page=await context.newPage();await page.goto(demo.url);await settle(page);
    const click=async name=>{await page.getByRole('button',{name,exact:true}).click();await settle(page);};
    if(index<2){await page.getByLabel('Email',{exact:true}).fill(demoCredentials.email);await page.getByLabel('Password',{exact:true}).fill(index===0?demoCredentials.password:demoCredentials.invalid);await click('Sign in');}
    else if(index===2||index===8){await click('New project');await page.getByLabel('Project name',{exact:true}).fill(index===2?'Acme':'');await click('Save project');if(index===2)await page.reload();}
    else if(index===3){await page.getByRole('listitem').filter({has:page.getByText('Demo',{exact:true})}).getByRole('button',{name:'Rename',exact:true}).click();await page.getByLabel('Project name',{exact:true}).fill('Acme');await click('Save project');await page.reload();}
    else if(index===4){await page.getByRole('listitem').filter({has:page.getByText('Demo',{exact:true})}).getByRole('button',{name:'Archive',exact:true}).click();await settle(page);}
    else if(index===5){await page.locator('#filter').selectOption({label:'Archived'});await settle(page);}
    else if(index===6||index===7){await click('Settings');if(index===6)await page.locator('#theme').selectOption({label:'Dark'});else await page.getByLabel('Enable notifications',{exact:true}).check();await settle(page);await page.reload();}
    else if(index===9){await page.getByLabel('Search projects',{exact:true}).fill('Demo');await settle(page);}
    await settle(page);for(const expectation of suite.cases[index].assertions)assert.ok((await checkAssertion(page,expectation,new AbortController().signal)).passed,suite.cases[index].name);
    await maskedScreenshot(page,secretValues(fixtures,{}),join(output,`${round+1}-${index+1}.png`));await context.close();
  }finally{await browser.close();}trials.push({round:round+1,case:suite.cases[index].name,wallMs:Date.now()-started,verdict:'PASS'});
}}
finally{await demo.close();const times=trials.map(t=>t.wallMs).sort((a,b)=>a-b);const result={kind:'handwritten-playwright',rounds:3,total:trials.length,modelRequests:0,medianMs:times[Math.floor(times.length/2)],p95Ms:times[Math.ceil(times.length*.95)-1],trials};await writeFile(join(output,'baseline.json'),JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify({...result,trials:undefined}));}
