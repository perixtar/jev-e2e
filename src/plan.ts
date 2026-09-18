import { createHash } from 'node:crypto';
import { BlockedError, validateSuite, type Assertion, type Fixtures, type Step, type Suite, type Target, type TestCase } from './types.js';
import { interpret, type ProviderOptions } from './providers.js';

const emptyStep = (action: Step['action'], target: string | null = null): Step => ({ action, target, value: null, fixture: null });
const target = (by: Target['by'], text: string, within: string | null = null): Target => ({ by, text, role: null, within });
const quoted = '"((?:\\\\.|[^"\\\\])*)"';
function unquote(value: string): string { try { return JSON.parse(`"${value}"`); } catch { throw new BlockedError('Invalid quoted value; use JSON-style double quotes.'); } }
function input(value: string): { value: string | null; fixture: string | null } {
  if (/^@[A-Za-z0-9_.-]+$/.test(value.trim())) return { value: null, fixture: value.trim().slice(1) };
  try { const parsed = JSON.parse(value.trim()); if (typeof parsed === 'string') return { value: parsed, fixture: null }; } catch { /* Report a single useful format error. */ }
  throw new BlockedError('Input values must be double-quoted strings or @fixture references.');
}

export function splitCases(text: string): { name: string; source: string }[] {
  if (!text.trim() || text.length > 100000) throw new BlockedError('Provide between 1 and 10 cases, up to 100 KB total.');
  const lines = text.trim().split(/\r?\n/);
  const starts = lines.map((line, index) => /^(?:##\s+|Case:\s*|\d+\.\s+)/.test(line) ? index : -1).filter(index => index >= 0);
  if (!starts.length) starts.push(0);
  if (starts[0] !== 0) throw new BlockedError('Start the cases file with a Case: or ## header.');
  if (starts.length > 10) throw new BlockedError('A suite supports at most 10 cases.');
  return starts.map((start, index) => {
    const source = lines.slice(start, starts[index + 1] ?? lines.length).join('\n').trim();
    const name = source.split('\n')[0].replace(/^(?:##\s+|Case:\s*|\d+\.\s+)/, '').trim();
    return { name: name.slice(0, 200) || `Case ${index + 1}`, source };
  });
}

export function parseExpectation(raw: string): { assertion: Assertion; reload: boolean } {
  const reload = /\s+after reload\.?$/i.test(raw);
  const text = raw.replace(/\s+after reload\.?$/i, '').replace(/\.$/, '').trim();
  let match: RegExpMatchArray | null;
  if ((match = text.match(new RegExp(`^project named ${quoted} exists exactly (once|zero times|\\d+ times)$`, 'i')))) {
    const count = match[2].toLowerCase() === 'once' ? 1 : match[2].toLowerCase() === 'zero times' ? 0 : Number.parseInt(match[2]);
    return { assertion: { kind: 'count', target: target('record', unquote(match[1])), expected: count }, reload };
  }
  if ((match = text.match(new RegExp(`^(text|record) ${quoted} (?:count (?:is|equals)|exists exactly) (\\d+)(?: times)?$`, 'i')))) {
    return { assertion: { kind: 'count', target: target(match[1].toLowerCase() === 'record' ? 'record' : 'text', unquote(match[2])), expected: Number(match[3]) }, reload };
  }
  if ((match = text.match(new RegExp(`^text ${quoted}(?: in record ${quoted})? is (visible|absent)$`, 'i')))) {
    const absent = match[3].toLowerCase() === 'absent';
    return { assertion: { kind: absent ? 'absent' : 'visible', target: target('text', unquote(match[1]), match[2] === undefined ? null : `record:${unquote(match[2])}`), expected: !absent }, reload };
  }
  if ((match = text.match(new RegExp(`^field ${quoted} (?:is|equals) ${quoted}$`, 'i')))) {
    return { assertion: { kind: 'value', target: target('label', unquote(match[1])), expected: unquote(match[2]) }, reload };
  }
  if ((match = text.match(new RegExp(`^checkbox ${quoted} is (checked|unchecked)$`, 'i')))) {
    return { assertion: { kind: 'checked', target: target('label', unquote(match[1])), expected: match[2].toLowerCase() === 'checked' }, reload };
  }
  if ((match = text.match(new RegExp(`^url (?:is|equals) ${quoted}$`, 'i')))) {
    return { assertion: { kind: 'url', target: null, expected: unquote(match[1]) }, reload };
  }
  if ((match = text.match(new RegExp(`^number in field ${quoted} (?:is|equals) (-?\\d+(?:\\.\\d+)?)$`, 'i')))) {
    return { assertion: { kind: 'number', target: target('label', unquote(match[1])), expected: Number(match[2]) }, reload };
  }
  throw new BlockedError('Unsupported expectation. Use a documented text, record-count, field, checkbox, numeric-field, or URL template.');
}

function parseStep(text: string): Step {
  if (/^reload$/i.test(text)) return emptyStep('reload');
  let match = text.match(new RegExp(`^(click|check|uncheck) ${quoted}$`, 'i'));
  if (match) return emptyStep(match[1].toLowerCase() as Step['action'], unquote(match[2]));
  match = text.match(new RegExp(`^(fill|select) ${quoted} (?:with|=) (.+)$`, 'i'));
  if (match) return { ...emptyStep(match[1].toLowerCase() as Step['action'], unquote(match[2])), ...input(match[3]) };
  match = text.match(new RegExp(`^wait for text ${quoted}$`, 'i'));
  if (match) return emptyStep('wait', unquote(match[1]));
  throw new BlockedError('Unsupported Step. Use Click, Fill, Select, Check, Uncheck, Reload, or Wait for text.');
}

function inferSteps(goal: string, inputs: Step[]): Step[] {
  let match: RegExpMatchArray | null;
  if (/^(sign in|log in)\b/i.test(goal)) {
    if (!inputs.length) throw new BlockedError('Sign-in cases need Input fixture references for the required credentials.');
    return [...inputs, emptyStep('click', 'Sign in')];
  }
  if ((match = goal.match(new RegExp(`^create (?:a )?project (?:named|called) ${quoted}\\.?$`, 'i')))) {
    const name = unquote(match[1]);
    if (inputs.length && !inputs.some(step => step.value === name)) throw new BlockedError('The project name conflicts with the supplied inputs.');
    return [emptyStep('click', 'New project'), ...(inputs.length ? inputs : [{ ...emptyStep('fill', 'Project name'), value: name }]), emptyStep('click', 'Save project')];
  }
  if (/^create (?:a )?project\b/i.test(goal) && inputs.length) return [emptyStep('click', 'New project'), ...inputs, emptyStep('click', 'Save project')];
  if ((match = goal.match(new RegExp(`^rename project ${quoted} to ${quoted}\\.?$`, 'i')))) return [emptyStep('click', `Rename project ${unquote(match[1])}`), { ...emptyStep('fill', 'Project name'), value: unquote(match[2]) }, emptyStep('click', 'Save project')];
  if ((match = goal.match(new RegExp(`^archive project ${quoted}\\.?$`, 'i')))) return [emptyStep('click', `Archive project ${unquote(match[1])}`)];
  if ((match = goal.match(/^filter projects to (archived|active|all)\.?$/i))) return [{ ...emptyStep('select', 'Status filter'), value: match[1][0].toUpperCase() + match[1].slice(1).toLowerCase() }];
  if ((match = goal.match(new RegExp(`^search projects for ${quoted}\\.?$`, 'i')))) return [{ ...emptyStep('fill', 'Search projects'), value: unquote(match[1]) }];
  if ((match = goal.match(new RegExp(`^set ${quoted} to ${quoted}\\.?$`, 'i')))) return [{ ...emptyStep('select', unquote(match[1])), value: unquote(match[2]) }];
  if ((match = goal.match(new RegExp(`^(check|uncheck) ${quoted}\\.?$`, 'i')))) return [emptyStep(match[1].toLowerCase() as Step['action'], unquote(match[2]))];
  throw new BlockedError('This goal is outside the planner-off templates. Add explicit Step lines or enable the optional planner.');
}

export function parseExplicit(text: string): Suite {
  const cases = splitCases(text).map(({ name, source }): TestCase => {
    const result: TestCase = { name, source, goal: name, auth: null, steps: [], assertions: [], blockedReason: null };
    try {
      const inputs: Step[] = []; let reload = false; let goalCount = 0;
      for (const line of source.split('\n')) {
        if (!line.trim() || /^(##\s|Case:)/.test(line)) continue;
        const field = line.match(/^(Goal|Input|Step|Expect|Auth):\s*(.*)$/i);
        if (!field) throw new BlockedError('Planner-off cases use Case, Goal, Input, Step, Expect, and optional Auth lines.');
        const key = field[1].toLowerCase(); const value = field[2].trim();
        if (key === 'goal') { result.goal = value; goalCount++; }
        else if (key === 'auth') { if (result.auth) throw new BlockedError('Only one Auth fixture is allowed per case.'); result.auth = value.replace(/^@/, ''); }
        else if (key === 'step') result.steps.push(parseStep(value));
        else if (key === 'input') {
          const binding = value.match(/^(?:"([^"]+)"|([^=]+?))\s*=\s*(.+)$/);
          if (!binding) throw new BlockedError('Input format: field name = "literal" or @fixture.');
          inputs.push({ ...emptyStep('fill', (binding[1] ?? binding[2]).trim()), ...input(binding[3]) });
        } else if (key === 'expect') { const parsed = parseExpectation(value); result.assertions.push(parsed.assertion); reload ||= parsed.reload; }
      }
      if (goalCount !== 1 || !result.goal.trim()) throw new BlockedError('Every explicit case needs exactly one Goal.');
      if (!result.assertions.length) throw new BlockedError('Supply explicit expected outcomes; the runner does not invent correctness criteria.');
      if (result.steps.length && inputs.length) throw new BlockedError('Use either Input with an inferred goal, or explicit Fill/Select Step lines.');
      if (!result.steps.length) result.steps = inferSteps(result.goal, inputs);
      if (reload && result.steps.at(-1)?.action !== 'reload') result.steps.push(emptyStep('reload'));
      validateSuite({ version: 1, cases: [result] });
    } catch (error) { result.blockedReason = error instanceof BlockedError ? error.message : 'Could not parse this case.'; result.steps = []; result.assertions = []; }
    return result;
  });
  return validateSuite({ version: 1, cases });
}

export async function compileCases(text: string, mode: 'on' | 'off', fixtures: Fixtures, provider: ProviderOptions, signal: AbortSignal, secrets: string[] = []): Promise<Suite> {
  if (secrets.some(secret => secret && text.includes(secret))) throw new BlockedError('A case contains a secret value. Replace it with a fixture reference before interpretation or execution.');
  if (/(?:Input:\s*(?:"?(?:password|email|secret|token|api.?key)"?)\s*=\s*")|(?:Step:\s*Fill\s*"(?:Password|Email|Secret|Token|API key)"\s*with\s*")|(?:\b(?:password|email)\s+(?:is\s+)?"[^"@]+")/i.test(text)) throw new BlockedError('Credential literals must be replaced with @fixture references.');
  signal.throwIfAborted();
  if (mode === 'off') return parseExplicit(text);
  const blocks = splitCases(text);
  const sourceBlocks = blocks.map(block => {
    const checks = block.source.split('\n').filter(line => /^Expect:/i.test(line)).flatMap(line => { try { return [parseExpectation(line.replace(/^Expect:\s*/i, ''))]; } catch { return []; } });
    const authoredAuth = block.source.split('\n').filter(line => /^Auth:/i.test(line));
    if (authoredAuth.length > 1) throw new BlockedError('Choose one Auth fixture for each case.');
    const authRefs = [...block.source.matchAll(/@([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)/g)].map(match => match[1]).filter(ref => Object.hasOwn(fixtures.auth, ref));
    if (!authoredAuth.length && new Set(authRefs).size > 1) throw new BlockedError('Choose one Auth fixture with an Auth line.');
    const requiredAuth = authoredAuth.length ? authoredAuth[0].replace(/^Auth:\s*@?/i, '').trim() : authRefs[0] ?? null;
    return { ...block, requiredAssertions: checks.map(check => check.assertion), requiredReload: checks.some(check => check.reload), requiredAuth };
  });
  const raw = await interpret(JSON.stringify({ sourceBlocks }), { inputs: Object.keys(fixtures.inputs), auth: Object.keys(fixtures.auth) }, provider, signal);
  const suite = validateSuite(raw);
  if (suite.cases.length !== blocks.length) throw new BlockedError('Planner changed the number of cases. No browser was started.');
  for (let index = 0; index < blocks.length; index++) {
    const test = suite.cases[index]; const original = blocks[index];
    // Auth is caller-owned setup, never an inference the planner may invent.
    test.auth = sourceBlocks[index].requiredAuth;
    if (test.source !== original.source || test.name !== original.name) throw new BlockedError('Planner changed a case identity or its original source.');
    if (test.blockedReason) continue;
    const refs = [...original.source.matchAll(/@([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)/g)].map(match => match[1]);
    for (const ref of refs) if (!test.steps.some(step => step.fixture === ref) && test.auth !== ref) throw new BlockedError('Planner dropped or substituted a fixture reference.');
    const baseline = parseExplicit(original.source).cases[0];
    if (!baseline.blockedReason) {
      for (const binding of baseline.steps.filter(step => step.action === 'fill' || step.action === 'select')) {
        if (!test.steps.some(step => step.action === binding.action && step.target?.trim().toLowerCase() === binding.target?.trim().toLowerCase() && step.value === binding.value && step.fixture === binding.fixture)) throw new BlockedError('Planner changed or dropped a required input binding.');
      }
      if (/^Step:/im.test(original.source) && JSON.stringify(test.steps) !== JSON.stringify(baseline.steps)) throw new BlockedError('Planner changed an explicit action sequence.');
    }
    const intent = JSON.stringify({ steps: test.steps, assertions: test.assertions, auth: test.auth });
    for (const literal of original.source.matchAll(/"((?:\\.|[^"\\])*)"/g)) {
      const value = unquote(literal[1]);
      if (value && !intent.includes(JSON.stringify(value).slice(1, -1))) throw new BlockedError('Planner dropped or changed a supplied literal.');
    }
    const expectations = original.source.split('\n').filter(line => /^Expect:/i.test(line));
    for (const line of expectations) {
      let expected: ReturnType<typeof parseExpectation>;
      try { expected = parseExpectation(line.replace(/^Expect:\s*/i, '')); } catch { continue; }
      if (!test.assertions.some(assertion => JSON.stringify(assertion) === JSON.stringify(expected.assertion))) throw new BlockedError('Planner altered or dropped a supported explicit expectation.');
      if (expected.reload && !test.steps.some(step => step.action === 'reload')) throw new BlockedError('Planner omitted required persistence verification.');
    }
    if (/\b(invalid|wrong)\b.*\b(password|credentials)\b/i.test(original.source) && !/invalid|wrong/i.test(test.goal)) throw new BlockedError('Planner lost the negative test intent.');
  }
  return suite;
}

export function planHash(plan: Suite): string { return createHash('sha256').update(JSON.stringify(plan)).digest('hex'); }
