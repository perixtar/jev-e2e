import { z } from 'zod';

export const TargetSchema = z.object({
  by: z.enum(['text', 'label', 'record', 'role', 'id']),
  text: z.string().min(1).max(300),
  role: z.enum(['button', 'link', 'heading', 'alert', 'status', 'row', 'listitem', 'region', 'textbox', 'checkbox', 'combobox']).nullable(),
  within: z.string().min(1).max(200).nullable(),
}).strict();
export const StepSchema = z.object({
  action: z.enum(['click', 'fill', 'select', 'check', 'uncheck', 'reload', 'wait', 'relaunch', 'back', 'keyboard', 'scroll']),
  target: z.string().max(300).nullable().describe('Plain-language control purpose, e.g. Sign in, Project name, Rename project Demo. Never CSS, selector syntax, or role:/label:/record: prefixes.'),
  value: z.string().max(2000).nullable().describe('Exact supplied input or option label, e.g. Archived or Dark. Never add descriptions, aliases, or parenthetical annotations. Null when using a fixture.'),
  fixture: z.string().max(150).nullable(),
}).strict();
export const AssertionSchema = z.object({
  kind: z.enum(['visible', 'absent', 'count', 'value', 'checked', 'url', 'number']),
  target: TargetSchema.nullable(),
  expected: z.union([z.string().max(2000), z.number().finite(), z.boolean()]),
  afterStep: z.number().int().nonnegative().optional().describe('Native milestone: check immediately after this zero-based action, before navigating away.'),
}).strict();
export const CaseSchema = z.object({
  name: z.string().min(1).max(200),
  source: z.string().max(20000),
  goal: z.string().min(1).max(4000),
  auth: z.string().max(150).nullable(),
  steps: z.array(StepSchema).max(30),
  assertions: z.array(AssertionSchema).max(30),
  blockedReason: z.string().max(2000).nullable(),
}).strict();
export const WebSuiteSchema = z.object({
  version: z.literal(1),
  cases: z.array(CaseSchema).min(1).max(10),
}).strict();
export const NativeSuiteSchema = z.object({
  version: z.literal(2),
  platform: z.enum(['ios', 'android']),
  cases: z.array(CaseSchema).min(1).max(10),
}).strict();
export const SuiteSchema = z.discriminatedUnion('version', [WebSuiteSchema, NativeSuiteSchema]);
export type Target = z.infer<typeof TargetSchema>;
export type Step = z.infer<typeof StepSchema>;
export type Assertion = z.infer<typeof AssertionSchema>;
export type TestCase = z.infer<typeof CaseSchema>;
export type Suite = z.infer<typeof SuiteSchema>;
export type Verdict = 'PASS' | 'FAIL' | 'BLOCKED';
export type Fixtures = {
  inputs: Record<string, { env?: string; value?: string }>;
  auth: Record<string, { storageState: string }>;
};
export type Control = {
  id: string; tag: string; role: string; label: string; context: string;
  type: string; disabled: boolean; checked: boolean | null;
  options: string[]; fingerprint: string;
  capabilities?: Step['action'][]; identifier?: string;
};
export type Snapshot = { url: string; text: string; controls: Control[] };
export type Selection = { target: string; navigation: string };
export type FlowAction = { step: number; navigation: boolean; control: Omit<Control, 'id' | 'fingerprint' | 'disabled' | 'checked' | 'options'> | null };
export type CheckResult = { assertion: Assertion; passed: boolean; observed: string | number | boolean | null; reason?: string };
export type CaseResult = {
  name: string; goal: string; verdict: Verdict; reason: string;
  checks: CheckResult[]; actions: { step: number; action: string; target: string; replay: boolean }[];
  durationMs: number; screenshot: string | null; flow: FlowAction[];
  video?: string | null;
  videoMetadata?: { durationMs: number; capturedDurationMs?: number; backend?: string };
  evidenceNotes?: string[];
};
export type ModelStats = { requests: number; plannerRequests: number; jevRequests: number; cost: number; models: string[] };
export type NativeTarget = { platform: 'ios' | 'android'; app: string; device: string; baseline: 'preserve' };
export type SuiteResult = {
  version: 1 | 2; id: string; startedAt: string; url: string; verdict: Verdict;
  canceled: boolean; cases: CaseResult[]; durationMs: number; model: ModelStats;
  plan: Suite; reportDirectory: string | null;
  target?: NativeTarget;
  versions?: Record<string, string>;
  timings?: Record<string, number>;
};
export type Progress = { type: string; message: string; caseName?: string; step?: number; screenshot?: string; elapsedMs?: number; cost?: number };

