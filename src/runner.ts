import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { readFile, mkdir, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { validUrl, secretValues, sanitize, containsSecret } from './config.js';
import { compileCases, planHash, splitCases } from './plan.js';
import { decide, type ProviderOptions } from './providers.js';
import { observe, execute, disposeObservation, replayControl, savedControl, maskedScreenshot } from './browser.js';
import { checkAssertion, assertionLocator } from './assertions.js';
import { writeReport } from './report.js';
import { BlockedError, validateSuite, type Fixtures, type Suite, type SuiteResult, type CaseResult, type Snapshot, type Step, type Selection, type Progress, type FlowAction, type NativeTarget } from './types.js';

export const FlowSchema = z.object({ step: z.number().int().nonnegative(), navigation: z.boolean(), control: z.object({ tag: z.string().max(30), role: z.string().max(30), label: z.string().max(240), context: z.string().max(600), type: z.string().max(40), identifier: z.string().max(300).optional() }).strict().nullable() }).strict();
const NativeTargetSchema = z.object({ platform: z.enum(['ios', 'android']), app: z.string().min(1).max(1000), device: z.string().max(300), baseline: z.literal('preserve') }).strict();
export type SavedPlan = { version: 1 | 2; plan: Suite; hash: string; flows: (FlowAction[] | null)[]; target?: NativeTarget };
export function savedHash(plan: Suite, target?: NativeTarget, flows?: (FlowAction[] | null)[]): string { return target ? createHash('sha256').update(JSON.stringify({ plan, target, flows: flows ?? plan.cases.map(() => null) })).digest('hex') : planHash(plan); }
export async function readSavedPlan(path: string): Promise<SavedPlan> {
  const raw = JSON.parse(await readFile(resolve(path), 'utf8'));
  const plan = validateSuite(raw.plan ?? raw);
  if (!raw.plan) { if (plan.version !== 1) throw new BlockedError('Native saved plans must include their app/platform baseline.'); return { version: 1, plan, hash: planHash(plan), flows: plan.cases.map(() => null) }; }
  const target = raw.version === 2 ? NativeTargetSchema.parse(raw.target) : undefined;
  if (raw.version !== plan.version || target && (plan.version !== 2 || target.platform !== plan.platform) || raw.hash !== savedHash(plan, target, raw.flows) || !Array.isArray(raw.flows) || raw.flows.length !== plan.cases.length) throw new BlockedError('Saved plan integrity/schema check failed. Recompile the source cases.');
  const flows = raw.flows.map((flow: unknown, index: number) => {
    if (flow === null) return null;
    const result = z.array(FlowSchema).max(100).safeParse(flow);
    if (!result.success || result.data.some(action => action.step >= plan.cases[index].steps.length)) throw new BlockedError('Saved flow is invalid.');
    return result.data;
  });
  return { version: raw.version, plan, hash: raw.hash, flows, ...(target ? { target } : {}) };
}

export type RunOptions = {
  url?: string; platform?: 'web' | 'ios' | 'android'; app?: string; device?: string; record?: boolean;
  casesText?: string; plan?: Suite; replay?: SavedPlan; savedTarget?: NativeTarget;
  planner?: 'on' | 'off'; fixtures?: Fixtures; apiKey?: string; plannerModel?: string; jevModel?: string;
  headed?: boolean; outputDirectory?: string | false; signal?: AbortSignal;
  timeoutMs?: number; assertionTimeoutMs?: number; maxActions?: number; maxRequests?: number; maxCost?: number;
  allowedOrigins?: string[]; onProgress?: (event: Progress) => void;
  decide?: (snapshot: Snapshot, step: Step, signal: AbortSignal) => Promise<Selection>;
  fetchImpl?: typeof fetch; beforeCase?: (index: number) => Promise<void>;
};

export function providerOptions(options: RunOptions): ProviderOptions {
  return {
    apiKey: options.apiKey ?? process.env.OPENROUTER_API_KEY ?? '',
    plannerModel: options.plannerModel ?? (process.env.OPENROUTER_PLANNER_MODEL?.trim() || 'openai/gpt-4.1-mini'),
    jevModel: options.jevModel ?? (process.env.OPENROUTER_JEV_MODEL?.trim() || 'typesafe/jev-1.13'),
    maxCost: options.maxCost ?? 0.05, maxRequests: options.maxRequests ?? 100,
    stats: { requests: 0, plannerRequests: 0, jevRequests: 0, cost: 0, models: [] }, fetchImpl: options.fetchImpl,
  };
}

export async function runSuite(options: RunOptions): Promise<SuiteResult> {
  if (options.platform === 'ios' || options.platform === 'android' || options.replay?.version === 2 || options.plan?.version === 2) {
    const { runMobileSuite } = await import('./mobile-runner.js'); return runMobileSuite(options);
  }
  if (options.app || options.device || options.record) throw new BlockedError('--app, --device, and --record require --platform ios or android.');
  const start = Date.now(); const id = randomUUID(); const startedAt = new Date(start).toISOString();
  const url = validUrl(options.url ?? ''); const origins = new Set([new URL(url).origin, ...(options.allowedOrigins ?? []).map(value => new URL(validUrl(value)).origin)]);
  const fixtures = options.fixtures ?? { inputs: {}, auth: {} }; const secrets = [...secretValues(fixtures), ...(options.apiKey ? [options.apiKey] : [])];
  const fixtureSecrets = secretValues(fixtures, {});
  const suiteController = new AbortController(); const abort = () => suiteController.abort();
  const signal = suiteController.signal; const provider = providerOptions(options);
  if (!Number.isFinite(provider.maxCost) || provider.maxCost <= 0 || !Number.isInteger(provider.maxRequests) || provider.maxRequests < 1) throw new BlockedError('Budget and request limits must be positive.');
  const timeoutMs = options.timeoutMs ?? 60000; const maxActions = options.maxActions ?? 30;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000 || !Number.isInteger(maxActions) || maxActions < 1 || maxActions > 100) throw new BlockedError('Invalid case timeout or action limit.');
  options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort();
  const progress = (event: Progress) => options.onProgress?.(sanitize(event, secrets));
  let browser: Browser | undefined; let plan: Suite; let context: BrowserContext | undefined;
  const closeOnAbort = () => { void context?.close().catch(() => {}); };
  signal.addEventListener('abort', closeOnAbort);
  const directory = options.outputDirectory === false ? null : resolve(options.outputDirectory ?? join('.jev-e2e', 'runs', id));
  try {
    progress({ type: 'planning', message: options.plan || options.replay ? 'Validating saved test specification.' : 'Preparing cases and explicit expectations.' });
    const planningController = new AbortController(); const stopPlanning = () => planningController.abort();
    const planningTimer = setTimeout(stopPlanning, Math.min(timeoutMs, 30000));
    signal.addEventListener('abort', stopPlanning, { once: true }); if (signal.aborted) stopPlanning();
    try {
      plan = options.replay ? validateSuite(options.replay.plan) : options.plan ? validateSuite(options.plan) : await compileCases(options.casesText ?? '', options.planner ?? (process.env.JEV_E2E_PLANNER === 'off' ? 'off' : 'on'), fixtures, provider, planningController.signal, secrets);
      if (plan.version !== 1) throw new BlockedError('Web runs require a version-1 browser plan.');
      if (options.replay && (options.replay.version !== 1 || options.replay.hash !== planHash(plan) || options.replay.flows.length !== plan.cases.length || options.replay.flows.some(flow => flow !== null && !z.array(FlowSchema).max(100).safeParse(flow).success))) throw new BlockedError('Saved plan integrity/schema check failed.');
      if (containsSecret(plan, secrets)) throw new BlockedError('The plan contains a secret literal; use fixture references.');
    } catch (error) {
      const reason = signal.aborted ? 'Run canceled.' : planningController.signal.aborted ? 'Planning deadline reached.' : error instanceof BlockedError ? error.message : 'Could not compile or validate the cases.';
      let blocks: ReturnType<typeof splitCases>; try { blocks = splitCases(options.casesText ?? ''); } catch { blocks = [{ name: 'Invalid suite', source: '' }]; }
      if (reason === 'Credential literals must be replaced with @fixture references.') blocks = blocks.map((_, index) => ({ name: `Blocked private case ${index + 1}`, source: '[PRIVATE INPUT REDACTED]' }));
      plan = { version: 1, cases: blocks.map(block => ({ ...block, goal: block.name, auth: null, steps: [], assertions: [], blockedReason: reason })) };
    } finally { clearTimeout(planningTimer); signal.removeEventListener('abort', stopPlanning); }
    if (directory) await mkdir(directory, { recursive: true, mode: 0o700 });
    const results: CaseResult[] = [];
    for (let index = 0; index < plan.cases.length; index++) {
      const test = plan.cases[index]; const caseStart = Date.now();
      const result: CaseResult = { name: test.name, goal: test.goal, verdict: 'BLOCKED', reason: '', checks: [], actions: [], durationMs: 0, screenshot: null, flow: [] };
      const caseController = new AbortController(); const stopCase = () => caseController.abort();
      signal.addEventListener('abort', stopCase, { once: true }); if (signal.aborted) stopCase();
      const caseSignal = caseController.signal; const timer = setTimeout(stopCase, timeoutMs); let page: Page | undefined;
      const closeCase = () => { void context?.close().catch(() => {}); }; caseSignal.addEventListener('abort', closeCase, { once: true });
      let navigationError: string | null = null;
      try {
        caseSignal.throwIfAborted();
        if (test.blockedReason) throw new BlockedError(test.blockedReason);
        const values = test.steps.map(step => {
          if (!step.fixture) return step.value;
          const value = Object.hasOwn(fixtures.inputs, step.fixture) ? fixtures.inputs[step.fixture]?.value : undefined;
          if (value === undefined) throw new BlockedError(`Missing input fixture: ${step.fixture}.`);
          return value;
        });
        const auth = test.auth && Object.hasOwn(fixtures.auth, test.auth) ? fixtures.auth[test.auth] : undefined;
        if (test.auth && !auth) throw new BlockedError(`Missing auth fixture: ${test.auth}.`);
        if (auth) JSON.parse(await readFile(auth.storageState, 'utf8'));
        await options.beforeCase?.(index); caseSignal.throwIfAborted();
        if (!browser) {
          try { browser = await chromium.launch({ headless: !options.headed }); }
          catch { throw new BlockedError('Chromium could not start. Run "jev-e2e setup" to install the browser.'); }
        }
        caseSignal.throwIfAborted();
        context = await browser.newContext({ viewport: { width: 1280, height: 800 }, storageState: auth?.storageState, serviceWorkers: 'block' });
        progress({ type: 'context.opened', message: 'Created a fresh browser context.', caseName: test.name });
        page = await context.newPage(); const ownedPage = page;
        context.on('page', popup => { if (popup !== ownedPage) { navigationError = 'Popup tabs are outside this release scope.'; void popup.close().catch(() => {}); } });
        await context.route('**/*', async route => {
          if (route.request().isNavigationRequest() && route.request().frame() === ownedPage.mainFrame() && !origins.has(new URL(route.request().url()).origin)) {
            navigationError = 'Navigation outside the configured app origins was blocked.'; await route.abort();
          } else await route.continue();
        });
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(10000, timeoutMs) });
        await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => {}); caseSignal.throwIfAborted();
        let flowIndex = 0; const cached = options.replay?.flows[index] ?? [];
        for (let stepIndex = 0; stepIndex < test.steps.length; stepIndex++) {
          const step = test.steps[stepIndex]; let complete = false; let attempts = 0;
          while (!complete) {
            caseSignal.throwIfAborted(); if (navigationError) throw new BlockedError(navigationError);
            if (result.actions.length >= maxActions || attempts++ >= 10) throw new BlockedError('Action or navigation limit reached before the required flow completed.');
            progress({ type: 'step', message: `${step.action} ${step.target ?? 'page'}`, caseName: test.name, step: stepIndex + 1 });
            if (step.action === 'reload') {
              await page.reload({ waitUntil: 'domcontentloaded', timeout: 5000 }); caseSignal.throwIfAborted();
              result.actions.push({ step: stepIndex, action: 'reload', target: 'page', replay: Boolean(cached.length) });
              result.flow.push({ step: stepIndex, navigation: false, control: null }); complete = true; continue;
            }
            if (step.action === 'wait') {
              await assertionLocator(page, { by: 'text', text: step.target!, role: null, within: null }).first().waitFor({ state: 'visible', timeout: 5000 });
              caseSignal.throwIfAborted(); result.actions.push({ step: stepIndex, action: 'wait', target: step.target!, replay: Boolean(cached.length) });
              result.flow.push({ step: stepIndex, navigation: false, control: null }); complete = true; continue;
            }
            const observation = await observe(page, secrets);
            try {
              let control; let navigation = false; let replay = false;
              while (cached[flowIndex] && cached[flowIndex].step < stepIndex) flowIndex++;
              const saved = cached[flowIndex]?.step === stepIndex ? cached[flowIndex] : undefined;
              if (saved) { control = replayControl(saved, observation); navigation = saved.navigation; replay = Boolean(control); flowIndex++; }
              if (!control) {
                const selection = options.decide ? await options.decide(observation, step, caseSignal) : await decide(observation, step, provider, caseSignal);
                caseSignal.throwIfAborted();
                if (selection.target === 'none') {
                  if (selection.navigation === 'wait') { await delay(200, undefined, { signal: caseSignal }); continue; }
                  if (selection.navigation === 'blocked') throw new BlockedError(`No observed control could perform or reveal: ${step.target}.`);
                  control = observation.controls.find(control => control.id === selection.navigation); navigation = true;
                } else control = observation.controls.find(control => control.id === selection.target);
              }
              if (!control || control.disabled) throw new BlockedError('Decision referenced an unavailable control.');
              if (!navigation && (step.action === 'select' && control.tag !== 'select' || ['check', 'uncheck'].includes(step.action) && control.type !== 'checkbox' || step.action === 'fill' && (!['input', 'textarea'].includes(control.tag) || ['checkbox', 'radio', 'submit', 'button', 'file'].includes(control.type)) || step.action === 'click' && !['button', 'link'].includes(control.role))) throw new BlockedError('Decision referenced a control incompatible with the required action.');
              if (navigation && (!['button', 'link'].includes(control.role) || /delete|remove|pay|purchase|archive|save|submit|sign in|log in|sign out/i.test(control.label))) throw new BlockedError('Decision attempted an unsafe or incompatible navigation action.');
              const action = navigation ? { action: 'click' as const, target: control.label, value: null, fixture: null } : step;
              result.actions.push({ step: stepIndex, action: action.action, target: control.label, replay });
              await execute(page, observation, control, action, navigation ? null : values[stepIndex], caseSignal, origins);
              await page.waitForLoadState('networkidle', { timeout: 1500 }).catch(() => {}); caseSignal.throwIfAborted();
              result.flow.push({ step: stepIndex, navigation, control: savedControl(control) });
              complete = !navigation;
            } finally { await disposeObservation(observation); }
          }
        }
        if (navigationError) throw new BlockedError(navigationError);
        for (const assertion of test.assertions) {
          result.checks.push(await checkAssertion(page, assertion, caseSignal, options.assertionTimeoutMs ?? 2000));
          caseSignal.throwIfAborted(); if (navigationError) throw new BlockedError(navigationError);
        }
        result.verdict = result.checks.length === test.assertions.length && result.checks.every(check => check.passed) ? 'PASS' : 'FAIL';
        result.reason = result.verdict === 'PASS' ? 'All required actions and expectations were checked.' : 'One or more required expectations did not hold.';
      } catch (error) {
        result.verdict = 'BLOCKED';
        result.reason = signal.aborted ? 'Run canceled.' : caseSignal.aborted ? 'Case deadline reached.' : error instanceof BlockedError ? error.message : 'Execution or verification could not complete with reliable evidence.';
      } finally {
        clearTimeout(timer); signal.removeEventListener('abort', stopCase); caseSignal.removeEventListener('abort', closeCase);
        if (page && directory && !page.isClosed() && !caseSignal.aborted) {
          try { const filename = `${index + 1}.png`; await maskedScreenshot(page, fixtureSecrets, join(directory, filename)); await chmod(join(directory, filename), 0o600); result.screenshot = filename; } catch { /* A screenshot failure cannot turn an unchecked case into PASS. */ }
        }
        if (context) { await context.close().catch(() => {}); context = undefined; progress({ type: 'context.closed', message: 'Closed the owned browser context.', caseName: test.name }); }
        result.durationMs = Date.now() - caseStart; results.push(result);
        progress({ type: 'result', message: `${result.verdict}: ${result.reason}`, caseName: test.name });
      }
    }
    const publicUrl = new URL(url);
    const result: SuiteResult = sanitize({ version: 1, id, startedAt, url: `${publicUrl.origin}${publicUrl.pathname}`, verdict: signal.aborted || results.some(test => test.verdict === 'BLOCKED') ? 'BLOCKED' : results.every(test => test.verdict === 'PASS') ? 'PASS' : 'FAIL', canceled: signal.aborted, cases: results, durationMs: Date.now() - start, model: provider.stats, plan, reportDirectory: directory }, secrets);
    if (directory) await writeReport(result, directory);
    return result;
  } finally {
    options.signal?.removeEventListener('abort', abort); signal.removeEventListener('abort', closeOnAbort);
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}
