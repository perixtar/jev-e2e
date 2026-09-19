import { splitCases, parseExpectation } from './plan.js';
import { interpret, type ProviderOptions } from './providers.js';
import { containsSecret } from './config.js';
import { BlockedError, validateSuite, type Fixtures, type Suite, type Step, type Assertion } from './types.js';

const quote = (text: string) => { try { return JSON.parse(`"${text}"`) as string; } catch { throw new BlockedError('Use JSON-style double-quoted names and values.'); } };
const empty = (action: Step['action'], target: string | null = null): Step => ({ action, target, value: null, fixture: null });
export function nativeStep(text: string): Step {
  if (/^(relaunch|back|dismiss keyboard)$/i.test(text)) return empty(/^dismiss/i.test(text) ? 'keyboard' : text.toLowerCase() as Step['action']);
  let m = text.match(/^(tap|click|check|uncheck|enable|disable) "((?:\\.|[^"\\])*)"$/i);
  if (m) return empty(/tap|click/i.test(m[1]) ? 'click' : /check|enable/i.test(m[1]) && !/uncheck/i.test(m[1]) ? 'check' : 'uncheck', quote(m[2]));
  m = text.match(/^fill "((?:\\.|[^"\\])*)" (?:with|=) ("(?:\\.|[^"\\])*"|@[A-Za-z0-9_.-]+)$/i);
  if (m) return { ...empty('fill', quote(m[1])), value: m[2].startsWith('@') ? null : JSON.parse(m[2]), fixture: m[2].startsWith('@') ? m[2].slice(1) : null };
  m = text.match(/^scroll (up|down|left|right)$/i);
  if (m) return empty('scroll', m[1].toLowerCase());
  m = text.match(/^wait for text "((?:\\.|[^"\\])*)"$/i);
  if (m) return empty('wait', quote(m[1]));
  throw new BlockedError('Unsupported mobile action. Use Tap, Fill, Check, Uncheck, Scroll down/up/left/right, Back, Dismiss keyboard, Relaunch, or Wait for text.');
}
export function nativeExpectation(text: string): Assertion {
  const numeric = text.match(/^number in (?:id|identifier) "((?:\\.|[^"\\])*)" equals (-?\d+(?:\.\d+)?)$/i);
  if (numeric) return { kind: 'number', target: { by: 'id', text: quote(numeric[1]), role: null, within: null }, expected: Number(numeric[2]) };
  const state = text.match(/^(?:switch|checkbox) (?:id|identifier) "((?:\\.|[^"\\])*)" is (checked|unchecked)$/i);
  if (state) return { kind: 'checked', target: { by: 'id', text: quote(state[1]), role: null, within: null }, expected: state[2].toLowerCase() === 'checked' };
  const value = text.match(/^value of (?:id|identifier) "((?:\\.|[^"\\])*)" equals "((?:\\.|[^"\\])*)"$/i);
  if (value) return { kind: 'value', target: { by: 'id', text: quote(value[1]), role: null, within: null }, expected: quote(value[2]) };
  const m = text.match(/^(?:id|identifier) "((?:\\.|[^"\\])*)" is (visible|absent)$/i);
  if (m) return { kind: m[2].toLowerCase() === 'visible' ? 'visible' : 'absent', target: { by: 'id', text: quote(m[1]), role: null, within: null }, expected: m[2].toLowerCase() === 'visible' };
  if (/after reload/i.test(text)) throw new BlockedError('Use an explicit Relaunch step for native persistence; Reload is a browser operation.');
  return parseExpectation(text.replace(/^switch /i, 'checkbox ')).assertion;
}
export function parseNative(text: string, platform: 'ios' | 'android'): Suite {
  const cases = splitCases(text).map(({ name, source }) => {
    const test = { name, source, goal: name, auth: null, steps: [] as Step[], assertions: [] as Assertion[], blockedReason: null as string | null };
    try {
      let goals = 0;
      for (const line of source.split('\n').slice(1).filter(line => line.trim())) {
        const field = line.match(/^(Goal|Step|Expect):\s*(.*)$/i);
        if (!field) throw new BlockedError('With --planner off, use Goal, Step, and Expect lines. See "jev-e2e run --help".');
        if (field[1].toLowerCase() === 'goal') { test.goal = field[2]; goals++; }
        else if (field[1].toLowerCase() === 'step') test.steps.push(nativeStep(field[2]));
        else { if (!test.steps.length) throw new BlockedError('Put each Expect after the action it checks.'); test.assertions.push({ ...nativeExpectation(field[2]), afterStep: test.steps.length - 1 }); }
      }
      if (goals !== 1) throw new BlockedError('Every mobile case needs exactly one Goal.');
      validateSuite({ version: 2, platform, cases: [test] });
    } catch (e) { test.blockedReason = e instanceof BlockedError ? e.message : 'Could not parse the mobile case.'; test.steps = []; test.assertions = []; }
    return test;
  });
  return validateSuite({ version: 2, platform, cases });
}
// Protect bindings and order that the author made unambiguous in prose.
// Broader phrasing still uses the optional compiler; these are constraints.
export function authoredNativeSteps(source: string): Step[] {
  const intent = source.split('\n').filter(line => !/^(Case|Expect):/i.test(line)).join('\n');
  const token = '"(?:\\\\.|[^"\\\\])*"';
  const value = '(?:'+token+'|@[A-Za-z0-9_.-]+)';
  const expression = new RegExp("\\bin\\s+"+token+"\\s+use\\s+"+value+"|\\b(?:fill|replace)\\s+"+token+"\\s+(?:with|using|=)\\s+"+value+"|\\b(?:tap|click|check|uncheck|enable|disable)\\s+(?:the\\s+)?"+token+"|\\b(?:dismiss|hide)\\s+(?:the\\s+)?keyboard|\\b(?:go\\s+)?back\\b|\\brelaunch\\b|\\bscroll\\s+(?:up|down|left|right)\\b|\\bwait\\s+for\\s+(?:the\\s+)?(?:exact\\s+)?text\\s+"+token, 'gi');
  return [...intent.matchAll(expression)].map(match => nativeStep(match[0]
    .replace(new RegExp('^in\\s+('+token+')\\s+use\\s+('+value+')$','i'),'Fill $1 with $2')
    .replace(/^replace\b/i,'Fill').replace(/\s+using\s+/i,' with ')
    .replace(/^(tap|click|check|uncheck|enable|disable)\s+the\s+/i,'$1 ')
    .replace(/^(dismiss|hide)\s+(?:the\s+)?keyboard$/i,'Dismiss keyboard')
    .replace(/^go\s+back$/i,'Back')
    .replace(/^wait\s+for\s+(?:the\s+)?(?:exact\s+)?text\s+/i,'Wait for text ')));
}
export async function compileNative(text: string, platform: 'ios' | 'android', mode: 'on' | 'off', fixtures: Fixtures, provider: ProviderOptions, signal: AbortSignal, secrets: string[]): Promise<Suite> {
  signal.throwIfAborted();
  if (containsSecret(text, secrets) || /(?:password|email|token|secret|api.?key)"?\s*(?:with|using|=|is)\s*"/i.test(text)) throw new BlockedError('Use @fixture references for credential inputs.');
  if (/^Auth:/im.test(text) || /captcha|biometric|face id|touch id|canvas|pixel|looks (?:good|right)|\bpay(?:ment)?\b|\bpurchase\b|send (?:a )?(?:dm|message)/i.test(text)) throw new BlockedError('This native case needs an unsupported capability. Use observed UI actions and exact expectations.');
  const baseline = parseNative(text, platform);
  if (mode === 'off' || baseline.cases.every(test => !test.blockedReason)) return baseline;
  // Explicit unsupported steps are a user contract, never a request to invent replacements.
  if (/^Step:/im.test(text)) return baseline;
  const blocks = splitCases(text);
  const sourceBlocks = blocks.map(block => ({ ...block, requiredSteps: authoredNativeSteps(block.source), requiredAssertions: block.source.split('\n').filter(line => /^Expect:/i.test(line)).map(line => nativeExpectation(line.replace(/^Expect:\s*/i, ''))) }));
  if (sourceBlocks.some(block => !block.requiredAssertions.length)) throw new BlockedError('Add explicit Expect lines. Tests need authored correctness criteria.');
  const suite = validateSuite(await interpret(JSON.stringify({ sourceBlocks }), { inputs: Object.keys(fixtures.inputs), auth: [] }, provider, signal, platform));
  if (suite.version !== 2 || suite.platform !== platform || suite.cases.length !== blocks.length) throw new BlockedError('Planner changed the platform or case count.');
  for (let i = 0; i < blocks.length; i++) {
    const test = suite.cases[i], block = blocks[i];
    if (test.name !== block.name || test.source !== block.source || test.auth) throw new BlockedError('Planner changed a case identity or native authentication contract.');
    if (test.blockedReason) continue;
    const requiredSteps = sourceBlocks[i].requiredSteps;
    if (!requiredSteps.length || test.steps.length !== requiredSteps.length || test.steps.some((step, index) => JSON.stringify(step) !== JSON.stringify(requiredSteps[index]))) throw new BlockedError('Planner added or changed an authored action, input binding, or action order. Use explicit Step lines when an action cannot be recognized safely.');
    for (const ref of block.source.matchAll(/@([A-Za-z0-9_.-]+)/g)) if (!test.steps.some(step => step.fixture === ref[1])) throw new BlockedError('Planner dropped a fixture binding.');
    const intent = JSON.stringify({ steps: test.steps, assertions: test.assertions });
    for (const m of block.source.matchAll(/"((?:\\.|[^"\\])*)"/g)) if (!intent.includes(JSON.stringify(quote(m[1])).slice(1, -1))) throw new BlockedError('Planner changed a supplied literal.');
    const requiredAssertions = sourceBlocks[i].requiredAssertions;
    if (test.assertions.length !== requiredAssertions.length || test.assertions.some(({afterStep, ...check},index) => JSON.stringify(check) !== JSON.stringify(requiredAssertions[index]) || afterStep !== test.steps.length - 1)) throw new BlockedError('Planner changed an expectation or its final verification milestone. Use Step lines for intermediate milestones.');
    if (/\brelaunch\b/i.test(block.source) && !test.steps.some(step => step.action === 'relaunch')) throw new BlockedError('Planner dropped persistence verification.');
  }
  return suite;
}
