import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {nativeToolEnvironment, type NativeSnapshot} from './device.js';

const execute = promisify(execFile);
const decode = (value: string) => value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => entity[0] === '#' ? String.fromCodePoint(parseInt(entity.slice(entity[1]?.toLowerCase() === 'x' ? 2 : 1), entity[1]?.toLowerCase() === 'x' ? 16 : 10)) : ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[entity.toLowerCase()]!));

export function androidCheckedEvidence(raw: NativeSnapshot, xml: string, app: string): NativeSnapshot {
  if (!xml.trim().endsWith('</hierarchy>') || !xml.includes('<hierarchy')) return raw;
  const candidates: Record<string, string>[] = [];
  for (const match of xml.matchAll(/<node\b([^<>]+)>/g)) {
    const attrs: Record<string, string> = {};
    for (const attr of match[1].matchAll(/([a-z-]+)="([^"<>]*)"/g)) attrs[attr[1]] = decode(attr[2]);
    if (attrs.package === app && attrs.checkable === 'true' && ['true', 'false'].includes(attrs.checked)) candidates.push(attrs);
  }
  return {...raw, nodes: raw.nodes.map(node => {
    if (!/switch|checkbox|toggle/i.test(node.type ?? '') || !node.identifier || !node.rect) return node;
    const matches = candidates.filter(item => {
      const bounds = item.bounds?.match(/^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/);
      if (!bounds || item['resource-id'] !== node.identifier || item.class !== node.type) return false;
      const [,x,y,right,bottom] = bounds.map(Number);
      return x === node.rect!.x && y === node.rect!.y && right-x === node.rect!.width && bottom-y === node.rect!.height;
    });
    return matches.length === 1 ? {...node, checked: matches[0].checked === 'true'} : node;
  })};
}

async function readAndroidXml(device: string, signal: AbortSignal): Promise<string | null> {
  const path = `/data/local/tmp/jev-checked-${randomUUID()}.xml`;
  const env = nativeToolEnvironment();
  const options = {env, signal, timeout:4000, maxBuffer:5_000_000};
  try {
    // UIAutomation permits one reader. Pause this device's SDK-owned helper,
    // keeping the SDK session/lease; apps.close would also release ownership.
    // The next SDK capture restarts its helper. The tested app stays open.
    await execute('adb', ['-s', device, 'shell', 'am', 'force-stop', 'com.callstack.agentdevice.snapshothelper'], options);
    await execute('adb', ['-s', device, 'shell', 'uiautomator', 'dump', path], options);
    const {stdout} = await execute('adb', ['-s', device, 'exec-out', 'cat', path], options);
    return stdout;
  } catch { signal.throwIfAborted(); return null; }
  finally { await execute('adb', ['-s', device, 'shell', 'rm', '-f', path], {env, timeout:1000}).catch(() => {}); }
}

export async function readAndroidChecked(raw: NativeSnapshot, device: string, app: string, signal: AbortSignal): Promise<NativeSnapshot> {
  if (!raw.nodes.some(node => /switch|checkbox|toggle/i.test(node.type ?? ''))) return raw;
  const xml = await readAndroidXml(device, signal);
  return xml === null ? raw : androidCheckedEvidence(raw, xml, app);
}

export function androidFocusedEvidence(node: NativeSnapshot['nodes'][number], xml: string, app: string): boolean {
  if (!node.identifier || !node.rect || !xml.trim().endsWith('</hierarchy>')) return false;
  const matches: Record<string, string>[] = [];
  for (const match of xml.matchAll(/<node\b([^<>]+)>/g)) {
    const attrs: Record<string, string> = {};
    for (const attr of match[1].matchAll(/([a-z-]+)="([^"<>]*)"/g)) attrs[attr[1]] = decode(attr[2]);
    const bounds = attrs.bounds?.match(/^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/);
    if (!bounds || attrs.package !== app || attrs['resource-id'] !== node.identifier || attrs.class !== node.type) continue;
    const [,x,y,right,bottom] = bounds.map(Number);
    if (x === node.rect.x && y === node.rect.y && right-x === node.rect.width && bottom-y === node.rect.height) matches.push(attrs);
  }
  return matches.length === 1 && matches[0].focused === 'true';
}

export async function androidInputFocused(node: NativeSnapshot['nodes'][number], device: string, app: string, signal: AbortSignal): Promise<boolean> {
  const xml = await readAndroidXml(device, signal);
  return xml !== null && androidFocusedEvidence(node, xml, app);
}
