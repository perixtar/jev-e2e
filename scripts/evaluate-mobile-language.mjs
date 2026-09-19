// Opt-in paid compilation checks. Expected contracts are authored independently.
import {compileNative} from '../dist/mobile-plan.js';import {providerOptions} from '../dist/runner.js';import {loadEnvironment} from '../dist/config.js';import {writeFile,mkdir} from 'node:fs/promises';import {parseArgs,promisify} from 'node:util';import {resolve,dirname} from 'node:path';import {fileURLToPath} from 'node:url';import {execFile} from 'node:child_process';
const {values}=parseArgs({options:{live:{type:'boolean'},out:{type:'string'},'max-cost':{type:'string',default:'0.20'}}});
if(!values.live)throw Error('Live language evaluation requires --live. Ordinary npm test is free.');
const cap=Number(values['max-cost']);if(!Number.isFinite(cap)||cap<=0||cap>1)throw Error('max-cost must be in (0,1].');
loadEnvironment();const fixtures={inputs:{email:{value:'demo@example.test'},password:{value:'correct-horse'},invalidPassword:{value:'wrong-horse'}},auth:{}};
const repo=resolve(fileURLToPath(new URL('..',import.meta.url))),execute=promisify(execFile);const [{stdout:implementationSha},{stdout:dirty}]=await Promise.all([execute('git',['rev-parse','HEAD'],{cwd:repo}),execute('git',['status','--porcelain'],{cwd:repo})]);if(dirty.trim())throw Error('Commit the implementation before a language evaluation so its package SHA is exact.');
const step=(action,target=null,value=null,fixture=null)=>({action,target,value,fixture});
const expectation=(kind,by,text,expected)=>({kind,target:{by,text,role:null,within:null},expected});
const descriptions=[
 ['Open catalog','Tap "Catalog".','text "Find your favorite." is visible',[step('click','Catalog')],expectation('visible','text','Find your favorite.',true)],
 ['Open settings','Tap "Settings" to inspect the preferences.','text "Make it yours." is visible',[step('click','Settings')],expectation('visible','text','Make it yours.',true)],
 ['Search','Replace "Search products" with "lamp", then dismiss the keyboard.','text "Desk Lamp" is visible',[step('fill','Search products','lamp'),step('keyboard')],expectation('visible','text','Desk Lamp',true)],
 ['Enable notifications','Enable the "Notifications" switch.','switch "Notifications" is checked',[step('check','Notifications')],expectation('checked','label','Notifications',true)],
 ['Disable notifications','Disable the "Notifications" switch.','switch "Notifications" is unchecked',[step('uncheck','Notifications')],expectation('checked','label','Notifications',false)],
 ['Scroll down','Scroll down once.','text "Preference 10" is visible',[step('scroll','down')],expectation('visible','text','Preference 10',true)],
 ['Scroll up','Scroll up once.','text "Preference 1" is visible',[step('scroll','up')],expectation('visible','text','Preference 1',true)],
 ['Back','Go back once.','text "Catalog" is visible',[step('back')],expectation('visible','text','Catalog',true)],
 ['Keyboard','Dismiss the keyboard.','text "Catalog" is visible',[step('keyboard')],expectation('visible','text','Catalog',true)],
 ['Restart','Relaunch the app, keeping its data.','text "Saved" is visible',[step('relaunch')],expectation('visible','text','Saved',true)],
 ['Wait','Wait for the exact text "Ready" to appear.','text "Ready" is visible',[step('wait','Ready')],expectation('visible','text','Ready',true)],
 ['Add lamp','Tap "Open Desk Lamp", then tap "Add to cart".','text "Quantity: 1" is visible',[step('click','Open Desk Lamp'),step('click','Add to cart')],expectation('visible','text','Quantity: 1',true)],
 ['Quantity','Tap "Increase Desk Lamp quantity".','number in field "Cart total" equals 72',[step('click','Increase Desk Lamp quantity')],expectation('number','label','Cart total',72)],
 ['Remove','Tap "Remove Desk Lamp".','text "Your cart is empty" is visible',[step('click','Remove Desk Lamp')],expectation('visible','text','Your cart is empty',true)],
 ['Literal unicode','Replace "Search products" with "café ☕".','field "Search products" equals "café ☕"',[step('fill','Search products','café ☕')],expectation('value','label','Search products','café ☕')],
 ['Exact punctuation','Replace "Search products" with "Lamp - 2.0".','field "Search products" equals "Lamp - 2.0"',[step('fill','Search products','Lamp - 2.0')],expectation('value','label','Search products','Lamp - 2.0')],
 ['Valid sign in','Fill "Email" using @email, fill "Password" using @password, then tap "Sign in".','text "Find your favorite." is visible',[step('fill','Email',null,'email'),step('fill','Password',null,'password'),step('click','Sign in')],expectation('visible','text','Find your favorite.',true)],
 ['Reject wrong password','Fill "Email" using @email, fill "Password" using @invalidPassword, then tap "Sign in" with those invalid credentials.','text "Invalid credentials" is visible',[step('fill','Email',null,'email'),step('fill','Password',null,'invalidPassword'),step('click','Sign in')],expectation('visible','text','Invalid credentials',true)],
 ['Persist cart','Tap "Open Desk Lamp", tap "Add to cart", relaunch the app, then tap "Cart".','text "Desk Lamp" is visible',[step('click','Open Desk Lamp'),step('click','Add to cart'),step('relaunch'),step('click','Cart')],expectation('visible','text','Desk Lamp',true)],
 ['Empty input','Replace "Search products" with "".','field "Search products" equals ""',[step('fill','Search products','')],expectation('value','label','Search products','')],
];
const outcomes=[],provider=providerOptions({maxCost:cap});
for(const platform of ['ios','android'])for(let i=0;i<descriptions.length;i++){
 const batch=descriptions.slice(i,i+1);const text=batch.map(([name,goal,expect])=>`Case: ${name}\nGoal: ${goal}\nExpect: ${expect}`).join('\n\n');
 try{const plan=await compileNative(text,platform,'on',fixtures,provider,AbortSignal.timeout(30000),[]);for(let n=0;n<batch.length;n++){const [name,,,steps,assertion]=batch[n],test=plan.cases[n],expectedAssertions=[{...assertion,afterStep:steps.length-1}];const accepted=plan.version===2&&plan.platform===platform&&plan.cases.length===batch.length&&!test.blockedReason&&test.name===name&&test.source===text&&test.auth===null&&JSON.stringify(test.steps)===JSON.stringify(steps)&&JSON.stringify(test.assertions)===JSON.stringify(expectedAssertions);outcomes.push({platform,name,accepted,expectedSteps:steps,expectedAssertions,test});console.log(platform,name,accepted?'PASS':'FAIL');}}catch(e){outcomes.push({platform,batch:i,error:e.message});console.log(platform,'ERROR',e.message);}
}
const path=resolve(values.out??'.jev-e2e/mobile-language.json');await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,JSON.stringify({implementationSha:implementationSha.trim(),outcomes,stats:provider.stats},null,2),{mode:0o600});console.log('COUNTS',outcomes.filter(o=>o.accepted).length,'/40',provider.stats);process.exitCode=['ios','android'].every(platform=>outcomes.filter(o=>o.platform===platform&&o.accepted).length>=19)?0:1;