export class BlockedError extends Error { constructor(message: string) { super(message); this.name = 'BlockedError'; } }

export function validateSuite(input: unknown): Suite {
  const parsed = SuiteSchema.safeParse(input);
  if (!parsed.success) throw new BlockedError('Invalid test specification. Recompile the cases or check the saved plan schema.');
  for (const test of parsed.data.cases) {
    if (test.blockedReason) continue;
    if (!test.steps.length || !test.assertions.length) throw new BlockedError(`Case "${test.name}" needs actions and explicit expectations.`);
    if (parsed.data.version === 2 && test.auth) throw new BlockedError('Native apps cannot use browser Auth storageState. Sign in with input fixtures.');
    for (const step of test.steps) {
      if (!['reload', 'relaunch', 'back', 'keyboard'].includes(step.action) && !step.target?.trim()) throw new BlockedError(`Case "${test.name}" has an action without a target.`);
      if (parsed.data.version === 1 && ['relaunch', 'back', 'keyboard', 'scroll'].includes(step.action)) throw new BlockedError('Native actions require a version-2 mobile plan.');
      if (parsed.data.version === 2 && ['reload', 'select'].includes(step.action)) throw new BlockedError('Native apps use Relaunch and observed option buttons. Web Reload/Select are unsupported.');
      if (step.action === 'scroll' && !['up', 'down', 'left', 'right'].includes(step.target ?? '')) throw new BlockedError('Scroll direction must be up, down, left, or right. Each step scrolls once.');
      if (['fill', 'select'].includes(step.action) && ((step.value === null) === (step.fixture === null))) throw new BlockedError('Each input needs exactly one literal value or fixture reference.');
      if (!['fill', 'select'].includes(step.action) && (step.value !== null || step.fixture !== null)) throw new BlockedError('Only fill/select actions accept input values.');
      if (step.value !== null && /password|secret|token|api.?key|email/i.test(step.target ?? '')) throw new BlockedError('Use a fixture reference for credential inputs so their values stay out of model prompts and reports.');
    }
    for (const assertion of test.assertions) {
      if (parsed.data.version === 1 && (assertion.afterStep !== undefined || assertion.target?.by === 'id')) throw new BlockedError('Native milestones/identifiers require a version-2 plan.');
      if (parsed.data.version === 2 && assertion.kind === 'url') throw new BlockedError('Native apps do not expose a browser URL. Check an observed screen label instead.');
      if (assertion.afterStep !== undefined && assertion.afterStep >= test.steps.length) throw new BlockedError('Milestone points outside the required action sequence.');
      if (assertion.kind !== 'url' && !assertion.target) throw new BlockedError('Each page assertion needs a target.');
      if (assertion.target?.by === 'role' && !assertion.target.role) throw new BlockedError('A role assertion needs an explicit role.');
      if (['visible', 'absent', 'checked'].includes(assertion.kind) && typeof assertion.expected !== 'boolean') throw new BlockedError('Visibility and checkbox expectations must be booleans.');
      if (assertion.kind === 'visible' && assertion.expected !== true || assertion.kind === 'absent' && assertion.expected !== false) throw new BlockedError('Visible requires true; absent requires false.');
      if (['count', 'number'].includes(assertion.kind) && typeof assertion.expected !== 'number') throw new BlockedError('Count and numeric expectations must be numbers.');
      if (assertion.kind === 'count' && (!Number.isInteger(assertion.expected) || Number(assertion.expected) < 0)) throw new BlockedError('Counts must be nonnegative integers.');
      if (['value', 'url'].includes(assertion.kind) && typeof assertion.expected !== 'string') throw new BlockedError('Value and URL expectations must be strings.');
    }
  }
  return parsed.data;
}
