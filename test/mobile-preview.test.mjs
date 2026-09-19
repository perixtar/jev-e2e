import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { startUi } from '../dist/server.js';
import { MobileDriver } from '../dist/mobile.js';

test('live native preview publishes only verified pixels and discards canceled staging', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-preview-'));
  const original = Object.fromEntries(['open', 'direct', 'check', 'screenshot', 'close'].map(name => [name, MobileDriver.prototype[name]]));
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'sk-or-unit-test-preview';
  const staged = Array.from({ length: 3 }, () => Promise.withResolvers());
  const release = Array.from({ length: 3 }, () => Promise.withResolvers());
  let captures = 0, ui;
  MobileDriver.prototype.open = async function () { this.appIdentity = 'dev.example.app'; this.target.device = 'sim'; };
  MobileDriver.prototype.direct = async () => {};
  MobileDriver.prototype.check = async assertion => ({ assertion, passed: true, observed: true });
  MobileDriver.prototype.screenshot = async (path, signal) => {
    if (!basename(path).startsWith('.preview-')) { await writeFile(path, 'SAFE FINAL'); return true; }
    const index = captures++;
    await writeFile(path, 'UNVERIFIED PRIVATE PIXELS');
    staged[index].resolve(path);
    await Promise.race([
      release[index].promise,
      new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
    ]);
    signal.throwIfAborted();
    await writeFile(path, `SAFE ${index + 1}`);
    return true;
  };
  MobileDriver.prototype.close = async () => {};
  try {
    ui = await startUi(0, directory);
    const token = (await (await fetch(ui.url + '/api/session')).json()).token;
    const input = { platform: 'ios', app: 'dev.example.app', device: 'sim', planner: 'off',
      casesText: 'Case: Safe preview\nGoal: Inspect ready state\nStep: Wait for text "Ready"\nExpect: text "Ready" is visible\nStep: Wait for text "Ready"\nExpect: text "Ready" is visible' };
    const post = async (path, data) => {
      const response = await fetch(ui.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-jev-token': token }, body: JSON.stringify(data) });
      assert.ok(response.ok, `${path}: ${response.status}`); return response.json();
    };
    const done = async id => {
      for (let attempt = 0; attempt < 200; attempt++) {
        const state = await (await fetch(ui.url + `/api/jobs/${id}/result`)).json();
        if (state.done) return state;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw Error('Timed out waiting for the native job.');
    };
    const reviewed = await post('/api/plan', input);
    assert.ok((await done(reviewed.id)).plan);
    const first = await post('/api/run', { ...input, reviewId: reviewed.id });
    const firstUrl = ui.url + `/runs/${first.id}/preview.png`;
    const staging1 = await staged[0].promise;
    assert.equal((await fetch(firstUrl)).status, 404);
    assert.equal((await fetch(ui.url + `/runs/${first.id}/${basename(staging1)}`)).status, 404);
    release[0].resolve();
    const staging2 = await staged[1].promise;
    assert.notEqual(staging1, staging2);
    assert.equal(await (await fetch(firstUrl)).text(), 'SAFE 1');
    assert.equal(await readFile(staging2, 'utf8'), 'UNVERIFIED PRIVATE PIXELS');
    release[1].resolve();
    assert.equal((await done(first.id)).result.verdict, 'PASS');
    assert.equal(await (await fetch(firstUrl)).text(), 'SAFE 2');
    assert.ok(!(await readdir(join(directory, 'runs', first.id))).some(name => name.startsWith('.preview-')));

    const canceled = await post('/api/run', { ...input, reviewId: reviewed.id });
    await staged[2].promise;
    assert.equal((await fetch(ui.url + `/runs/${canceled.id}/preview.png`)).status, 404);
    await post('/api/cancel', { id: canceled.id });
    assert.equal((await done(canceled.id)).result.verdict, 'BLOCKED');
    assert.ok(!(await readdir(join(directory, 'runs', canceled.id))).some(name => name.startsWith('.preview-')));
  } finally {
    for (const gate of release) gate.resolve();
    await ui?.close();
    Object.assign(MobileDriver.prototype, original);
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previousKey;
    await rm(directory, { recursive: true, force: true });
  }
});
