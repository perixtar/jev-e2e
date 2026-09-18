import { parseExplicit } from '../dist/plan.js';
import { readFile } from 'node:fs/promises';
export const faults=['login','invalid-login','create','rename','archive','filter','theme','notifications','required','search'];
export async function benchmark(){return parseExplicit(await readFile(new URL('../examples/benchmark.cases',import.meta.url),'utf8'));}
export async function scriptedDecision(snapshot,step){
  const compatible=snapshot.controls.filter(c=>!c.disabled&&(step.action==='fill'?['input','textarea'].includes(c.tag):step.action==='select'?c.tag==='select':['check','uncheck'].includes(step.action)?c.type==='checkbox':['button','link'].includes(c.role)));
  const contextual=step.target?.match(/^(Rename|Archive) project (.+)$/);
  const matches=compatible.filter(c=>contextual?c.label===contextual[1]&&c.context.startsWith(contextual[2]):c.label===step.target);
  if(matches.length===1)return {target:matches[0].id,navigation:'blocked'};
  if(!snapshot.text)return {target:'none',navigation:'wait'};
  const settings=snapshot.controls.find(c=>c.label==='Settings');
  if(settings&&['Theme','Enable notifications'].includes(step.target)&&!snapshot.controls.some(c=>c.label===step.target))return {target:'none',navigation:settings.id};
  return {target:'none',navigation:'blocked'};
}
export const provider=(overrides={})=>({apiKey:'unit-test-key',jevModel:'typesafe/jev-1.13',plannerModel:'openai/gpt-4.1-mini',maxRequests:100,maxCost:0.05,prices:new Map([['typesafe/jev-1.13',{prompt:0.000000042,completion:0}],['openai/gpt-4.1-mini',{prompt:0.0000004,completion:0.0000016}]]),stats:{requests:0,plannerRequests:0,jevRequests:0,cost:0,models:[]},...overrides});
