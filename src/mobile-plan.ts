import { splitCases, parseExpectation } from './plan.js';
import { interpret, type ProviderOptions } from './providers.js';
import { containsSecret } from './config.js';
import { BlockedError, validateSuite, sensitiveInputTarget, unsupportedNativeMutation, type Fixtures, type Suite, type Step, type Assertion } from './types.js';

const quote = (text: string) => { try { return JSON.parse(`"${text}"`) as string; } catch { throw new BlockedError('Use JSON-style double-quoted names and values.'); } };
const empty = (action: Step['action'], target: string | null = null): Step => ({ action, target, value: null, fixture: null });
function negatedNativeAction(text: string): boolean {
  const actions = /\b(?:tap(?:ping)?|click(?:ing)?|fill(?:ing)?|replac(?:e|ing)|check(?:ing)?|uncheck(?:ing)?|enabl(?:e|ing)|disabl(?:e|ing)|relaunch(?:ing)?|restart(?:ing)?|scroll(?:ing)?|go(?:ing)?\s+back|dismiss(?:ing)?|hid(?:e|ing)|wait(?:ing)?)\b/gi;
  const exclusion = /\b(?:never|not|cannot|without|avoid|skip|except|refrain|instead|rather|but|other\s+than|under\s+no\s+circumstances|no\s+circumstances|forbid(?:den)?|prohibit(?:ed)?|[A-Za-z]+n[’']t)\b/i;
  for (const match of text.matchAll(actions)) {
    const start = Math.max(text.lastIndexOf('\n', match.index), text.lastIndexOf(';', match.index), text.lastIndexOf('.', match.index), text.lastIndexOf('!', match.index), text.lastIndexOf('?', match.index)) + 1;
    const tail = text.slice(match.index!); const offset = tail.search(/[\n;.!?]/); const end = offset < 0 ? text.length : match.index! + offset;
    const clause = text.slice(start, end).replace(/"(?:\\.|[^"\\])*"/g, '""');
    if (exclusion.test(clause)) return true;
  }
  return false;
}
function conditionalNativeAction(text: string): boolean {
  const intent = nativeIntent(text);
  return /\b(?:if|unless|otherwise|when|in\s+case|provided\s+that)\b|\bafter\b[^.?!;\n]*?\b(?:is|are|becomes?|turns?|appears?|exists?|loads?|ready|visible|present|enabled|checked|updates?|changes?)\b/i.test(intent);
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
  return redactBlockedNativeCases(validateSuite({ version: 2, platform, cases }));
}
export function redactBlockedNativeCases(plan: Suite): Suite {
  if (plan.version !== 2) return plan;
  return { ...plan, cases: plan.cases.map((test, index) => test.blockedReason ? { ...test, name: `Blocked mobile case ${index + 1}`, source: '[PRIVATE INPUT REDACTED]', goal: '[PRIVATE INPUT REDACTED]', steps: [], assertions: [] } : test) };
}
// Protect bindings and order that the author made unambiguous in prose.
// Broader phrasing still uses the optional compiler; these are constraints.
function nativeActionExpression(): RegExp {
  const token = '"(?:\\\\.|[^"\\\\])*"';
  const value = '(?:'+token+'|@[A-Za-z0-9_.-]+)';
  return new RegExp("\\bin\\s+"+token+"\\s+use\\s+"+value+"|\\b(?:fill|replace)\\s+"+token+"\\s+(?:with|using|=)\\s+"+value+"|\\b(?:tap|click|check|uncheck|enable|disable)\\s+(?:the\\s+)?"+token+"|\\b(?:dismiss|hide)\\s+(?:the\\s+)?keyboard|\\b(?:go\\s+)?back\\b|\\brelaunch\\b|\\bscroll\\s+(?:up|down|left|right)\\b|\\bwait\\s+for\\s+(?:the\\s+)?(?:exact\\s+)?text\\s+"+token, 'gi');
}
function nativeIntent(source: string): string { return source.split('\n').filter(line => !/^(Case|Expect):/i.test(line)).join('\n'); }
function unaccountedNativeAction(text: string): boolean {
  // The compiler may resolve targets from an observed tree, but it may not
  // silently omit an authored action. Remove only actions we can bind exactly.
  const remaining = nativeIntent(text).replace(nativeActionExpression(), '').replace(/"(?:\\.|[^"\\])*"/g, '');
  return /\b(?:open|navigate|visit|delete|remove|archive|rename|create|add|submit|select|choose|search|find|launch|restart|swipe|type|enter|paste|clear|close|sign\s*in|log\s*in|authenticate|tap|click|check|uncheck|enable|disable|fill|replace|scroll|dismiss|hide|wait|relaunch)\b/i.test(remaining);
}
export function authoredNativeSteps(source: string): Step[] {
  if (negatedNativeAction(source)) throw new BlockedError('Negative native action clauses are ambiguous. Describe only the actions that should run.');
  const intent = nativeIntent(source);
  const token = '"(?:\\\\.|[^"\\\\])*"';
  const value = '(?:'+token+'|@[A-Za-z0-9_.-]+)';
  const expression = nativeActionExpression();
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
  const secretShaped = (value: string) => /^\d{4,12}$/.test(value) || (/^\S{6,}$/.test(value) && /[-_!#$%^&*+=]/.test(value)) || /^(?=[A-Za-z0-9]{8,}$)(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9]+$/.test(value) || /^[A-Za-z0-9+/]{20,}={0,2}$/.test(value) || /^(?:sk|pk|api|token)[-_]/i.test(value);
  for (const line of text.split('\n')) {
    const field = line.match(/^\s*(Case|Goal|Step|Expect):\s*(.*)$/i);
    const body = field?.[2] ?? line;
    if (/^\s*Expect:/i.test(line)) {
      const expectedText = body.match(/^text\s+"((?:\\.|[^"\\])*)"\s+is\s+(?:visible|absent)$/i);
      const expectedValue = body.match(/\bequals\s+"((?:\\.|[^"\\])*)"\s*$/i);
      const candidate = expectedText?.[1] ?? expectedValue?.[1];
      if (candidate !== undefined && secretShaped(quote(candidate))) return true;
    }
    if (field?.[1].toLowerCase() === 'step') {
      try {
        const step = nativeStep(body);
        if (step.action !== 'fill') continue;
        if (step.fixture && sensitiveInputTarget(step.target ?? '')) continue;
      } catch { /* Unknown Step syntax is handled later, but must still be scanned. */ }
    }
    if (field?.[1].toLowerCase() === 'case') {
      const withoutFixtures = body.replace(/@[A-Za-z0-9_.-]+/g, '');
      if (sensitiveInputTarget(withoutFixtures)) {
        for (const match of withoutFixtures.matchAll(/"((?:\\.|[^"\\])+)"|'((?:\\.|[^'\\])+)'|\b([A-Za-z0-9][A-Za-z0-9._+@/-]*)\b/g)) {
          const candidate = match[1] ?? match[2] ?? match[3];
          if (((match[1] !== undefined || match[2] !== undefined) && !sensitiveInputTarget(candidate)) || secretShaped(candidate)) return true;
        }
      }
      continue;
    }
  }
  const authored = text.replace(fixtureBinding, '').replace(/@[A-Za-z0-9_.-]+/g, '');
  // Credential-bearing titles/goals have a deliberately small public-vocabulary
  // grammar. Any extra word could itself be a short username or secret; it
  // must stay local until the author replaces it with an @fixture binding.
  const publicWords = new Set('a an the and or to for in on of with without as is was are be been should can cannot not that this those then after before use enter type fill check verify test inspect confirm reject wrong invalid valid missing accepted rejected expired works fails login log sign safely safe flow success failure page screen form field target entry reset refresh validation expectation fixture fixtures input inputs credentials email e-mail user name username password passcode pass phrase passphrase pin otp one time verification security code access token secret api key credit card number cvv cvc social ssn account'.split(' '));
  const privateTerm = /\b(?:password|passcode|pass\s*phrase|pin|otp|one[- ]time(?:\s+(?:password|code))?|verification\s+code|security\s+code|credit\s+card|card\s+number|cvv|cvc|social\s+security(?:\s+number)?|ssn|access\s+token|token|secret|api.?key|e-?mail|user\s*name|login)\b/gi;
  for (const line of authored.split('\n')) {
    if (!/^(?:Case|Goal):/i.test(line)) continue;
    const remaining = line.replace(nativeActionExpression(), '');
    for (const match of remaining.matchAll(privateTerm)) {
      const preceding = remaining.slice(0, match.index).replace(/^(?:Case|Goal):/i, '').match(/[A-Za-z0-9][A-Za-z0-9._+-]*/g) ?? [];
      if (preceding.length && !publicWords.has(preceding.at(-1)!.toLowerCase())) return true;
      let tail = remaining.slice(match.index! + match[0].length);
      // A title can describe an unrelated next task without making its object
      // a credential value: "Login and add lamp". It does not define actions.
      if (/^\s+and\s+(?:add|search|open|view|remove)\b/i.test(tail)) tail = '';
      const trailing = tail.match(/[A-Za-z0-9][A-Za-z0-9._+-]*/g) ?? [];
      if (trailing.some(word => !publicWords.has(word.toLowerCase()))) return true;
    }
  }
  // A credential does not need to look random to be private. Catch the common
  // username/password sentence shapes after removing fixture references so
  // short values such as "letmein" never reach the planner.
  const authToken = '[A-Za-z0-9][A-Za-z0-9._+@-]*';
  const authLiteralPatterns = [
    new RegExp('\\b(?:sign\\s*in|log\\s*in)\\s+as\\s+' + authToken + '\\s+(?:with|using)\\s+(' + authToken + ')', 'i'),
    new RegExp('\\b(?:use|enter|type|provide)\\s+(' + authToken + ')\\s+to\\s+(?:sign\\s*in|log\\s*in|authenticate)\\b', 'i'),
    new RegExp('\\bauthenticate\\s+' + authToken + '\\s*(?:/|\\||with|using)\\s*(' + authToken + ')', 'i'),
    new RegExp('\\blogin[ \\t]+(?!(?:is|was|should|must|can|cannot|will|remains|fails|succeeds|works|with|using|without|after|before|when|and)\\b)' + authToken + '[ \\t]+(' + authToken + ')', 'i'),
  ];
  if (authLiteralPatterns.some(pattern => pattern.test(authored))) return true;
  const unboundIdentityPatterns = [
    new RegExp('\\b(?:sign\\s*in|log\\s*in)\\s+as\\s+' + authToken + '\\b', 'i'),
    new RegExp('\\bauthenticate\\s+' + authToken + '\\b', 'i'),
    new RegExp('^[ \\t]*Case:[ \\t]*Login[ \\t]+(?!(?:flow|success|page|with|failure|failed|rejected|invalid|valid|test|screen|form|state|and)\\b)' + authToken + '\\b', 'im'),
  ];
  if (unboundIdentityPatterns.some(pattern => pattern.test(authored))) return true;
  if (/\b(?:password|passcode|pin|otp|one[- ]time(?:\s+(?:password|code))?|verification\s+code|security\s+code|credit\s+card|card\s+number|cvv|cvc|social\s+security(?:\s+number)?|ssn|token|secret|api.?key|e-?mail|user\s*name)\b"?(?:\s+field)?\s*(?:with|using|=|is|:|to|should\s+be)\s*(?!@)(?:"[^"\n]+"|[^\s,.;]+)/i.test(authored)) return true;
  if (/\b(?:for|in)\s+(?:the\s+)?"?(?:password|passcode|pin|otp|one[- ]time(?:\s+(?:password|code))?|verification\s+code|security\s+code|credit\s+card|card\s+number|cvv|cvc|social\s+security(?:\s+number)?|ssn|token|secret|api.?key|e-?mail|user\s*name)\b"?(?:\s+field)?\s*[,;:]\s*(?:enter|type|input|use|fill|replace|set|put|paste|provide)\s+(?:code\s+)?(?!@)(?:"[^"\n]+"|'[^'\n]+'|\d[\d -]{2,20}\d|[A-Za-z0-9][A-Za-z0-9._-]{2,})/i.test(authored)) return true;
  if (/\b(?:enter|type|input|use|fill|replace|set|put|paste|provide)\s+(?:code\s+)?(?!@)(?:"[^"\n]+"|'[^'\n]+'|\d[\d -]{2,20}\d|[A-Za-z0-9][A-Za-z0-9._-]{2,})\s+(?:in|into|for|as)\s+(?:the\s+)?"?(?:password|passcode|pass\s*phrase|pin|otp|one[- ]time(?:\s+(?:password|code))?|verification\s+code|security\s+code|credit\s+card|card\s+number|cvv|cvc|social\s+security(?:\s+number)?|ssn|token|secret|api.?key|e-?mail|user\s*name|login(?:\s+(?:id|name))?)\b/i.test(authored)) return true;
  for (const line of authored.split('\n')) {
    if (/\b(?:sign[- ]?in|log[- ]?in|login|authenticate|authentication)\b/i.test(line)) {
      for (const token of line.match(/[A-Za-z0-9][A-Za-z0-9._+@/-]*/g) ?? []) {
        if (!/^(?:sign-in|log-in|one-time)$/i.test(token) && !sensitiveInputTarget(token) && secretShaped(token)) return true;
      }
    }
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
  if (text.split('\n').some(line => line.trim() && !/^(?:Case|Goal|Step|Expect):/i.test(line))) throw new BlockedError('Native cases use one line per Case, Goal, Step, or Expect. Keep free-form prose on a single Goal line.');
  if (negatedNativeAction(text)) throw new BlockedError('Negative native action clauses are ambiguous. Describe only the actions that should run.');
  if (conditionalNativeAction(text)) throw new BlockedError('Conditional native actions need explicit branch semantics. Split the cases or use unconditional Step lines and exact expectations.');
  const authoredLiteral = authoredNativeSteps(text).some(step => step.action === 'fill' && step.value !== null && sensitiveInputTarget(step.target ?? ''));
  const targetFirstLiteral = /"(?:password|passcode|pass\s*phrase|pin|otp|one[- ]time(?:\s+(?:password|code))?|verification\s+code|security\s+code|credit\s+card|card\s+number|cvv|cvc|social\s+security(?:\s+number)?|ssn|token|secret|api.?key|e-?mail|user\s*name)"?\s*(?:with|using|=|is)\s*"/i.test(text);
  const valueFirstLiteral = /\b(?:enter|type|fill|replace)\s+"(?:\\.|[^"\\])+"\s+(?:in|into|for)\s+"?(?:password|passcode|pin|otp|verification\s+code|security\s+code|credit\s+card|card\s+number|cvv|cvc|social\s+security|ssn|token|secret|api.?key|e-?mail|user\s*name)\b/i.test(text);
  if (containsSecret(text, secrets) || privateInputLiteral(text) || authoredLiteral || targetFirstLiteral || valueFirstLiteral) throw new BlockedError('Use @fixture references for private inputs.');
  if (/^Auth:/im.test(text) || /captcha|biometric|face id|touch id|canvas|pixel|looks (?:good|right)/i.test(text) || unsupportedNativeMutation(text)) throw new BlockedError('This native case needs an unsupported capability. Use observed UI actions and exact expectations.');
  if (mode === 'on' && !/^Step:/im.test(text) && unaccountedNativeAction(text)) throw new BlockedError('A freeform native action could not be bound safely. Use explicit Step lines or supported Tap/Fill/Check/Scroll/Back/Relaunch wording.');
  const baseline = parseNative(text, platform);
  if (mode === 'off' || baseline.cases.every(test => !test.blockedReason)) return baseline;
  // Explicit unsupported steps are a user contract, never a request to invent replacements.
  if (/^Step:/im.test(text)) return baseline;
  const blocks = splitCases(text);
  const sourceBlocks = blocks.map(block => {
    const goals = [...block.source.matchAll(/^Goal:\s*(.*)$/gim)];
    if (goals.length !== 1 || !goals[0][1].trim()) throw new BlockedError('Every mobile case needs exactly one authored Goal.');
    return { ...block, goal: goals[0][1], requiredSteps: authoredNativeSteps(block.source), requiredAssertions: block.source.split('\n').filter(line => /^Expect:/i.test(line)).map(line => nativeExpectation(line.replace(/^Expect:\s*/i, ''))) };
  });
  if (sourceBlocks.some(block => !block.requiredAssertions.length)) throw new BlockedError('Add explicit Expect lines. Tests need authored correctness criteria.');
  const suite = validateSuite(await interpret(JSON.stringify({ sourceBlocks }), { inputs: Object.keys(fixtures.inputs), auth: [] }, provider, signal, platform));
  if (suite.version !== 2 || suite.platform !== platform || suite.cases.length !== blocks.length) throw new BlockedError('Planner changed the platform or case count.');
  for (let i = 0; i < blocks.length; i++) {
    const test = suite.cases[i], block = blocks[i];
    if (test.name !== block.name || test.source !== block.source || test.goal !== sourceBlocks[i].goal || test.auth) throw new BlockedError('Planner changed a case identity, goal, or native authentication contract.');
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
  return redactBlockedNativeCases(suite);
}
