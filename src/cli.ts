#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { loadEnvironment, readFixtures, redact, secretValues } from './config.js';
import { runSuite, readSavedPlan, providerOptions } from './runner.js';
import { compileCases, planHash } from './plan.js';
import { savedHash } from './runner.js';
import { compileNative } from './mobile-plan.js';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { startDemo } from './demo.js';
import { startUi } from './server.js';

const help = `jev-e2e — natural-language web tests and native mobile tests powered by Jev

  jev-e2e setup                        Install Chromium
  jev-e2e doctor --platform ios        Check local device tools
  jev-e2e devices [--platform ios]     List simulators/emulators and exact IDs
  jev-e2e demo [--port 4177]            Start the local demo and write demo fixtures
  jev-e2e ui [--port 4007]              Open the local workbench URL
  jev-e2e plan --cases FILE --out FILE  Compile and save a test specification
  jev-e2e run --url URL --cases FILE    Discover a flow and check expectations
  jev-e2e run --url URL --plan FILE     Run a saved specification
  jev-e2e run --url URL --replay FILE   Replay a successful flow; repair stale targets with Jev

Options: --planner on|off, --fixtures FILE, --headed, --out DIR, --json,
  --timeout MS (60000), --max-actions N (30), --max-requests N (100),
  --max-cost USD (0.05), --allow-origin URL (repeatable), --env FILE.
Exit codes: 0 PASS, 1 FAIL, 2 BLOCKED/configuration error, 130 canceled.
For native apps: run --platform ios|android --app APP --device ID --cases FILE.
Run "jev-e2e COMMAND --help" for examples. Tests need explicit expectations.
`;
const commandHelp: Record<string, string> = {
  run: `jev-e2e run — execute cases, verify expectations, save a report

Website:
  jev-e2e run --url http://localhost:3000 --cases tests.cases --planner off
  jev-e2e run --url http://localhost:3000 --replay saved-plan.json

Native app (local simulator/emulator):
  jev-e2e devices --platform ios
  jev-e2e run --platform ios --device ID --app com.example.app --cases tests.cases
  jev-e2e run --platform android --device emulator-5554 --app ./app.apk --cases tests.cases --record
  jev-e2e run --replay saved-mobile-plan.json

Choose exactly one source: --cases FILE, --plan FILE, or --replay FILE.
--planner on interprets free-form goals through the configured general model.
--planner off uses explicit steps; saved plans always skip generative planning.
Jev chooses observed controls. The runner independently checks correctness.

Mobile case example (--planner off):
  Case: Cart survives restart
  Goal: Add a lamp and verify persistence
  Step: Tap "Open Desk Lamp"
  Step: Tap "Add to cart"
  Expect: text "Desk Lamp" is visible
  Step: Relaunch
  Step: Tap "Cart"
  Expect: text "Desk Lamp" is visible

Put each Expect after the action it checks. Credentials: Fill "Password" with @password.
Step lines are the action contract; Goal is a summary. Named Goal actions must match Steps.
Mobile steps: Tap, Fill, Check/Uncheck, Scroll down/up/left/right, Back,
Dismiss keyboard, Wait for text, Relaunch. Relaunch preserves app data.
Mobile runs never reset an app automatically; supply your test baseline yourself.
Saved build-path replays pin the installed bundle/package ID, even when the file at that path changes.
--record opts into local video and excludes credential-entry segments.
--out DIR saves JSON, HTML, a replay plan, and eligible images/video.
Limits: --timeout MS (60000), --max-actions N (30), --max-requests N (100),
--max-cost USD (0.05). Other: --fixtures FILE, --env FILE, --json.

PASS (exit 0): every required action and expectation checked.
FAIL (exit 1): observed app behavior contradicted an expectation.
BLOCKED (exit 2): missing/ambiguous evidence, unavailable control, setup, or limit.
Canceled (exit 130): Ctrl-C stops owned work. An uncertain action is never retried.
`,
  plan: `jev-e2e plan — review and save cases without opening the app

  jev-e2e plan --cases tests.cases --planner off --out plan.json
  jev-e2e plan --platform ios --app com.example.app --cases tests.cases --out plan.json

Use --fixtures FILE for named input bindings. Mobile plans bind to app/platform.
Use run --plan plan.json to discover controls, or run --replay plan.json for saved flows.
`,
  devices: `jev-e2e devices — list local virtual devices

  jev-e2e devices --platform ios
  jev-e2e devices --platform android --json

Pass an exact ID to run --device ID. Duplicate device names are BLOCKED.
Only iOS Simulator and Android Emulator are supported; real phones are deferred.
`,
  doctor: `jev-e2e doctor — check setup without opening your app

  jev-e2e doctor
  jev-e2e doctor --platform ios
  jev-e2e doctor --platform android

iOS: macOS, Xcode, an installed iOS runtime and simulator build.
Android: Java, Android SDK/platform-tools on PATH, a booted emulator and APK.
All targets: OPENROUTER_API_KEY for live Jev decisions; planner is optional.
`,
};
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    url: { type: 'string' }, cases: { type: 'string' }, plan: { type: 'string' }, replay: { type: 'string' },
    platform: { type: 'string' }, app: { type: 'string' }, device: { type: 'string' }, record: { type: 'boolean' },
    planner: { type: 'string' }, fixtures: { type: 'string' }, out: { type: 'string' }, port: { type: 'string' },
    timeout: { type: 'string' }, 'max-actions': { type: 'string' }, 'max-requests': { type: 'string' }, 'max-cost': { type: 'string' },
    'allow-origin': { type: 'string', multiple: true }, env: { type: 'string' }, headed: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  const command = positionals[0];
  if (values.help || !command || command === 'help') { console.log(commandHelp[command === 'help' ? positionals[1] : command] ?? help); return; }
  if (positionals.length !== 1) throw new Error('Unexpected argument. See "jev-e2e COMMAND --help".');
  const platform = values.platform ?? 'web';
  if (!['web', 'ios', 'android'].includes(platform)) throw new Error('--platform must be web, ios, or android.');
  loadEnvironment(values.env ? resolve(values.env) : undefined);
  if (command === 'devices' || command === 'doctor') {
    if (command === 'doctor' && platform === 'web') {
      const ready = existsSync(chromium.executablePath());
      console.log(values.json ? JSON.stringify({ platform: 'web', chromium: ready, configured: Boolean(process.env.OPENROUTER_API_KEY) }) : `${ready ? 'OK' : 'MISSING'} Chromium${ready ? '' : ' — run jev-e2e setup'}\n${process.env.OPENROUTER_API_KEY ? 'OK' : 'MISSING'} OPENROUTER_API_KEY — required for live control discovery`);
      process.exitCode = ready ? 0 : 2; return;
    }
    const { listDevices, DeviceConnection } = await import('./device.js');
    const native = platform === 'web' ? undefined : platform as 'ios' | 'android';
    if (command === 'devices') {
      const devices = (await listDevices(native)).filter(device => ['simulator', 'emulator'].includes(device.kind));
      console.log(values.json ? JSON.stringify(devices) : devices.map(device => `${device.platform.toUpperCase()}  ${device.id}  ${device.name}  ${device.booted ? 'booted' : 'stopped'}${device.claimedBy ? ' · in use' : ''}`).join('\n') || 'No devices found. See "jev-e2e doctor --help".'); return;
    }
    if (!native) throw new Error('Choose --platform ios or android.');
    const connection = new DeviceConnection(native);
    try {
      const result = await connection.call('doctor', { platform: native }, AbortSignal.timeout(30000));
      console.log(values.json ? JSON.stringify(result) : `${native.toUpperCase()}: ${result.summary}\n${(result.checks ?? []).filter((check: any) => check.status !== 'info').map((check: any) => `${check.status === 'pass' ? 'OK' : check.status.toUpperCase()} ${check.summary}${check.hint ? '\n  '+check.hint : ''}`).join('\n')}\n${process.env.OPENROUTER_API_KEY ? 'OK' : 'MISSING'} OPENROUTER_API_KEY — needed for live Jev decisions`);
      process.exitCode = result.status === 'fail' || result.status === 'blocked' ? 2 : 0;
    }
    finally { connection.interrupt(); }
    return;
  }
  if (command === 'setup') {
    if (platform !== 'web') throw new Error('Native toolchains are host-specific. Run doctor --platform ios|android and follow docs/MOBILE.md.');
    const script = fileURLToPath(new URL('cli.js', import.meta.resolve('playwright/package.json')));
    const child = spawn(process.execPath, [script, 'install', 'chromium'], { stdio: 'inherit' });
    process.exitCode = await new Promise<number>(resolve => child.on('exit', code => resolve(code ?? 2))); return;
  }
  const numeric = (value: string | undefined) => value === undefined ? undefined : Number(value);
  if (command === 'demo' || command === 'ui') {
    const port = numeric(values.port) ?? (command === 'demo' ? 4177 : 4007);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port.');
    const server = command === 'demo' ? await startDemo(port) : await startUi(port);
    console.log(`${command === 'demo' ? 'Demo' : 'Workbench'}: ${server.url}`);
    if ('writeFixtures' in server && typeof server.writeFixtures === 'function') console.log(`Demo fixtures: ${await server.writeFixtures()}`);
    let stopping = false;
    const stop = () => { if (stopping) return; stopping = true; void server.close().then(() => { process.exitCode = 0; }).catch(() => { process.exitCode = 2; }); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop); return;
  }
  if (!['run', 'plan'].includes(command)) throw new Error(`Unknown command: ${command}`);
  const fixtures = readFixtures(values.fixtures); const controller = new AbortController(); const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const mode = values.planner ?? process.env.JEV_E2E_PLANNER ?? 'on';
    if (mode !== 'on' && mode !== 'off') throw new Error('--planner must be on or off.');
    if ([values.cases, values.plan, values.replay].filter(Boolean).length !== 1) throw new Error('Provide exactly one --cases, --plan, or --replay file.');
    const options = { url: values.url, platform: values.platform as 'web' | 'ios' | 'android' | undefined, app: values.app, device: values.device, record: values.record, fixtures, planner: mode as 'on' | 'off', casesText: values.cases ? await readFile(resolve(values.cases), 'utf8') : undefined,
      signal: controller.signal, headed: values.headed, timeoutMs: numeric(values.timeout), maxActions: numeric(values['max-actions']), maxRequests: numeric(values['max-requests']), maxCost: numeric(values['max-cost']), allowedOrigins: values['allow-origin'], outputDirectory: values.out };
    if (command === 'plan') {
      if (!options.casesText || !values.out) throw new Error('plan requires --cases and --out.');
      if (platform !== 'web' && (values.url || values.headed || values['allow-origin']?.length)) throw new Error('Mobile plans use --app and --device; --url, --headed and --allow-origin are website options.');
      if (platform === 'web' && (values.app || values.device || values.record)) throw new Error('Use --platform ios or android for --app, --device or --record.');
      if (values.record) throw new Error('--record is a run option. Planning never opens or records an app.');
      const provider = providerOptions(options);
      const timeout = options.timeoutMs ?? 30000;
      if (!Number.isFinite(provider.maxCost) || provider.maxCost <= 0 || !Number.isInteger(provider.maxRequests) || provider.maxRequests < 1 || !Number.isFinite(timeout) || timeout < 100 || timeout > 300000) throw new Error('Use positive budgets/requests and a timeout of 100–300000 ms.');
      const target = platform === 'web' ? undefined : { platform: platform as 'ios' | 'android', app: values.app ?? '', device: values.device ?? '', baseline: 'preserve' as const };
      if (target && !target.app) throw new Error('Mobile plan requires --app with a bundle/package ID or build path.');
      const planningSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(Math.min(timeout, 30000))]);
      const plan = target ? await compileNative(options.casesText, target.platform, options.planner, fixtures, provider, planningSignal, secretValues(fixtures)) : await compileCases(options.casesText, options.planner, fixtures, provider, planningSignal, secretValues(fixtures));
      planningSignal.throwIfAborted();
      const location = resolve(values.out); await mkdir(dirname(location), { recursive: true, mode: 0o700 });
      await writeFile(location, JSON.stringify({ version: plan.version, plan, hash: target ? savedHash(plan, target) : planHash(plan), flows: plan.cases.map(() => null), ...(target ? { target } : {}) }, null, 2), { mode: 0o600 });
      console.log(values.json ? JSON.stringify(plan) : `Saved ${plan.cases.length} cases: ${location}`);
      process.exitCode = plan.cases.some(test => test.blockedReason) ? 2 : 0; return;
    }
    const saved = values.plan || values.replay ? await readSavedPlan(values.plan ?? values.replay!) : undefined;
    const result = await runSuite({ ...options, platform: options.platform ?? saved?.target?.platform, app: options.app ?? saved?.target?.app, device: options.device ?? saved?.target?.device, savedTarget: saved?.target, plan: values.plan ? saved?.plan : undefined, replay: values.replay ? saved : undefined,
      onProgress: values.json ? undefined : event => console.error(event.caseName ? `[${event.caseName}] ${event.message}` : event.message) });
    if (values.json) console.log(JSON.stringify(result));
    else {
      for (const test of result.cases) console.log(`${test.verdict}  ${test.name} — ${test.reason}`);
      console.log(`${result.verdict} · ${(result.durationMs / 1000).toFixed(1)}s · ${result.model.requests} model requests · $${result.model.cost.toFixed(6)}`);
      if (result.reportDirectory) console.log(`Report: ${resolve(result.reportDirectory, 'report.html')}`);
    }
    process.exitCode = result.canceled ? 130 : result.verdict === 'PASS' ? 0 : result.verdict === 'FAIL' ? 1 : 2;
  } catch (error) {
    if (controller.signal.aborted) { console.error('Command canceled.'); process.exitCode = 130; return; }
    throw error;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
main().catch(error => { console.error(redact(error instanceof Error ? error.message : 'Command failed.', secretValues({ inputs: {}, auth: {} }))); process.exitCode = 2; });
