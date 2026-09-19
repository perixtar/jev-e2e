import { splitCases, parseExpectation } from './plan.js';
import { interpret, type ProviderOptions } from './providers.js';
import { containsSecret } from './config.js';
import { BlockedError, validateSuite, sensitiveInputTarget, unsupportedNativeMutation, type Fixtures, type Suite, type Step, type Assertion } from './types.js';

const quote = (text: string) => { try { return JSON.parse(`"${text}"`) as string; } catch { throw new BlockedError('Use JSON-style double-quoted names and values.'); } };
const empty = (action: Step['action'], target: string | null = null): Step => ({ action, target, value: null, fixture: null });
function negatedNativeAction(text: string): boolean {
  const action = '(?:tap(?:ping)?|click(?:ing)?|fill(?:ing)?|replac(?:e|ing)|check(?:ing)?|uncheck(?:ing)?|enabl(?:e|ing)|disabl(?:e|ing)|relaunch(?:ing)?|restart(?:ing)?|scroll(?:ing)?|go(?:ing)?\\s+back|dismiss(?:ing)?|hid(?:e|ing)|wait(?:ing)?)';
  return new RegExp('(?:\\bnever\\b|\\bdo\\s+not\\b|\\bdon[’\']t\\b|\\bmust\\s+not\\b|\\bshould\\s+not\\b|\\bwithout\\b)[^.!?;\\n]{0,120}\\b' + action + '\\b', 'i').test(text)
    || new RegExp('\\b(?:avoid|skip|except)\\s+(?:to\\s+)?' + action + '\\b', 'i').test(text);
}
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
      if (negatedNativeAction(source)) throw new BlockedError('Negative native action clauses are ambiguous. Describe only the actions that should run.');
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
  if (negatedNativeAction(source)) throw new BlockedError('Negative native action clauses are ambiguous. Describe only the actions that should run.');
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
function privateInputLiteral(text: string): boolean {
  // The planner receives every line, including case names and expectations, so
  // inspect that exact source. Only explicit @fixture bindings may carry values
  // for private fields; unfamiliar private prose fails closed before a request.
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text) || /\b\d{3}-\d{2}-\d{4}\b/.test(text)) return true;
  const token = '"(?:\\\\.|[^"\\\\])*"';
  const fixtureBinding = new RegExp('\\bin\\s+' + token + '\\s+use\\s+@[A-Za-z0-9_.-]+|\\b(?:fill|replace)\\s+' + token + '\\s+(?:with|using|=)\\s+@[A-Za-z0-9_.-]+', 'gi');
  const secretShaped = (value: string) => /^\d{4,12}$/.test(value) || (/^\S{6,}$/.test(value) && /[-_!#$%^&*+=]/.test(value)) || /^[A-Za-z0-9+/]{20,}={0,2}$/.test(value) || /^(?:sk|pk|api|token)[-_]/i.test(value);
  for (const line of text.split('\n')) {
    const field = line.match(/^\s*(Case|Goal|Step|Expect):\s*(.*)$/i);
    const body = field?.[2] ?? line;
    if (/^\s*Expect:/i.test(line)) {
      const expectedText = body.match(/^text\s+"((?:\\.|[^"\\])*)"\s+is\s+(?:visible|absent)$/i);
      const expectedValue = body.match(/\bequals\s+"((?:\\.|[^"\\])*)"\s*$/i);
      const candidate = expectedText?.[1] ?? expectedValue?.[1];
      if (candidate !== undefined && secretShaped(quote(candidate))) return true;
    }
    let authored = line.replace(fixtureBinding, '').replace(/@[A-Za-z0-9_.-]+/g, '');
    if (field?.[1].toLowerCase() === 'step') {
      try {
        const step = nativeStep(body);
        if (step.action !== 'fill') continue;
        if (step.fixture && sensitiveInputTarget(step.target ?? '')) continue;
      } catch { /* Unknown Step syntax is handled later, but must still be scanned. */ }
    }
    // A case title may describe a password/OTP behavior without containing the
    // value. Direct secret forms above are still rejected from titles.
    if (field?.[1].toLowerCase() === 'case') continue;
    if (sensitiveInputTarget(authored)) return true;
  }
  const authored = text.replace(fixtureBinding, '').replace(/@[A-Za-z0-9_.-]+/g, '');
  if (/\b(?:password|passcode|pin|otp|one[- ]time(?:\s+(?:password|code))?|verification\s+code|security\s+code|credit\s+card|card\s+number|cvv|cvc|social\s+security(?:\s+number)?|ssn|token|secret|api.?key|e-?mail|user\s*name)\b"?\s*(?:with|using|=|is|:|to|should\s+be)\s*(?!@)(?:"[^"\n]+"|[^\s,.;]+)/i.test(authored)) return true;
  if (/\b(?:enter|type|input|use|fill|replace|set|put|paste|provide)\s+(?:code\s+)?(?!@)(?:"[^"\n]+"|'[^'\n]+'|\d[\d -]{2,20}\d|[A-Za-z0-9][A-Za-z0-9._-]{2,})\s+(?:in|into|for|as)\s+(?:the\s+)?"?(?:password|passcode|pass\s*phrase|pin|otp|one[- ]time(?:\s+(?:password|code))?|verification\s+code|security\s+code|credit\s+card|card\s+number|cvv|cvc|social\s+security(?:\s+number)?|ssn|token|secret|api.?key|e-?mail|user\s*name|login(?:\s+(?:id|name))?)\b/i.test(authored)) return true;
  for (const line of authored.split('\n')) {
    const login = line.match(/\b(?:sign\s*in|log\s*in|authenticate)\b\s+(?:with|using)\s+(.+?)(?:,?\s+then\b|$)/i);
    if (!login) continue;
    if (/"[^"\n]+"|'[^'\n]+'/.test(login[1])) return true;
    const unexplained = login[1].replace(/@[A-Za-z0-9_.-]+/g, '').replace(/\b(?:and|those|the|provided|supplied|invalid|valid|credentials?|e-?mail|user\s*name|password)\b/gi, '').replace(/[^A-Za-z0-9]+/g, '');
    if (unexplained) return true;
  }
  return false;
}
export async function compileNative(text: string, platform: 'ios' | 'android', mode: 'on' | 'off', fixtures: Fixtures, provider: ProviderOptions, signal: AbortSignal, secrets: string[]): Promise<Suite> {
  signal.throwIfAborted();
  if (negatedNativeAction(text)) throw new BlockedError('Negative native action clauses are ambiguous. Describe only the actions that should run.');
  const authoredLiteral = authoredNativeSteps(text).some(step => step.action === 'fill' && step.value !== null && sensitiveInputTarget(step.target ?? ''));
  const targetFirstLiteral = /"(?:password|passcode|pass\s*phrase|pin|otp|one[- ]time(?:\s+(?:password|code))?|verification\s+code|security\s+code|credit\s+card|card\s+number|cvv|cvc|social\s+security(?:\s+number)?|ssn|token|secret|api.?key|e-?mail|user\s*name)"?\s*(?:with|using|=|is)\s*"/i.test(text);
  const valueFirstLiteral = /\b(?:enter|type|fill|replace)\s+"(?:\\.|[^"\\])+"\s+(?:in|into|for)\s+"?(?:password|passcode|pin|otp|verification\s+code|security\s+code|credit\s+card|card\s+number|cvv|cvc|social\s+security|ssn|token|secret|api.?key|e-?mail|user\s*name)\b/i.test(text);
  if (containsSecret(text, secrets) || privateInputLiteral(text) || authoredLiteral || targetFirstLiteral || valueFirstLiteral) throw new BlockedError('Use @fixture references for private inputs.');
  if (/^Auth:/im.test(text) || /captcha|biometric|face id|touch id|canvas|pixel|looks (?:good|right)/i.test(text) || unsupportedNativeMutation(text)) throw new BlockedError('This native case needs an unsupported capability. Use observed UI actions and exact expectations.');
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
