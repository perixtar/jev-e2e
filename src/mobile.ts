import { mkdir, chmod, unlink } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { DeviceConnection, selectDevice, type NativeSnapshot } from './device.js';
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
function ancestors(node: Node, nodes: Node[]): Node[] {
  const result: Node[] = [], seen = new Set<number>();
  while (node.parentIndex !== undefined) {
    if (seen.has(node.parentIndex)) break; seen.add(node.parentIndex);
    const parent = nodes.find(item => item.index === node.parentIndex); if (!parent) break;
    result.push(parent); node = parent;
  }
  return result;
}
export function normalizeNative(raw: NativeSnapshot, app: string, secrets: string[]): NativeObservation {
  const actual = raw.appBundleId ?? raw.identifiers?.appBundleId ?? raw.identifiers?.appId;
  if (!actual || actual !== app) throw new BlockedError('The observed app does not match --app. External apps and system dialogs need explicit handling.');
  if (!raw.nodes?.length || !['healthy', 'recovered'].includes(raw.snapshotQuality?.state ?? '')) throw new BlockedError('Native accessibility evidence is empty or unhealthy.');
  const nodes = new Map<string, Node>(), controls: Control[] = [];
  for (const node of raw.nodes) {
    if (!visible(node)) continue;
    const role = normalizedRole(node), label = node.label ?? (node.inheritsLabel ? ancestors(node, raw.nodes).find(parent => parent.label)?.label : undefined) ?? node.identifier ?? '';
    const capabilities: Step['action'][] = role === 'textbox' ? ['fill'] : role === 'checkbox' ? ['check', 'uncheck'] : ['button', 'link'].includes(role) ? ['click'] : [];
    if (!label || !capabilities.length) continue;
    const id = `n${node.index}`, context = ancestors(node, raw.nodes).reverse().map(parent => parent.label || parent.identifier || '').filter(value => value && value !== label).join(' / ').slice(-600);
    const control: Control = { id, tag: 'native', role, label: redact(label, secrets), context: redact(context, secrets), type: node.password || /secure/i.test(node.type ?? '') ? 'password' : node.type ?? '', disabled: node.enabled === false, checked: selected(node), options: [], capabilities, identifier: node.identifier,
      fingerprint: JSON.stringify({ role, label, context, identifier: node.identifier }) };
    if (control.identifier) control.identifier = redact(control.identifier, secrets);
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
  private opened = false;
  private ready = false;
  private recording = false;
  private recordingPath?: string;
  recordingMetrics?: { durationMs: number; capturedDurationMs?: number; backend?: string };
  recordingDiscardedReason?: string;
  constructor(target: NativeTarget, private secrets: string[]) {
    this.target = target; this.connection = new DeviceConnection(target.platform);
    this.selection = { platform: target.platform };
  }
  async open(signal: AbortSignal): Promise<void> {
    const devices = await this.connection.call('devices', { platform: this.target.platform }, signal);
    const device = selectDevice(devices, this.target.platform, this.target.device || undefined);
    this.target.device = device.id;
    this.selection = { platform: this.target.platform, ...(this.target.platform === 'ios' ? { udid: device.id } : { serial: device.id }) };
    const extension = extname(this.target.app).toLowerCase();
    if (extension === '.app' || extension === '.apk') {
      const installed = await this.connection.call('install', { ...this.selection, appPath: resolve(this.target.app) }, signal, 60000);
      const identity = installed.bundleId ?? installed.package ?? installed.appId;
      if (!identity) throw new BlockedError('Installed build did not expose an app identity.');
      this.target.app = identity;
    }
    this.opened = true;
    const result = await this.connection.call('open', { ...this.selection, app: this.target.app, relaunch: true, timeoutMs: 60000 }, signal, 60000);
    if (result.device?.id !== this.target.device || result.appBundleId !== this.target.app) throw new BlockedError('Native open selected a different app/device.');
    this.ready = true;
  }
  async observe(signal: AbortSignal): Promise<NativeObservation> {
    if (!this.ready) throw new BlockedError('Open an owned native app session before capturing evidence.');
    const end = Date.now() + 5000;
    do {
      let raw = await this.connection.call<NativeSnapshot>('snapshot', { forceFull: true, timeoutMs: 15000 }, signal, 20000);
      if (this.target.platform === 'android' && raw.appBundleId === this.target.app) raw = await readAndroidChecked(raw, this.target.device, this.target.app, signal);
      // A newly launched React Native app may initially expose only its root.
      // Waiting for evidence is safe; interpreting that tree as an absent field isn't.
      if (raw.nodes?.some(node => node.index !== 0 && visible(node)) && raw.snapshotQuality?.state !== 'sparse') {
        if (this.recording && !this.captureSafe(raw)) {
          // Discard the whole local clip if a later screen exposes an input or
          // known secret. It must never become a shareable report artifact.
          const path = await this.stopRecording(signal);
          if (path) await unlink(path).catch(() => {});
          this.recordingPath = undefined;
          this.recordingDiscardedReason = 'Recording was discarded because a later screen exposed an input or known secret.';
        }
        return normalizeNative(raw, this.target.app, this.secrets);
      }
      await delay(100, undefined, { signal });
    } while (Date.now() < end);
    throw new BlockedError('App accessibility content did not become ready within five seconds.');
  }
  async execute(observation: NativeObservation, control: Control, step: Step, value: string | null, signal: AbortSignal): Promise<void> {
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
        const cleared = await this.connection.call('fill', { ...options, text: '' }, signal, 20000);
        if (cleared.verification === 'unconfirmed') throw new BlockedError('Android clear was unconfirmed. It was not repeated.');
        const empty = await this.observe(signal), inputs = empty.controls.filter(item => item.identifier === node.identifier && item.role === 'textbox');
        if (inputs.length !== 1) throw new BlockedError('Android input changed after clearing.');
        const input = empty.nodes.get(inputs[0].id)!;
        if ((input.hintShowing === true ? '' : input.value) !== '' || !await androidInputFocused(input, this.target.device, this.target.app, signal)) throw new BlockedError('Android input could not confirm empty text and focus. No typing was dispatched.');
        await this.connection.call('type', { text: value, settle: true, settleQuietMs: 100, timeoutMs: 1500 }, signal, 20000);
        const verified = await this.check({kind:'value', target:{by:'id',text:node.identifier,role:null,within:null},expected:value}, signal);
        if (!verified.passed) throw new BlockedError('Android replacement was unconfirmed. It was not repeated.');
        return;
      }
      // Pace the initial synthesis, as recommended by the pinned iOS backend.
      // This is a single dispatch; an uncertain fill is never retried.
      const filled = await this.connection.call('fill', { ...options, text: value, ...(this.target.platform === 'ios' ? { delayMs: 80 } : {}) }, signal, 20000);
      if (filled.verification === 'unconfirmed') throw new BlockedError('Native fill could not confirm the requested text. It was not repeated.');
    } else if (step.action === 'check' || step.action === 'uncheck') {
      if (current.checked === null) throw new BlockedError('Native switch state is unavailable.');
      if (current.checked !== (step.action === 'check')) await this.connection.call('press', options, signal, 10000);
    } else if (step.action === 'click') await this.connection.call('press', options, signal, 10000);
    else throw new BlockedError('Incompatible native control action.');
    signal.throwIfAborted();
  }
  async direct(step: Step, signal: AbortSignal): Promise<void> {
    if (step.action === 'relaunch') await this.connection.call('open', { ...this.selection, app: this.target.app, relaunch: true }, signal, 15000);
    else if (step.action === 'back') await this.connection.call('back', { settle: true, settleQuietMs: 100, timeoutMs: 1500 }, signal, 10000);
    else if (step.action === 'keyboard') {
      const observation = await this.observe(signal);
      const buttons = observation.controls.filter(control => control.capabilities?.includes('click') && /^(dismiss|hide) keyboard$/i.test(control.label));
      if (buttons.length > 1) throw new BlockedError('Keyboard dismissal control is ambiguous.');
      if (buttons.length === 1) await this.execute(observation, buttons[0], { action: 'click', target: buttons[0].label, value: null, fixture: null }, null, signal);
      else await this.connection.call('keyboard', { action: 'dismiss' }, signal, 10000);
    }
    else if (step.action === 'scroll') await this.connection.call('scroll', { direction: step.target, amount: 1, settle: true, settleQuietMs: 100, timeoutMs: 1500 }, signal, 10000);
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
    await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
    await this.connection.call('record', { action: 'start', path, quality: 'medium', hideTouches: true }, signal, 15000);
    this.recording = true; this.recordingPath = path; this.recordingMetrics = undefined; this.recordingDiscardedReason = undefined;
  }
  async stopRecording(signal: AbortSignal): Promise<string | null> {
    if (!this.recording) return null;
    const result = await this.connection.call('record', { action: 'stop' }, signal, 20000);
    this.recording = false;
    const path = this.recordingPath;
    if (result.recording !== 'stopped' || !path || resolve(result.outPath) !== resolve(path)) throw new BlockedError('Native recorder returned an invalid artifact identity.');
    this.recordingMetrics = { durationMs: result.durationMs, ...(result.capturedDurationMs === undefined ? {} : {capturedDurationMs:result.capturedDurationMs}), ...(result.recordingBackend ? {backend:result.recordingBackend} : {}) };
    if (!Number.isFinite(result.durationMs) || result.durationMs <= 0 || result.capturedDurationMs !== undefined && result.capturedDurationMs <= 0) throw new BlockedError('Native recorder produced no usable timeline.');
    if (path) await chmod(path, 0o600);
    return path ?? null;
  }
  async screenshot(path: string, signal: AbortSignal): Promise<boolean> {
    // Conservatively omit pixels when any private field/known secret is visible.
    // This avoids a new image dependency and is safer than text-only redaction.
    const observation = await this.observe(signal);
    if (!this.captureSafe(observation.native)) return false;
    await this.connection.call('screenshot', { path, normalizeStatusBar: true }, signal, 10000);
    await chmod(path, 0o600); return true;
  }
  interrupt() { this.connection.interrupt(); }
  private captureSafe(raw: NativeSnapshot): boolean {
    return !raw.nodes.some(node => normalizedRole(node) === 'textbox' || node.password || this.secrets.some(secret => secret && `${node.label ?? ''} ${node.value ?? ''} ${node.identifier ?? ''}`.includes(secret)));
  }
  async close(): Promise<void> {
    try {
      if (this.opened) { try { await this.connection.close(); } finally { this.opened = false; this.ready = false; } }
      else this.connection.interrupt();
    } finally {
      if (this.recordingPath && this.recording) { await unlink(this.recordingPath).catch(() => {}); this.recording = false; }
    }
  }
}
export async function nativeVersions(target: NativeTarget): Promise<Record<string, string>> {
  const execute = promisify(execFile), versions: Record<string, string> = { backend: 'agent-device@0.21.6', node: process.version, platform: target.platform, app: target.app, device: target.device };
  try {
    if (target.platform === 'ios') {
      const { stdout } = await execute('xcrun', ['simctl', 'list', 'devices', '-j'], { timeout: 3000 });
      const data = JSON.parse(stdout);
      for (const [runtime, devices] of Object.entries(data.devices) as [string, { udid: string }[]][]) if (devices.some(device => device.udid === target.device)) versions.os = runtime;
      const { stdout: container } = await execute('xcrun', ['simctl', 'get_app_container', target.device, target.app, 'app'], { timeout: 3000 });
      const { stdout: info } = await execute('plutil', ['-convert', 'json', '-o', '-', resolve(container.trim(), 'Info.plist')], { timeout: 3000 });
      const metadata = JSON.parse(info); versions.appVersion = `${metadata.CFBundleShortVersionString ?? '?'} (${metadata.CFBundleVersion ?? '?'})`;
    } else {
      const { stdout } = await execute('adb', ['-s', target.device, 'shell', 'getprop', 'ro.build.version.release'], { timeout: 3000 }); versions.os = stdout.trim();
      const { stdout: info } = await execute('adb', ['-s', target.device, 'shell', 'dumpsys', 'package', target.app], { timeout: 3000 });
      versions.appVersion = `${info.match(/versionName=(\S+)/)?.[1] ?? '?'} (${info.match(/versionCode=(\d+)/)?.[1] ?? '?'})`;
    }
  } catch { versions.os = 'unavailable'; }
  return versions;
}
