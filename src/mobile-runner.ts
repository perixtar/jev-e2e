import { randomUUID } from 'node:crypto';
import { mkdir, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { providerOptions, savedHash, FlowSchema, type RunOptions } from './runner.js';
import { compileNative } from './mobile-plan.js';
import { splitCases } from './plan.js';
import { MobileDriver, nativeVersions } from './mobile.js';
import { decide } from './providers.js';
import { secretValues, sanitize, containsSecret } from './config.js';
import { writeReport } from './report.js';
import { BlockedError, sensitiveInputTarget, unsupportedNativeMutation, validateSuite, type Suite, type CaseResult, type SuiteResult, type Control, type Progress, type NativeTarget } from './types.js';

const semantic = ({ tag, role, label, context, type, identifier }: Control) => ({ tag, role, label, context, type, ...(identifier ? { identifier } : {}) });
export async function runMobileSuite(options: RunOptions): Promise<SuiteResult> {
  const start = Date.now(), id = randomUUID(), provider = providerOptions(options);
  const saved = options.replay, platform = options.platform ?? saved?.target?.platform ?? (options.plan?.version === 2 ? options.plan.platform : undefined);
  if (platform !== 'ios' && platform !== 'android') throw new BlockedError('Choose --platform ios or android.');
  if (options.url || options.allowedOrigins?.length || options.headed) throw new BlockedError('Mobile runs use --app and --device. --url, --headed, and --allow-origin are browser options.');
  const target: NativeTarget = { platform, app: options.app ?? saved?.target?.app ?? '', device: options.device ?? saved?.target?.device ?? '', baseline: 'preserve' };
  if (options.savedTarget && (options.savedTarget.app !== target.app || options.savedTarget.platform !== platform || options.savedTarget.baseline !== target.baseline)) throw new BlockedError('Saved mobile specification belongs to a different app/platform baseline.');
  if (!target.app.trim()) throw new BlockedError('Provide --app with an installed bundle/package ID or simulator .app / emulator .apk build.');
  if (platform === 'ios' && process.platform !== 'darwin') throw new BlockedError('iOS Simulator requires macOS and Xcode.');
  if (saved && (saved.version !== 2 || !saved.target || saved.plan.version !== 2 || saved.hash !== savedHash(saved.plan, saved.target, saved.flows) || saved.flows.length !== saved.plan.cases.length || saved.flows.some((flow, index) => flow !== null && (!z.array(FlowSchema).max(100).safeParse(flow).success || flow.some(action => action.step >= saved.plan.cases[index].steps.length))) || saved.target.platform !== platform || saved.target.app !== target.app)) throw new BlockedError('Saved mobile plan does not match this app/platform, or its integrity check failed.');
  const timeout = options.timeoutMs ?? 60000, maxActions = options.maxActions ?? 30;
  if (!Number.isFinite(provider.maxCost) || provider.maxCost <= 0 || !Number.isInteger(provider.maxRequests) || provider.maxRequests < 1 || !Number.isInteger(maxActions) || maxActions < 1 || maxActions > 100 || !Number.isFinite(timeout) || timeout < 100 || timeout > 300000) throw new BlockedError('Budgets/limits must be positive; timeout 100–300000 ms, actions 1–100.');
  const fixtures = options.fixtures ?? { inputs: {}, auth: {} }, secrets = [...secretValues(fixtures), ...(options.apiKey ? [options.apiKey] : [])];
  const signal = options.signal ?? new AbortController().signal;
  const directory = options.outputDirectory === false ? null : resolve(options.outputDirectory ?? join('.jev-e2e', 'runs', id));
  const timings: Record<string, number> = { planning: 0, setup: 0, observation: 0, model: 0, action: 0, check: 0, artifact: 0, cleanup: 0 };
  const timed = async <T>(key: string, fn: () => Promise<T>) => { const t = Date.now(); try { return await fn(); } finally { timings[key] += Date.now() - t; } };
  const progress = (event: Progress) => options.onProgress?.(sanitize({ ...event, elapsedMs: Date.now() - start, cost: provider.stats.cost }, secrets));
  let plan: Suite, versions: Record<string, string> = { backend: 'agent-device@0.21.6', node: process.version };
  progress({ type: 'planning', message: 'Preparing mobile actions and milestone checks.' });
  const planningSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.min(timeout, 30000))]);
  try {
    plan = await timed('planning', async () => saved ? validateSuite(saved.plan) : options.plan ? validateSuite(options.plan) : compileNative(options.casesText ?? '', platform, options.planner ?? 'on', fixtures, provider, planningSignal, secrets));
    if (plan.version !== 2 || plan.platform !== platform || containsSecret(plan, secrets)) throw new BlockedError('Mobile plan platform mismatch or secret literal.');
    planningSignal.throwIfAborted();
  } catch (e) {
    const reason = signal.aborted ? 'Run canceled.' : planningSignal.aborted ? 'Planning deadline reached.' : e instanceof BlockedError ? e.message : 'Could not compile a reliable mobile contract.';
    let blocks; try { blocks = splitCases(options.casesText ?? ''); } catch { blocks = [{ name: 'Invalid suite', source: '' }]; }
    plan = { version: 2, platform, cases: blocks.map(block => ({ ...block, goal: block.name, auth: null, steps: [], assertions: [], blockedReason: reason })) };
  }
  if (directory) { await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700); }
  const results: CaseResult[] = [];
  for (let i = 0; i < plan.cases.length; i++) {
    const test = plan.cases[i], caseStart = Date.now(), driver = new MobileDriver({ ...target }, secrets);
    const controller = new AbortController(), stop = () => { controller.abort(); driver.interrupt(); };
    signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop();
    const timer = setTimeout(stop, timeout), caseSignal = controller.signal;
    const result: CaseResult = { name: test.name, goal: test.goal, verdict: 'BLOCKED', reason: '', checks: [], actions: [], durationMs: 0, screenshot: null, video: null, flow: [] };
    let recordingStarted = false;
    try {
      caseSignal.throwIfAborted();
      if (test.blockedReason) throw new BlockedError(test.blockedReason);
      const values = test.steps.map(step => { if (!step.fixture) return step.value; const value = fixtures.inputs[step.fixture]?.value; if (value === undefined) throw new BlockedError(`Missing input fixture: ${step.fixture}.`); return value; });
      await options.beforeCase?.(i); caseSignal.throwIfAborted();
      await timed('setup', () => driver.open(caseSignal));
      target.device = driver.target.device; versions = await nativeVersions({ ...target, app: driver.resolvedApp }, caseSignal);
      progress({ type: 'context.opened', message: `Opened ${platform} app on ${target.device}; data is preserved.`, caseName: test.name });
      const lastPrivate = test.steps.reduce((last, step, index) => step.fixture || sensitiveInputTarget(step.target ?? '') ? index : last, -1);
      let cacheIndex = 0;
      const cached = saved?.flows[i] ?? [];
      for (let stepIndex = 0; stepIndex < test.steps.length; stepIndex++) {
        const step = test.steps[stepIndex]; let complete = false, attempts = 0;
        // Start recording only once the credential-entry segment has ended and
        // the current full screen contains no private fields/known values.
        if (options.record && directory && !recordingStarted && stepIndex > lastPrivate) {
          const state = await timed('observation', () => driver.observe(caseSignal));
          if (driver.captureAllowed(state.native)) {
            await timed('artifact', () => driver.startRecording(join(directory, `${i + 1}.mp4`), caseSignal)); recordingStarted = true;
          }
        }
        while (!complete) {
          caseSignal.throwIfAborted();
          if (result.actions.length >= maxActions || attempts++ >= 10) throw new BlockedError('Action/navigation limit reached before the required mobile flow completed.');
          progress({ type: 'step', message: `${step.action === 'click' ? 'tap' : step.action} ${step.target ?? 'app'}`, caseName: test.name, step: stepIndex + 1 });
          if (['relaunch', 'back', 'keyboard', 'scroll', 'wait'].includes(step.action)) {
            result.actions.push({ step: stepIndex, action: step.action, target: step.target ?? 'app', replay: Boolean(saved) });
            await timed('action', () => driver.direct(step, caseSignal)); result.flow.push({ step: stepIndex, navigation: false, control: null }); complete = true; continue;
          }
          const observation = await timed('observation', () => driver.observe(caseSignal));
          let control: Control | undefined, navigation = false, replay = false;
          while (cached[cacheIndex] && cached[cacheIndex].step < stepIndex) cacheIndex++;
          const remembered = cached[cacheIndex]?.step === stepIndex ? cached[cacheIndex++] : undefined;
          if (remembered?.control) {
            const matches = observation.controls.filter(item => JSON.stringify(semantic(item)) === JSON.stringify(remembered.control));
            if (matches.length > 1) throw new BlockedError('Saved native target is ambiguous.');
            control = matches[0]; navigation = remembered.navigation; replay = Boolean(control);
          }
          if (!control) {
            const selection = await timed('model', () => options.decide ? options.decide(observation, step, caseSignal) : decide(observation, step, provider, caseSignal));
            caseSignal.throwIfAborted();
            if (selection.target === 'none') {
              if (selection.navigation === 'wait') { await delay(200, undefined, { signal: caseSignal }); continue; }
              if (selection.navigation === 'blocked') throw new BlockedError(`No observed native control can perform or reveal: ${step.target}.`);
              control = observation.controls.find(item => item.id === selection.navigation); navigation = true;
            } else control = observation.controls.find(item => item.id === selection.target);
          }
          if (!control || control.disabled || !control.capabilities?.includes(navigation ? 'click' : step.action)) throw new BlockedError('Decision selected an unavailable or incompatible native control.');
          if (!navigation && control.label !== step.target && control.identifier !== step.target) throw new BlockedError('Decision changed the authored native target. The action was not dispatched.');
          if (navigation && (unsupportedNativeMutation(control.label) || /delete|remove|archive|save|submit|sign in|log in|sign out|add|increase|decrease|enable|disable/i.test(control.label))) throw new BlockedError('Decision attempted unsafe native navigation.');
          // Once a private value has been entered, later captures must never
          // include it. A recording intentionally excludes all credential steps.
          const action = navigation ? { action: 'click' as const, target: control.label, value: null, fixture: null } : step;
          result.actions.push({ step: stepIndex, action: action.action, target: control.label, replay });
          await timed('action', () => driver.execute(observation, control!, action, navigation ? null : values[stepIndex], caseSignal));
          result.flow.push({ step: stepIndex, navigation, control: semantic(control) }); complete = !navigation;
        }
        for (const assertion of test.assertions.filter(check => check.afterStep === stepIndex)) {
          result.checks.push(await timed('check', () => driver.check(assertion, caseSignal, options.assertionTimeoutMs ?? 2000)));
          if (!result.checks.at(-1)!.passed) { result.verdict = 'FAIL'; result.reason = 'A required mobile milestone contradicted the authored expectation.'; break; }
        }
        if (result.verdict === 'FAIL') break;
        if (directory && options.onProgress) {
          try {
            const captured = await timed('artifact', () => driver.screenshot(join(directory, 'preview.png'), caseSignal));
            if (captured) progress({ type: 'preview', message: 'Updated eligible native screen.', caseName: test.name, screenshot: 'preview.png' });
          } catch { caseSignal.throwIfAborted(); }
        }
      }
      if (result.verdict !== 'FAIL') {
        for (const assertion of test.assertions.filter(check => check.afterStep === undefined)) result.checks.push(await timed('check', () => driver.check(assertion, caseSignal, options.assertionTimeoutMs ?? 2000)));
        result.verdict = result.checks.length === test.assertions.length && result.checks.every(check => check.passed) ? 'PASS' : 'FAIL';
        result.reason = result.verdict === 'PASS' ? 'All required actions and mobile milestones were checked.' : 'One or more authored mobile expectations did not hold.';
      }
    } catch (e) { result.verdict = 'BLOCKED'; result.reason = signal.aborted ? 'Run canceled.' : caseSignal.aborted ? 'Case deadline reached.' : e instanceof BlockedError ? e.message : 'Native execution/verification could not complete reliably. An uncertain action was not repeated.'; }
    finally {
      if (directory && !caseSignal.aborted) {
        try {
          if (recordingStarted) { const path = await timed('artifact', () => driver.stopRecording(AbortSignal.any([caseSignal, AbortSignal.timeout(20000)]))); if (path) { result.video = `${i + 1}.mp4`; result.videoMetadata = driver.recordingMetrics; } }
          if (await timed('artifact', () => driver.screenshot(join(directory, `${i + 1}.png`), AbortSignal.any([caseSignal, AbortSignal.timeout(10000)])))) result.screenshot = `${i + 1}.png`;
        } catch { result.evidenceNotes = ['Requested native capture could not produce a usable artifact.']; }
        if (driver.recordingDiscardedReason) result.evidenceNotes = [...(result.evidenceNotes ?? []), driver.recordingDiscardedReason];
      }
      if (caseSignal.aborted) { result.verdict = 'BLOCKED'; result.reason = signal.aborted ? 'Run canceled.' : 'Case deadline reached.'; }
      clearTimeout(timer);
      let released = false;
      try { await timed('cleanup', () => driver.close()); released = true; }
      catch { result.verdict = 'BLOCKED'; result.reason = 'Owned native session cleanup could not be confirmed within the release deadline.'; }
      signal.removeEventListener('abort', stop);
      result.durationMs = Date.now() - caseStart; results.push(result);
      progress({ type: 'context.closed', message: released ? 'Released the owned native session.' : 'Owned native session release was not confirmed.', caseName: test.name });
      progress({ type: 'result', message: `${result.verdict}: ${result.reason}`, caseName: test.name });
    }
  }
  const result: SuiteResult = sanitize({ version: 2, id, startedAt: new Date(start).toISOString(), url: `app://${versions.app ?? target.app}`, target, versions, timings, verdict: signal.aborted || results.some(test => test.verdict === 'BLOCKED') ? 'BLOCKED' : results.every(test => test.verdict === 'PASS') ? 'PASS' : 'FAIL', canceled: signal.aborted, cases: results, durationMs: Date.now() - start, model: provider.stats, plan, reportDirectory: directory }, secrets);
  if (directory) await writeReport(result, directory);
  return result;
}
