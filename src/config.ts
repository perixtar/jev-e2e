import { existsSync, readFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { resolve, dirname } from 'node:path';
import { BlockedError, type Fixtures } from './types.js';

export function loadEnvironment(path = resolve('.env')): void {
  if (existsSync(path)) loadEnvFile(path);
}
export function readFixtures(path?: string, env: NodeJS.ProcessEnv = process.env): Fixtures {
  if (!path) return { inputs: {}, auth: {} };
  const location = resolve(path);
  const raw = JSON.parse(readFileSync(location, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BlockedError('Fixtures must be a JSON object.');
  const result: Fixtures = { inputs: {}, auth: {} };
  for (const [name, value] of Object.entries(raw.inputs ?? {})) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BlockedError(`Invalid input fixture ${name}.`);
    const item = value as Record<string, unknown>;
    if ((typeof item.env === 'string') === (typeof item.value === 'string')) throw new BlockedError(`Fixture ${name} needs either env or value.`);
    if (typeof item.env === 'string') result.inputs[name] = { value: env[item.env], env: item.env };
    else result.inputs[name] = { value: item.value as string };
  }
  for (const [name, value] of Object.entries(raw.auth ?? {})) {
    const state = (value as { storageState?: unknown })?.storageState;
    if (typeof state !== 'string') throw new BlockedError(`Auth fixture ${name} needs storageState.`);
    result.auth[name] = { storageState: resolve(dirname(location), state) };
  }
  return result;
}
export function secretValues(fixtures: Fixtures, env: NodeJS.ProcessEnv = process.env): string[] {
  const authSecrets: string[] = [];
  for (const fixture of Object.values(fixtures.auth)) {
    try {
      const state = JSON.parse(readFileSync(fixture.storageState, 'utf8'));
      for (const cookie of state.cookies ?? []) if (typeof cookie.value === 'string' && cookie.value) authSecrets.push(cookie.value);
      for (const origin of state.origins ?? []) for (const entry of origin.localStorage ?? []) if (typeof entry.value === 'string' && entry.value) authSecrets.push(entry.value);
    } catch { /* Missing/invalid auth is rejected before browser execution. */ }
  }
  return [...new Set([
    ...authSecrets,
    ...Object.values(fixtures.inputs).map(value => value.value),
    env.OPENROUTER_API_KEY, env.OPENAI_API_KEY, env.TYPESAFE_API_KEY,
  ].filter((value): value is string => Boolean(value)))].sort((a, b) => b.length - a.length);
}
export function redact(value: string, secrets: string[]): string {
  for (const secret of secrets) {
    value = value.split(secret).join('[REDACTED]');
    // Observations are clipped in the browser; hide a known value cut at that boundary.
    if (secret.length > 8) {
      const index = value.lastIndexOf(secret.slice(0, 8));
      if (index >= 0 && secret.startsWith(value.slice(index))) value = `${value.slice(0, index)}[REDACTED]`;
    }
  }
  return value.replace(/sk-(?:or-)?[A-Za-z0-9_-]{16,}/g, '[REDACTED_API_KEY]');
}
export function sanitize<T>(value: T, secrets: string[]): T {
  if (typeof value === 'string') return redact(value, secrets) as T;
  if (Array.isArray(value)) return value.map(item => sanitize(item, secrets)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item, secrets)])) as T;
  return value;
}
export function containsSecret(value: unknown, secrets: string[]): boolean {
  if (typeof value === 'string') return secrets.some(secret => secret && value.includes(secret));
  if (Array.isArray(value)) return value.some(item => containsSecret(item, secrets));
  if (value && typeof value === 'object') return Object.values(value).some(item => containsSecret(item, secrets));
  return false;
}
export function validUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new BlockedError('Provide a complete http:// or https:// app URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new BlockedError('Use an HTTP(S) URL without embedded credentials.');
  return url.href;
}
