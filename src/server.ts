import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFixtures, secretValues, sanitize } from './config.js';
import { compileCases, planHash } from './plan.js';
import { runSuite, providerOptions, readSavedPlan, savedHash } from './runner.js';
import { compileNative } from './mobile-plan.js';
import { validateSuite, type Progress, type SuiteResult, type Suite, type NativeTarget } from './types.js';

type Job = { id: string; controller: AbortController; events: Progress[]; subscribers: Set<ServerResponse>; done: boolean; result?: SuiteResult; plan?: Suite; target?: NativeTarget; directory: string; sourceKey: string };
async function body(request: IncomingMessage): Promise<Record<string, any>> {
  let text = ''; for await (const chunk of request) { text += chunk; if (text.length > 100000) throw new Error('Request too large.'); }
  const result = JSON.parse(text || '{}'); if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Expected JSON object.'); return result;
}
export async function startUi(port = 4007, dataDirectory = '.jev-e2e') {
  const token = randomBytes(32).toString('hex'); const jobs = new Map<string, Job>(); let active: Job | undefined; let pending: Promise<void> | undefined; let url = '';
  const directory = resolve(dataDirectory); await mkdir(directory, { recursive: true, mode: 0o700 });
  const assets = new Map(await Promise.all(['index.html', 'app.js', 'style.css', 'favicon.ico'].map(async name => [name, name === 'favicon.ico' ? Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#c94b0b"/><text x="19" y="46" font-size="45" fill="white" font-family="monospace">j</text></svg>') : await readFile(fileURLToPath(new URL(`../public/${name}`, import.meta.url)))] as const)));
  const sendEvent = (job: Job, event: Progress) => { job.events.push(event); for (const subscriber of job.subscribers) { if (subscriber.destroyed || subscriber.writableEnded) { job.subscribers.delete(subscriber); continue; } try { subscriber.write(`id: ${job.events.length}\ndata: ${JSON.stringify(event)}\n\n`); } catch { job.subscribers.delete(subscriber); } } };
  const server = createServer(async (request, response) => {
    const json = (data: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(data)); };
    try {
      if (request.headers.host !== new URL(url).host || (request.headers.origin && request.headers.origin !== url)) { json({ error: 'Local origin required.' }, 403); return; }
      const path = new URL(request.url ?? '/', url).pathname;
      response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      if (request.method === 'GET' && path === '/api/session') { json({ token, configured: Boolean(process.env.OPENROUTER_API_KEY) }); return; }
      if (request.method === 'GET' && path === '/api/devices') {
        const platform = new URL(request.url!, url).searchParams.get('platform');
        if (platform !== 'ios' && platform !== 'android') throw new Error('Choose a native platform.');
        const { listDevices } = await import('./device.js'); json(await listDevices(platform)); return;
      }
      if (request.method === 'GET' && /^\/api\/jobs\/[a-f0-9-]+\/(events|result)$/.test(path)) {
        const id = path.split('/')[3]; const job = jobs.get(id); if (!job) { json({ error: 'Job not found.' }, 404); return; }
        if (path.endsWith('/result')) { json({ done: job.done, result: job.result, plan: job.plan }); return; }
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        const cursor = Number(request.headers['last-event-id'] ?? 0);
        for (let index = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0; index < job.events.length; index++) response.write(`id: ${index + 1}\ndata: ${JSON.stringify(job.events[index])}\n\n`);
        if (job.done) { response.end(); return; } job.subscribers.add(response); response.once('close', () => job.subscribers.delete(response)); response.on('error', () => job.subscribers.delete(response)); return;
      }
      if (request.method === 'GET' && /^\/runs\/[a-f0-9-]+\/(report.html|report.json|plan.json|preview.png|\d+\.(png|mp4))$/.test(path)) {
        const [, , id, filename] = path.split('/'); const job = jobs.get(id); if (!job || !job.result && filename !== 'preview.png') { json({ error: 'Report not found.' }, 404); return; }
        if (/^\d+\.mp4$/.test(filename) && !job.result?.cases.some(test => test.video === filename) || /^\d+\.png$/.test(filename) && !job.result?.cases.some(test => test.screenshot === filename)) { json({ error: 'Artifact not published by this result.' }, 404); return; }
        const content = await readFile(join(job.directory, filename)); response.setHeader('Content-Type', filename.endsWith('.mp4') ? 'video/mp4' : filename.endsWith('.png') ? 'image/png' : filename.endsWith('.html') ? 'text/html' : 'application/json');
        if (filename.endsWith('.mp4')) {
          response.setHeader('Accept-Ranges', 'bytes');
          if (request.headers.range) {
            const match = request.headers.range.match(/^bytes=(\d+)-(\d*)$/);
            const start = Number(match?.[1]), end = match?.[2] ? Number(match[2]) : content.length - 1;
            if (!match || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || end >= content.length) { response.writeHead(416, { 'Content-Range': `bytes */${content.length}` }).end(); return; }
            response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${content.length}`, 'Content-Length': end - start + 1 }); response.end(content.subarray(start, end + 1)); return;
          }
        }
        if (filename.endsWith('.html')) response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; media-src 'self'; base-uri 'none'; frame-ancestors 'none'"); response.end(content); return;
      }
      if (request.method === 'POST') {
        if (request.headers['x-jev-token'] !== token || request.headers['content-type'] !== 'application/json') { json({ error: 'Local session token required.' }, 403); return; }
        const input = await body(request);
        if (path === '/api/cancel') { if (active && input.id === active.id) active.controller.abort(); json({ ok: true }); return; }
        if (path === '/api/save') {
          const job = jobs.get(String(input.id)); const plan = job?.result?.plan ?? job?.plan;
          if (!job?.done || !plan) { json({ error: 'Finish reviewing a plan before saving.' }, 409); return; }
          const saved = join(directory, 'suites', `${job.id}.json`); await mkdir(join(directory, 'suites'), { recursive: true, mode: 0o700 });
          const target = job.result?.target ?? job.target;
          const flows = job.result?.cases.map(test => test.verdict === 'PASS' ? test.flow : null) ?? plan.cases.map(() => null);
          await writeFile(saved, JSON.stringify({ version: plan.version, plan, hash: savedHash(plan, target, flows), flows, ...(target ? { target } : {}) }, null, 2), { mode: 0o600 });
          // Saving this exact reviewed result is an authorized source change.
          // A user-selected different file still requires a fresh review.
          job.sourceKey = JSON.stringify({ ...JSON.parse(job.sourceKey), savedPath: saved });
          json({ path: saved }); return;
        }
        if (path !== '/api/plan' && path !== '/api/run') { json({ error: 'Unknown operation.' }, 404); return; }
        if (active && !active.done) { json({ error: 'A job is running. Stop it before starting another.' }, 409); return; }
        const fixtures = readFixtures(typeof input.fixtures === 'string' ? input.fixtures || undefined : undefined);
        const secrets = secretValues(fixtures); const mode = input.planner === 'off' ? 'off' : 'on';
        if (typeof input.casesText !== 'string' || input.casesText.length > 100000) throw new Error('Provide case descriptions.');
        const platform = input.platform ?? 'web';
        if (!['web', 'ios', 'android'].includes(platform)) throw new Error('Unknown platform.');
        const target: NativeTarget | undefined = platform === 'web' ? undefined : { platform, app: String(input.app ?? ''), device: String(input.device ?? ''), baseline: 'preserve' };
        if (target && !target.app.trim()) throw new Error('Provide an app identity or build path.');
        const sourceKey = JSON.stringify({ casesText: input.casesText, fixtures: input.fixtures ?? '', planner: mode, url: input.url ?? '', platform, app: input.app ?? '', device: input.device ?? '', record: Boolean(input.record), savedPath: input.savedPath ?? '' });
        const reviewed = jobs.get(String(input.reviewId));
        const plan = reviewed?.result?.plan ?? reviewed?.plan;
        if (path === '/api/run' && (!reviewed?.done || !plan || reviewed.sourceKey !== sourceKey)) { json({ error: 'Review this specification and configuration before running.' }, 409); return; }
        const job: Job = { id: randomUUID(), controller: new AbortController(), events: [], subscribers: new Set(), done: false, directory: '', sourceKey, target }; job.directory = join(directory, 'runs', job.id);
        jobs.set(job.id, job); active = job; json({ id: job.id }, 202);
        // Bound retained jobs; completed artifacts remain on disk for their owner.
        if (jobs.size > 100) for (const [id, previous] of jobs) { if (previous.done && previous !== job) { jobs.delete(id); break; } }
        pending = (async () => {
          try {
            const options = { url: target ? undefined : String(input.url ?? ''), platform: platform as 'web' | 'ios' | 'android', app: target?.app, device: target?.device, record: Boolean(input.record), fixtures, planner: mode as 'on' | 'off', casesText: input.casesText, signal: job.controller.signal, maxCost: 0.05, outputDirectory: job.directory };
            if (path === '/api/plan') {
              sendEvent(job, { type: 'planning', message: 'Compiling cases for review.' });
              const saved = typeof input.savedPath === 'string' && input.savedPath ? await readSavedPlan(input.savedPath) : undefined;
              if (saved?.target && (!target || saved.target.app !== target.app || saved.target.platform !== target.platform)) throw new Error('Saved plan belongs to a different native app/platform.');
              job.plan = sanitize(saved?.plan ?? (target ? await compileNative(input.casesText, target.platform, mode, fixtures, providerOptions(options), job.controller.signal, secrets) : await compileCases(input.casesText, mode, fixtures, providerOptions(options), job.controller.signal, secrets)), secrets);
            } else {
              const replay = typeof input.savedPath === 'string' && input.savedPath ? await readSavedPlan(input.savedPath) : undefined;
              if (replay && planHash(replay.plan) !== planHash(validateSuite(plan))) throw new Error('The saved specification changed. Review it again.');
              job.result = await runSuite({ ...options, savedTarget: replay?.target ?? reviewed?.target, plan, replay, onProgress: event => sendEvent(job, event) });
            }
          } catch (error) { sendEvent(job, sanitize({ type: 'error', message: job.controller.signal.aborted ? 'Job canceled.' : error instanceof Error ? error.message : 'Job could not complete.' }, secrets)); }
          finally { job.done = true; sendEvent(job, { type: 'done', message: 'Job finished.' }); for (const subscriber of job.subscribers) subscriber.end(); job.subscribers.clear(); }
        })(); return;
      }
      const filename = path === '/' ? 'index.html' : path.slice(1); const content = assets.get(filename);
      if (request.method !== 'GET' || !content) { json({ error: 'Not found.' }, 404); return; }
      response.setHeader('Content-Type', filename.endsWith('.html') ? 'text/html' : filename.endsWith('.css') ? 'text/css' : filename.endsWith('.ico') ? 'image/svg+xml' : 'text/javascript'); response.end(content);
    } catch { if (!response.headersSent) json({ error: 'Invalid request or local file configuration.' }, 400); else response.end(); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Could not start workbench.'); url = `http://127.0.0.1:${address.port}`;
  return { url, close: async () => { active?.controller.abort(); for (const job of jobs.values()) for (const subscriber of job.subscribers) subscriber.end(); await pending; await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
