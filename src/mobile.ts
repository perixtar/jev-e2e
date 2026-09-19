import { mkdir, chmod, unlink, stat, lstat, readdir } from 'node:fs/promises';
import { resolve, extname, dirname, relative, isAbsolute, sep, parse } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { DeviceConnection, selectDevice, nativeToolEnvironment, type NativeSnapshot } from './device.js';
import { redact } from './config.js';
import { parseNumber } from './assertions.js';
import { readAndroidChecked, androidInputFocused } from './android-state.js';
import { BlockedError, type Control, type Step, type Snapshot, type Assertion, type CheckResult, type NativeTarget } from './types.js';

type Node = NativeSnapshot['nodes'][number];
export type NativeObservation = Snapshot & { native: NativeSnapshot; nodes: Map<string, Node> };
const normalizedRole = (node: Node) => {
  const type = `${node.role ?? ''} ${node.type ?? ''}`.toLowerCase();
  return /securetextfield|textfield|searchfield|edittext|textbox/.test(type) || node.editable ? 'textbox' : /switch|checkbox|toggle/.test(type) ? 'checkbox' : /button/.test(type) ? 'button' : /link/.test(type) ? 'link' : /cell|listitem/.test(type) ? 'listitem' : /heading/.test(type) ? 'heading' : 'text';
};
const selected = (node: Node): boolean | null => {
  if (normalizedRole(node) !== 'checkbox') return null;
  if (typeof node.checked === 'boolean') return node.checked;
  // UISwitch exposes its on/off state as value; XCUIElement.selected can stay
  // false for an enabled switch. Use the explicit state before selection.
  return /^(1|true|on|checked)$/i.test(node.value ?? '') ? true : /^(0|false|off|unchecked)$/i.test(node.value ?? '') ? false : null;
};
const visible = (node: Node) => node.visibleToUser !== false && node.hittable !== false && !node.interactionBlocked && Boolean(node.rect && node.rect.width > 0 && node.rect.height > 0);
const isSystemSurface = (raw: NativeSnapshot) => raw.systemSurfaceOnly === true || raw.androidSnapshot?.systemSurfaceOnly === true || typeof raw.iosSystemSurfaceBundleId === 'string' && raw.iosSystemSurfaceBundleId.length > 0;
function assertSnapshotOwnership(raw: NativeSnapshot, app: string, device?: string): void {
  if (isSystemSurface(raw)) throw new BlockedError('The observed native surface belongs to the operating system. System dialogs and overlays are unsupported.');
  const apps = [raw.appBundleId, raw.identifiers?.appBundleId, raw.identifiers?.appId, raw.identifiers?.package].filter(value => value !== undefined && value !== null);
  if (!apps.length || apps.some(value => value !== app)) throw new BlockedError('The observed app does not match --app. External apps and system dialogs need explicit handling.');
  if (device) {
    const disclosed = [raw.identifiers?.deviceId, raw.identifiers?.udid, raw.identifiers?.serial].filter(value => value !== undefined && value !== null);
    // The pinned local SDK omits identifiers from simulator snapshots. The
    // exact device is already bound and verified by apps.open; reject a
    // conflicting capture identifier whenever the backend does disclose one.
    if (disclosed.some(value => value !== device)) throw new BlockedError('The observed native snapshot does not match the selected device.');
  }
}
function matchesDisclosedIdentity(expected: string, aliases: unknown[]): boolean {
  const disclosed = aliases.filter(value => value !== undefined && value !== null);
  return disclosed.length > 0 && disclosed.every(value => value === expected);
}
function assertOpenedIdentity(result: any, app: string, device: string): void {
  const selected = result?.device;
  if (!matchesDisclosedIdentity(app, [result?.appBundleId, result?.appId, result?.package, result?.bundleId, result?.identifiers?.appBundleId, result?.identifiers?.appId, result?.identifiers?.package, selected?.identifiers?.appBundleId, selected?.identifiers?.appId, selected?.identifiers?.package])
    || result?.appBundleId !== app
    || !matchesDisclosedIdentity(device, [selected?.id, selected?.identifiers?.deviceId, selected?.identifiers?.udid, selected?.identifiers?.serial, result?.identifiers?.deviceId, result?.identifiers?.udid, result?.identifiers?.serial])
    || selected?.id !== device) throw new BlockedError('Native open selected a different app/device.');
}
async function removeLocalArtifact(path: string): Promise<void> {
  try { await unlink(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new BlockedError('Could not clear the requested local artifact path before capture.'); }
}
function ancestors(node: Node, nodes: Node[]): Node[] {
  const result: Node[] = [], seen = new Set<number>();
  while (node.parentIndex !== undefined) {
    if (seen.has(node.parentIndex)) break; seen.add(node.parentIndex);
    const parent = nodes.find(item => item.index === node.parentIndex); if (!parent) break;
    result.push(parent); node = parent;
  }
  return result;
}
export function normalizeNative(raw: NativeSnapshot, app: string, secrets: string[], device?: string): NativeObservation {
  assertSnapshotOwnership(raw, app, device);
  if (!raw.nodes?.length || !['healthy', 'recovered'].includes(raw.snapshotQuality?.state ?? '')) throw new BlockedError('Native accessibility evidence is empty or unhealthy.');
  const nodes = new Map<string, Node>(), controls: Control[] = [];
  for (const node of raw.nodes) {
    if (!visible(node)) continue;
    const role = normalizedRole(node);
    const rawLabel = node.label ?? (node.inheritsLabel ? ancestors(node, raw.nodes).find(parent => parent.label)?.label : undefined) ?? node.identifier ?? '';
    const label = redact(rawLabel, secrets).slice(0, 240);
    const capabilities: Step['action'][] = role === 'textbox' ? ['fill'] : role === 'checkbox' ? ['check', 'uncheck'] : ['button', 'link'].includes(role) ? ['click'] : [];
    if (!label || !capabilities.length) continue;
    const id = `n${node.index}`;
    const context = redact(ancestors(node, raw.nodes).reverse().map(parent => parent.label || parent.identifier || '').filter(value => value && value !== rawLabel).join(' / '), secrets).slice(-600);
    const type = redact(node.password || /secure/i.test(node.type ?? '') ? 'password' : node.type ?? '', secrets).slice(0, 40);
    const identifier = node.identifier ? redact(node.identifier, secrets).slice(0, 300) : undefined;
    const control: Control = { id, tag: 'native', role, label, context, type, disabled: node.enabled === false, checked: selected(node), options: [], capabilities, ...(identifier ? { identifier } : {}),
      fingerprint: JSON.stringify({ role, label, context, identifier }) };
    controls.push(control); nodes.set(id, node);
  }
  const text = raw.nodes.filter(node => visible(node) && normalizedRole(node) !== 'textbox').map(node => node.label ?? '').filter(Boolean).join('\n');
  return { url: redact(`app://${app}`, secrets), text: redact(text, secrets).slice(0, 20000), controls, native: raw, nodes };
}
export function nativeCheck(raw: NativeSnapshot, assertion: Assertion): CheckResult {
  const target = assertion.target;
  if (!target) throw new BlockedError('Native checks need an accessibility target.');
  const name = (node: Node) => node.label ?? (node.inheritsLabel ? ancestors(node, raw.nodes).find(parent => parent.label)?.label : undefined) ?? '';
  let nodes = raw.nodes;
  if (target.within) {
    const scopeName = target.within.replace(/^record:/, '');
    const scopes = nodes.filter(node => node.label === scopeName || node.identifier === scopeName);
    if (scopes.length !== 1) throw new BlockedError('Native assertion scope is missing or ambiguous. Use a unique accessibility region identifier.');
    const scope = scopes[0]; nodes = nodes.filter(node => node.index === scope.index || ancestors(node, raw.nodes).some(parent => parent.index === scope.index));
  }
  let matches = nodes.filter(node => (target.by === 'id' ? node.identifier === target.text : name(node) === target.text) && (target.by !== 'role' || normalizedRole(node) === target.role) && (assertion.kind !== 'checked' || normalizedRole(node) === 'checkbox') && (target.by !== 'label' || ['textbox', 'checkbox'].includes(normalizedRole(node)) || ['number', 'value'].includes(assertion.kind) && node.value !== undefined));
  if (target.by === 'record') {
    const records = matches.map(node => [node, ...ancestors(node, raw.nodes)].find(parent => normalizedRole(parent) === 'listitem'));
    if (!records.length || records.some(record => !record)) throw new BlockedError('This native screen does not expose semantic records for the exact entity. Use a supported text/identifier check.');
    matches = [...new Map(records.map(record => [record!.index, record!])).values()];
  }
  // Native buttons often expose a same-named child text node. Count semantic
  // occurrences once, without collapsing different sibling entities.
  matches = matches.filter(node => !ancestors(node, raw.nodes).some(parent => matches.some(match => match.index === parent.index)));
  const shown = matches.filter(visible);
  const complete = raw.truncated === false && raw.visibility?.partial === false && !raw.nodes.some(node => node.hiddenContentAbove || node.hiddenContentBelow) && ['healthy', 'recovered'].includes(raw.snapshotQuality?.state ?? '');
  let observed: CheckResult['observed'];
  if (['absent', 'count'].includes(assertion.kind) && !complete) throw new BlockedError('Absence/count needs a complete visible native collection. Scroll-hidden or truncated evidence cannot prove it.');
  if (assertion.kind === 'visible' && !shown.length && !complete) throw new BlockedError('Incomplete native evidence cannot establish that the expected element is missing.');
  if (assertion.kind === 'visible' || assertion.kind === 'absent') observed = shown.length > 0;
  else if (assertion.kind === 'count') observed = shown.length;
  else {
    if (shown.length !== 1) throw new BlockedError('Native field/state evidence is missing or ambiguous.');
    const node = shown[0];
    if (assertion.kind === 'checked') { observed = selected(node); if (observed === null) throw new BlockedError('Native control does not expose selected state.'); }
    else if (assertion.kind === 'value') { if (node.value === undefined && node.hintShowing !== true || node.password) throw new BlockedError('Native control does not expose a readable, non-secret value.'); observed = node.hintShowing === true ? '' : node.value!; }
    else if (assertion.kind === 'number') { const value = node.value ?? node.label; if (value === undefined) throw new BlockedError('Native control does not expose a number.'); observed = parseNumber(value); if (observed === null) throw new BlockedError('Native numeric value is not an exact readable number.'); }
    else throw new BlockedError('This assertion is unsupported for native apps.');
  }
  return { assertion, passed: observed === assertion.expected, observed, ...(observed === assertion.expected ? {} : { reason: 'Observed native state contradicted the authored expectation.' }) };
}
export class MobileDriver {
  readonly connection: DeviceConnection;
  target: NativeTarget;
  private selection: { platform: 'ios' | 'android'; udid?: string; serial?: string };
  private appIdentity: string;
  private opened = false;
  private ready = false;
  private recording = false;
  private recordingPath?: string;
  private recordingArtifacts = new Set<string>();
  private recordingDirectoryBaseline = new Set<string>();
  recordingMetrics?: { durationMs: number; capturedDurationMs?: number; backend?: string; recorder?: 'confirmed'; nativePathDisposition?: 'retirable' | 'retired' };
  recordingDiscardedReason?: string;
  constructor(target: NativeTarget, private secrets: string[]) {
    this.target = target; this.connection = new DeviceConnection(target.platform);
    this.appIdentity = target.app;
    this.selection = { platform: target.platform };
  }
  async open(signal: AbortSignal): Promise<void> {
    const devices = await this.connection.call('devices', { platform: this.target.platform }, signal);
    const device = selectDevice(devices, this.target.platform, this.target.device || undefined);
    this.target.device = device.id;
    this.selection = { platform: this.target.platform, ...(this.target.platform === 'ios' ? { udid: device.id } : { serial: device.id }) };
    const appInput = this.target.app, appPath = resolve(appInput), extension = extname(appInput).toLowerCase();
    const build = await stat(appPath).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    const pathLike = appInput.includes('/') || appInput.includes('\\') || appInput.startsWith('.');
    if (build) {
      const expected = this.target.platform === 'ios' ? '.app' : '.apk';
      if (extension !== expected) throw new BlockedError(`${this.target.platform} build paths must end in ${expected}.`);
      const installed = await this.connection.call('install', { ...this.selection, appPath }, signal, 60000);
      const identity = installed.bundleId ?? installed.package ?? installed.appId;
      if (!identity || !matchesDisclosedIdentity(identity, [installed.bundleId, installed.package, installed.appId, installed.identifiers?.appBundleId, installed.identifiers?.appId, installed.identifiers?.package])
        || !matchesDisclosedIdentity(this.target.device, [installed.identifiers?.deviceId, installed.identifiers?.udid, installed.identifiers?.serial])) throw new BlockedError('Installed build did not expose the selected device and app identity.');
      this.appIdentity = identity;
    } else if (pathLike) throw new BlockedError('Native build path does not exist. Pass an existing .app/.apk path or an installed app ID.');
    this.opened = true;
    const result = await this.connection.call('open', { ...this.selection, app: this.appIdentity, relaunch: true, timeoutMs: 60000 }, signal, 60000);
    assertOpenedIdentity(result, this.appIdentity, this.target.device);
    this.ready = true;
  }
  async observe(signal: AbortSignal): Promise<NativeObservation> {
    if (!this.ready) throw new BlockedError('Open an owned native app session before capturing evidence.');
    const end = Date.now() + 5000;
    do {
      const raw = await this.rawSnapshot(signal);
      // A newly launched React Native app may initially expose only its root.
      // Waiting for evidence is safe; interpreting that tree as an absent field isn't.
      if (raw.nodes?.some(node => node.index !== 0 && visible(node)) && raw.snapshotQuality?.state !== 'sparse') {
        if (this.recording && !this.captureAllowed(raw)) {
          // Discard the whole local clip if a later screen exposes an input or
          // known secret. It must never become a shareable report artifact.
          await this.finishRecording(signal, false);
        }
        return normalizeNative(raw, this.appIdentity, this.secrets, this.target.device);
      }
      await delay(100, undefined, { signal });
    } while (Date.now() < end);
    throw new BlockedError('App accessibility content did not become ready within five seconds.');
  }
  async execute(observation: NativeObservation, control: Control, step: Step, value: string | null, signal: AbortSignal, onDispatch: () => void = () => {}): Promise<void> {
    // Refresh before dispatch, then pin the ref frame. A changed semantic target
    // or modal context is a block; it must never become an automatic mutation retry.
    const fresh = await this.observe(signal);
    const matches = fresh.controls.filter(item => item.fingerprint === control.fingerprint && item.capabilities?.includes(step.action) && !item.disabled);
    if (matches.length !== 1 || !observation.nodes.has(control.id)) throw new BlockedError('Native target changed or became ambiguous before dispatch.');
    const current = matches[0], node = fresh.nodes.get(current.id)!;
    if (fresh.native.refsGeneration === undefined) throw new BlockedError('Native backend cannot pin the observed ref generation.');
    const ref = `@${node.ref.replace(/^@/, '')}~s${fresh.native.refsGeneration}`;
    const options = { ref, settle: true, settleQuietMs: 100, timeoutMs: 1500 };
    if (step.action === 'fill') {
      if (value === null) throw new BlockedError('Native fill requires an input value.');
      if (this.target.platform === 'android' && node.hintShowing !== true && node.value && value !== '') {
        if (!node.identifier) throw new BlockedError('Replacing Android text requires a stable control ID.');
        // Clearing a controlled Android field can replace its InputConnection.
        // Verify clear and focus before typing once into the new connection.
        onDispatch(); const cleared = await this.connection.call('fill', { ...options, text: '' }, signal, 20000);
        if (cleared.verification === 'unconfirmed') throw new BlockedError('Android clear was unconfirmed. It was not repeated.');
        const empty = await this.observe(signal), inputs = empty.controls.filter(item => item.identifier === node.identifier && item.role === 'textbox');
        if (inputs.length !== 1) throw new BlockedError('Android input changed after clearing.');
        const input = empty.nodes.get(inputs[0].id)!;
        if ((input.hintShowing === true ? '' : input.value) !== '' || !await androidInputFocused(input, this.target.device, this.appIdentity, signal)) throw new BlockedError('Android input could not confirm empty text and focus. No typing was dispatched.');
        await this.connection.call('type', { text: value, settle: true, settleQuietMs: 100, timeoutMs: 1500 }, signal, 20000);
        const verified = await this.check({kind:'value', target:{by:'id',text:node.identifier,role:null,within:null},expected:value}, signal);
        if (!verified.passed) throw new BlockedError('Android replacement was unconfirmed. It was not repeated.');
        return;
      }
      // Pace the initial synthesis, as recommended by the pinned iOS backend.
      // This is a single dispatch; an uncertain fill is never retried.
      onDispatch(); const filled = await this.connection.call('fill', { ...options, text: value, ...(this.target.platform === 'ios' ? { delayMs: 80 } : {}) }, signal, 20000);
      if (filled.verification === 'unconfirmed') throw new BlockedError('Native fill could not confirm the requested text. It was not repeated.');
    } else if (step.action === 'check' || step.action === 'uncheck') {
      if (current.checked === null) throw new BlockedError('Native switch state is unavailable.');
      const expected = step.action === 'check';
      if (current.checked !== expected) {
        onDispatch(); await this.connection.call('press', options, signal, 10000);
        const verified = await this.check({ kind: 'checked', target: { by: node.identifier ? 'id' : 'label', text: node.identifier ?? current.label, role: null, within: null }, expected }, signal);
        if (!verified.passed) throw new BlockedError('Native switch change was not confirmed. It was not repeated.');
      }
    } else if (step.action === 'click') { onDispatch(); await this.connection.call('press', options, signal, 10000); }
    else throw new BlockedError('Incompatible native control action.');
    signal.throwIfAborted();
  }
  async direct(step: Step, signal: AbortSignal, onDispatch: () => void = () => {}): Promise<void> {
    if (step.action === 'relaunch') {
      onDispatch(); const opened = await this.connection.call('open', { ...this.selection, app: this.appIdentity, relaunch: true }, signal, 15000);
      try { assertOpenedIdentity(opened, this.appIdentity, this.target.device); }
      catch { throw new BlockedError('Native relaunch selected a different app/device.'); }
      // The iOS backend can expose a partial tree just after open, then attach
      // full-screen accessibility groups a moment later. Wait for a steady
      // semantic tree before choosing the next target; keep exact fingerprints.
      const started = Date.now(), deadline = started + 5000;
      let previous: string | undefined, steady = false;
      do {
        const observed = await this.observe(signal);
        const identity = JSON.stringify(observed.controls.map(control => control.fingerprint).sort());
        steady = identity === previous;
        if (steady && Date.now() - started >= (this.target.platform === 'ios' ? 900 : 400)) break;
        previous = identity;
        await delay(200, undefined, { signal });
      } while (Date.now() < deadline);
      if (!steady) throw new BlockedError('Native accessibility tree did not settle after relaunch. No following action was dispatched.');
    }
    else if (step.action === 'back') { await this.observe(signal); onDispatch(); await this.connection.call('back', { settle: true, settleQuietMs: 100, timeoutMs: 1500 }, signal, 10000); }
    else if (step.action === 'keyboard') {
      const observation = await this.observe(signal);
      const buttons = observation.controls.filter(control => control.capabilities?.includes('click') && /^(dismiss|hide) keyboard$/i.test(control.label));
      if (buttons.length > 1) throw new BlockedError('Keyboard dismissal control is ambiguous.');
      if (buttons.length === 1) await this.execute(observation, buttons[0], { action: 'click', target: buttons[0].label, value: null, fixture: null }, null, signal, onDispatch);
      else { onDispatch(); await this.connection.call('keyboard', { action: 'dismiss' }, signal, 10000); }
    }
    else if (step.action === 'scroll') { await this.observe(signal); onDispatch(); await this.connection.call('scroll', { direction: step.target, amount: 1, settle: true, settleQuietMs: 100, timeoutMs: 1500 }, signal, 10000); }
    else if (step.action === 'wait') {
      const check: Assertion = { kind: 'visible', target: { by: 'text', text: step.target!, role: null, within: null }, expected: true };
      const result = await this.check(check, signal, 5000); if (!result.passed) throw new BlockedError('Required wait target did not appear.');
    } else throw new BlockedError('Unsupported native direct action.');
    signal.throwIfAborted();
  }
  async check(assertion: Assertion, signal: AbortSignal, timeout = 2000): Promise<CheckResult> {
    const end = Date.now() + timeout; let result: CheckResult | undefined;
    do {
      signal.throwIfAborted(); result = nativeCheck((await this.observe(signal)).native, assertion);
      if (result.passed) return result;
      if (Date.now() < end) await delay(100, undefined, { signal });
    } while (Date.now() < end);
    return result!;
  }
  async startRecording(path: string, signal: AbortSignal): Promise<void> {
    const expected = resolve(path);
    const directory = dirname(expected);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const existing = await readdir(directory, { withFileTypes: true });
    if (existing.some(entry => {
      const candidate = resolve(directory, entry.name);
      return candidate !== expected && this.isOwnedRecordingPath(candidate, expected);
    })) throw new BlockedError('The recording output already contains files reserved for this clip. Remove or rename them before recording.');
    this.recordingDirectoryBaseline = new Set(existing.map(entry => entry.name).filter(name => resolve(directory, name) !== expected));
    await removeLocalArtifact(expected);
    // Remember ownership before dispatch. A canceled or timed-out start can
    // still have begun recording on the device; close() removes any clip that
    // the SDK finalizes while releasing the session.
    this.recordingArtifacts.clear(); this.recordingArtifacts.add(expected);
    this.recording = true; this.recordingPath = expected; this.recordingMetrics = undefined; this.recordingDiscardedReason = undefined;
    try {
      const result = await this.connection.call('record', { action: 'start', path: expected, quality: 'medium', hideTouches: true }, signal, 15000);
      const returned = typeof result?.outPath === 'string' ? resolve(result.outPath) : null;
      if (returned && extname(returned).toLowerCase() === '.mp4' && this.trackOwnedRecordingPath(returned, expected)) this.recordingArtifacts.add(returned);
      if (result?.recording !== 'started' || returned !== expected || result.showTouches !== false || result.recordingScope !== 'app' || result.activeSessionApp?.bundleId !== this.appIdentity) {
        this.recordingDiscardedReason = 'Recording start returned unsafe or mismatched scope/path evidence. Owned artifacts are discarded when the native session closes.';
        throw new BlockedError('Native recorder did not confirm the requested app-scoped, touch-hidden output.');
      }
    }
    catch (error) { this.recordingDiscardedReason = 'Recording start was not confirmed. The owned artifact is discarded when the native session closes.'; throw error; }
  }
  async stopRecording(signal: AbortSignal): Promise<string | null> {
    if (!this.recording) return null;
    let safe = false;
    try {
      const raw = await this.rawSnapshot(signal);
      safe = raw.nodes?.length > 0 && ['healthy', 'recovered'].includes(raw.snapshotQuality?.state ?? '') && this.captureAllowed(raw);
    } catch { /* Missing final evidence must discard pixels, never publish them. */ }
    return this.finishRecording(signal, safe);
  }
  private async finishRecording(signal: AbortSignal, safe: boolean): Promise<string | null> {
    const result = await this.connection.call('record', { action: 'stop' }, signal, 20000);
    const path = this.recordingPath;
    const returned = typeof result?.outPath === 'string' ? resolve(result.outPath) : null;
    const expected = path ? resolve(path) : null;
    const withinOwnedDirectory = Boolean(expected && returned && extname(returned).toLowerCase() === '.mp4' && this.trackOwnedRecordingPath(returned, expected));
    if (expected) {
      this.trackOwnedRecordingPath(result?.telemetryPath, expected);
      for (const artifact of Array.isArray(result?.artifacts) ? result.artifacts : []) {
        if (!['screen-recording', 'screen-recording-chunk', 'screen-recording-telemetry'].includes(artifact?.artifactType ?? '')) continue;
        this.trackOwnedRecordingPath(artifact?.localPath, expected);
        this.trackOwnedRecordingPath(artifact?.path, expected);
      }
      for (const chunk of Array.isArray(result?.chunks) ? result.chunks : []) this.trackOwnedRecordingPath(chunk?.path, expected);
    }
    if (result?.recording !== 'stopped' || !expected || returned !== expected) {
      this.recordingDiscardedReason = returned && !withinOwnedDirectory ? 'Recorder returned a path outside the approved recording names or directory. It was not published or deleted automatically.' : 'Recorder returned an invalid artifact identity. Owned recording files were discarded.';
      await this.discardOwnedRecordings();
      throw new BlockedError('Native recorder returned an invalid artifact identity. Owned recording files were discarded; an external returned path is never deleted automatically.');
    }
    if (!Number.isFinite(result.durationMs) || result.durationMs <= 0 || result.capturedDurationMs !== undefined && (!Number.isFinite(result.capturedDurationMs) || result.capturedDurationMs <= 0)) {
      this.recordingDiscardedReason = 'Recorder produced no usable timeline. Owned recording files were discarded.'; await this.discardOwnedRecordings();
      throw new BlockedError('Native recorder produced no usable timeline.');
    }
    if (result.showTouches !== false || result.recordingScope !== 'app' || result.activeSessionApp?.bundleId !== this.appIdentity || result.recorder !== 'confirmed' || result.nativePathDisposition === 'pending') {
      this.recordingDiscardedReason = 'Recorder termination, app scope, or native-path safety was not confirmed. Owned recording files were discarded.';
      await this.discardOwnedRecordings();
      throw new BlockedError('Native recorder returned unsafe lifecycle evidence. The clip was discarded.');
    }
    if (!safe) {
      this.recordingDiscardedReason = 'Recording was discarded because the final screen was unsafe or could not be verified.';
      await this.discardOwnedRecordings(); this.recording = false; this.recordingPath = undefined; return null;
    }
    const artifact = await lstat(expected).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (!artifact?.isFile() || artifact.size <= 0) {
      this.recordingDiscardedReason = 'Recorder did not create a new nonempty local file. Owned recording files were discarded.';
      await this.discardOwnedRecordings();
      throw new BlockedError('Native recorder did not produce a fresh usable artifact.');
    }
    await chmod(expected, 0o600);
    try { await this.discardOwnedRecordings(expected); }
    catch {
      this.recordingDiscardedReason = 'Auxiliary recorder artifacts could not be removed safely. The recording was not published.';
      await this.discardOwnedRecordings();
      throw new BlockedError('Native recorder auxiliary artifact cleanup failed. The clip was discarded.');
    }
    this.recordingMetrics = { durationMs: result.durationMs, ...(result.capturedDurationMs === undefined ? {} : {capturedDurationMs:result.capturedDurationMs}), ...(result.recordingBackend ? {backend:result.recordingBackend} : {}), ...(result.recorder === 'confirmed' ? {recorder:result.recorder} : {}), ...(['retirable','retired'].includes(result.nativePathDisposition) ? {nativePathDisposition:result.nativePathDisposition as 'retirable' | 'retired'} : {}) };
    this.recording = false; this.recordingArtifacts.clear();
    return expected;
  }
  async screenshot(path: string, signal: AbortSignal): Promise<boolean> {
    // Conservatively omit pixels when any private field/known secret is visible.
    // This avoids a new image dependency and is safer than text-only redaction.
    const expected = resolve(path); await mkdir(dirname(expected), { recursive: true, mode: 0o700 }); await removeLocalArtifact(expected);
    const observation = await this.observe(signal);
    if (!this.captureAllowed(observation.native)) return false;
    let result: any;
    try { result = await this.connection.call('screenshot', { path: expected, normalizeStatusBar: true, surface: 'app' }, signal, 10000); }
    catch (error) { await removeLocalArtifact(expected); throw error; }
    const returned = typeof result?.path === 'string' ? resolve(result.path) : null;
    // Only the exact predeclared output path belongs to this capture. A
    // malformed response must never make an unrelated file in --out deletable.
    const discard = async () => removeLocalArtifact(expected);
    const identifiers = result?.identifiers;
    const returnedApps = [identifiers?.appBundleId, identifiers?.appId, identifiers?.package].filter(value => value !== undefined && value !== null);
    const returnedDevices = [identifiers?.deviceId, identifiers?.udid, identifiers?.serial].filter(value => value !== undefined && value !== null);
    if (returnedApps.some(value => value !== this.appIdentity) || returnedDevices.some(value => value !== this.target.device)) {
      await discard();
      throw new BlockedError('Native screenshot returned mismatched app/device identity. The artifact was discarded.');
    }
    let finalState: NativeSnapshot;
    try { finalState = await this.rawSnapshot(signal); }
    catch { await discard(); throw new BlockedError('Native screenshot ownership could not be confirmed after capture. The artifact was discarded.'); }
    if (!finalState.nodes?.length || !['healthy', 'recovered'].includes(finalState.snapshotQuality?.state ?? '') || !this.captureAllowed(finalState)) {
      await discard();
      throw new BlockedError('Native screenshot ended on an unsafe or mismatched app screen. The artifact was discarded.');
    }
    const artifact = await lstat(expected).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (returned !== expected || !artifact?.isFile() || artifact.size <= 0) { await discard(); throw new BlockedError('Native screenshot did not produce the requested fresh local artifact.'); }
    await chmod(expected, 0o600); return true;
  }
  interrupt() { this.connection.interrupt(); }
  get interrupted(): boolean { return this.connection.interrupted; }
  captureAllowed(raw: NativeSnapshot): boolean {
    return !isSystemSurface(raw) && !raw.nodes.some(node => normalizedRole(node) === 'textbox' || node.password || this.secrets.some(secret => secret && `${node.label ?? ''} ${node.value ?? ''} ${node.identifier ?? ''}`.includes(secret)));
  }
  private async rawSnapshot(signal: AbortSignal): Promise<NativeSnapshot> {
    let raw = await this.connection.call<NativeSnapshot>('snapshot', { forceFull: true, timeoutMs: 15000 }, signal, 20000);
    assertSnapshotOwnership(raw, this.appIdentity, this.target.device);
    if (this.target.platform === 'android' && raw.appBundleId === this.appIdentity) raw = await readAndroidChecked(raw, this.target.device, this.appIdentity, signal);
    assertSnapshotOwnership(raw, this.appIdentity, this.target.device);
    return raw;
  }
  get resolvedApp(): string { return this.appIdentity; }
  private isOwnedRecordingPath(candidate: unknown, expected: string): boolean {
    if (typeof candidate !== 'string') return false;
    const path = resolve(candidate), child = relative(dirname(expected), path);
    if (isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)) return false;
    const expectedFile = parse(expected), candidateFile = parse(path);
    const chunkIndex = candidateFile.name.startsWith(`${expectedFile.name}.part-`) ? candidateFile.name.slice(expectedFile.name.length + 6) : '';
    const ownedName = path === expected
      || candidateFile.base === `${expectedFile.name}.gesture-telemetry.json`
      || candidateFile.ext.toLowerCase() === expectedFile.ext.toLowerCase() && /^\d{3}$/.test(chunkIndex);
    return ownedName;
  }
  private trackOwnedRecordingPath(candidate: unknown, expected: string): boolean {
    if (!this.isOwnedRecordingPath(candidate, expected)) return false;
    this.recordingArtifacts.add(resolve(candidate as string)); return true;
  }
  private async discoverOwnedRecordingArtifacts(): Promise<void> {
    if (!this.recordingPath) return;
    const expected = resolve(this.recordingPath), directory = dirname(expected);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (this.recordingDirectoryBaseline.has(entry.name)) continue;
      const candidate = resolve(directory, entry.name);
      if (this.isOwnedRecordingPath(candidate, expected)) this.recordingArtifacts.add(candidate);
    }
  }
  private async discardOwnedRecordings(preserve?: string): Promise<void> {
    const failed: string[] = [];
    try { await this.discoverOwnedRecordingArtifacts(); }
    catch { failed.push('recording directory scan'); }
    const remaining = new Set<string>();
    for (const path of this.recordingArtifacts) {
      if (path === preserve) { remaining.add(path); continue; }
      try {
        const artifact = await lstat(path);
        if (!artifact.isFile()) { failed.push(path); remaining.add(path); continue; }
        await unlink(path);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { failed.push(path); remaining.add(path); } }
    }
    this.recordingArtifacts = remaining;
    if (failed.length) throw new BlockedError('An unsafe native recording could not be removed from the owned output directory. It was not published.');
  }
  async close(): Promise<void> {
    try {
      if (this.opened) { await this.connection.close(); this.opened = false; this.ready = false; }
      else this.connection.interrupt();
    } finally {
      if (this.recording) { try { await this.discardOwnedRecordings(); } finally { this.recording = false; this.recordingPath = undefined; this.recordingDirectoryBaseline.clear(); } }
    }
  }
}
export async function nativeVersions(target: NativeTarget, signal: AbortSignal): Promise<Record<string, string>> {
  signal.throwIfAborted();
  const execute = promisify(execFile), command = { timeout: 3000, signal, env: nativeToolEnvironment() };
  const versions: Record<string, string> = { backend: 'agent-device@0.21.6', node: process.version, platform: target.platform, app: target.app, device: target.device };
  try {
    if (target.platform === 'ios') {
      const { stdout } = await execute('xcrun', ['simctl', 'list', 'devices', '-j'], command);
      const data = JSON.parse(stdout);
      for (const [runtime, devices] of Object.entries(data.devices) as [string, { udid: string }[]][]) if (devices.some(device => device.udid === target.device)) versions.os = runtime;
      const { stdout: container } = await execute('xcrun', ['simctl', 'get_app_container', target.device, target.app, 'app'], command);
      const { stdout: info } = await execute('plutil', ['-convert', 'json', '-o', '-', resolve(container.trim(), 'Info.plist')], command);
      const metadata = JSON.parse(info); versions.appVersion = `${metadata.CFBundleShortVersionString ?? '?'} (${metadata.CFBundleVersion ?? '?'})`;
    } else {
      const { stdout } = await execute('adb', ['-s', target.device, 'shell', 'getprop', 'ro.build.version.release'], command); versions.os = stdout.trim();
      const { stdout: info } = await execute('adb', ['-s', target.device, 'shell', 'dumpsys', 'package', target.app], command);
      versions.appVersion = `${info.match(/versionName=(\S+)/)?.[1] ?? '?'} (${info.match(/versionCode=(\d+)/)?.[1] ?? '?'})`;
    }
  } catch { signal.throwIfAborted(); versions.os = 'unavailable'; }
  return versions;
}
