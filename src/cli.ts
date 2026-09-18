#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { loadEnvironment, readFixtures, redact, secretValues } from './config.js';
import { runSuite, readSavedPlan, providerOptions } from './runner.js';
import { compileCases, planHash } from './plan.js';
import { startDemo } from './demo.js';
import { startUi } from './server.js';

const help = `jev-e2e — natural-language web tests powered by Jev

  jev-e2e setup                        Install Chromium
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
Expectations and fixtures are required. Native apps and visual judgments are outside this alpha.
`;
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    url: { type: 'string' }, cases: { type: 'string' }, plan: { type: 'string' }, replay: { type: 'string' },
    planner: { type: 'string' }, fixtures: { type: 'string' }, out: { type: 'string' }, port: { type: 'string' },
    timeout: { type: 'string' }, 'max-actions': { type: 'string' }, 'max-requests': { type: 'string' }, 'max-cost': { type: 'string' },
    'allow-origin': { type: 'string', multiple: true }, env: { type: 'string' }, headed: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  const command = positionals[0];
  if (values.help || !command || command === 'help') { console.log(help); return; }
  loadEnvironment(values.env ? resolve(values.env) : undefined);
  if (command === 'setup') {
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
    const options = { url: values.url ?? '', fixtures, planner: mode as 'on' | 'off', casesText: values.cases ? await readFile(resolve(values.cases), 'utf8') : undefined,
      signal: controller.signal, headed: values.headed, timeoutMs: numeric(values.timeout), maxActions: numeric(values['max-actions']), maxRequests: numeric(values['max-requests']), maxCost: numeric(values['max-cost']), allowedOrigins: values['allow-origin'], outputDirectory: values.out };
    if (command === 'plan') {
      if (!options.casesText || !values.out) throw new Error('plan requires --cases and --out.');
      const provider = providerOptions(options); const plan = await compileCases(options.casesText, options.planner, fixtures, provider, controller.signal, secretValues(fixtures));
      const location = resolve(values.out); await mkdir(dirname(location), { recursive: true, mode: 0o700 });
      await writeFile(location, JSON.stringify({ version: 1, plan, hash: planHash(plan), flows: plan.cases.map(() => null) }, null, 2), { mode: 0o600 });
      console.log(values.json ? JSON.stringify(plan) : `Saved ${plan.cases.length} cases: ${location}`);
      process.exitCode = plan.cases.some(test => test.blockedReason) ? 2 : 0; return;
    }
    const saved = values.plan || values.replay ? await readSavedPlan(values.plan ?? values.replay!) : undefined;
    const result = await runSuite({ ...options, plan: values.plan ? saved?.plan : undefined, replay: values.replay ? saved : undefined,
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
