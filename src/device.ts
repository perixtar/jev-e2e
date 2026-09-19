import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { mkdirSync, chmodSync } from 'node:fs';
import type { createAgentDeviceClient } from 'agent-device';
import { BlockedError } from './types.js';

type Client = ReturnType<typeof createAgentDeviceClient>;
type ClientConfig = NonNullable<Parameters<typeof createAgentDeviceClient>[0]>;
type SdkSnapshot = Awaited<ReturnType<Client['capture']['snapshot']>>;
// Android's pinned SDK omits checked; the read-only platform adapter supplies it.
export type NativeSnapshot = Omit<SdkSnapshot, 'nodes'> & { nodes: (SdkSnapshot['nodes'][number] & { checked?: boolean })[] };
export type Device = Awaited<ReturnType<Client['devices']['list']>>[number];
export class DeviceConnection {
  private worker?: ChildProcess;
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private ownsSession = false;
  private stopping?: Promise<boolean>;
  readonly config: ClientConfig;
  constructor(platform?: 'ios' | 'android', session = `jev-${randomUUID()}`, stateDir = resolve(`.jev-e2e/device-${platform ?? 'inventory'}`)) {
    this.config = { session, stateDir, lockPolicy: 'reject', lockPlatform: platform, responseLevel: 'full' };
  }
  private start() {
    if (this.worker) return this.worker;
    mkdirSync(this.config.stateDir!, { recursive: true, mode: 0o700 }); chmodSync(this.config.stateDir!, 0o700);
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (/API_KEY|TOKEN|PASSWORD|SECRET/i.test(name)) delete env[name];
    const worker = fork(new URL('./device-worker.js', import.meta.url), [], { env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] });
    this.worker = worker;
    worker.on('message', (message: any) => {
      const wait = this.pending.get(message.id); if (!wait) return;
      this.pending.delete(message.id);
      if (message.error) wait.reject(new BlockedError(message.error)); else wait.resolve(message.value);
    });
    const failed = () => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      for (const wait of this.pending.values()) wait.reject(new BlockedError('Native connection stopped. Install agent-device@0.21.6 if it is missing.'));
      this.pending.clear();
    };
    worker.on('error', failed); worker.on('exit', failed);
    return worker;
  }
  async call<T = any>(command: string, args: object, signal: AbortSignal, timeoutMs = 30000): Promise<T> {
    signal.throwIfAborted();
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    const worker = this.start(), id = randomUUID();
    const cancel = () => { this.interrupt(); };
    bounded.addEventListener('abort', cancel, { once: true });
    try {
      if (command === 'open') this.ownsSession = true;
      const value = await new Promise<T>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        worker.send({ id, config: this.config, command, args }, error => { if (error) { this.pending.delete(id); reject(new BlockedError('Native connection failed.')); } });
      });
      if (command === 'close') this.ownsSession = false;
      return value;
    } catch (error) {
      // Only definite pre-acquisition failures are safe to mark unowned. Any
      // other open failure may have acquired SDK resources before failing and
      // must still close through its owning worker.
      const message = error instanceof Error ? error.message : '';
      if (command === 'open' && !bounded.aborted && /in use|claim|lock|another session|no matching device/i.test(message)) this.ownsSession = false;
      throw error;
    } finally { bounded.removeEventListener('abort', cancel); }
  }
  interrupt() {
    const worker = this.worker; this.worker = undefined;
    for (const wait of this.pending.values()) wait.reject(new BlockedError('Native work canceled or exceeded its command deadline. The action was not retried.'));
    this.pending.clear();
    if (!worker) return;
    if (!this.ownsSession) { worker.kill('SIGTERM'); return; }
    // Ask the same owning client to close while the canceled SDK request is
    // still in flight. Killing first can race daemon disconnect cleanup and
    // leave a durable device claim behind.
    const id = randomUUID();
    this.stopping = new Promise<boolean>(resolveStopping => {
      let done = false;
      const finish = (released: boolean) => {
        if (done) return; done = true; clearTimeout(timer);
        worker.removeListener('message', onMessage); worker.removeListener('exit', onExit);
        worker.kill('SIGTERM'); resolveStopping(released);
      };
      const onMessage = (message: any) => { if (message.id === id) finish(!message.error); };
      const onExit = () => finish(false);
      const timer = setTimeout(() => finish(false), 4500); timer.unref();
      worker.on('message', onMessage); worker.once('exit', onExit);
      worker.send({ id, config: this.config, command: 'close', args: {} }, error => { if (error) finish(false); });
    });
  }
  async close(): Promise<void> {
    // Reuse an idle owner connection so its disconnect cleanup cannot race a
    // fresh close request. Cancellation closes through that owner first.
    if (this.pending.size) this.interrupt();
    if (this.stopping) {
      const released = await this.stopping; this.stopping = undefined;
      if (released) { this.ownsSession = false; return; }
    }
    // A connection that lost a lease race must never send sessions.close():
    // on iOS that can interrupt the accessibility runner owned by the winner.
    if (!this.ownsSession) { this.interrupt(); return; }
    try { await this.call('close', {}, AbortSignal.timeout(4500), 4500); }
    catch (error) {
      if (!/session.*not found|session_not_found/i.test(error instanceof Error ? error.message : '')) throw error;
    }
    finally { this.interrupt(); }
  }
}
export function selectDevice(devices: Device[], platform: 'ios' | 'android', selector?: string): Device {
  const candidates = devices.filter(device => device.platform === platform && device.target === 'mobile' && (platform === 'ios' ? device.kind === 'simulator' : device.kind === 'emulator'));
  const matches = selector ? candidates.filter(device => device.id === selector || device.name === selector) : candidates.filter(device => device.booted);
  if (matches.length !== 1) throw new BlockedError(matches.length ? 'Device selection is ambiguous. Run "jev-e2e devices" and pass an exact --device ID.' : 'No matching simulator/emulator. Boot a device, run "jev-e2e devices", and pass its exact --device ID.');
  if (matches[0].claimedBy) throw new BlockedError('This device is in use by another session. Wait for it to finish or choose another device.');
  return matches[0];
}
export async function listDevices(platform?: 'ios' | 'android'): Promise<Device[]> {
  const connection = new DeviceConnection(platform);
  try { return await connection.call<Device[]>('devices', platform ? { platform } : {}, AbortSignal.timeout(30000)); }
  finally { connection.interrupt(); }
}
