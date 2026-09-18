import { createServer, type IncomingMessage } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';

type Project = { id: number; name: string; status: string };
const seed = (): Project[] => [{ id: 1, name: 'Demo', status: 'Active' }, { id: 2, name: 'Legacy', status: 'Archived' }, { id: 3, name: 'Old', status: 'Archived' }];
export const demoCredentials = { email: 'demo@example.test', password: 'demo-password', invalid: 'not-the-password' };
async function body(request: IncomingMessage): Promise<Record<string, any>> {
  let text = ''; for await (const chunk of request) { text += chunk; if (text.length > 10000) throw new Error('Request too large.'); }
  return JSON.parse(text || '{}');
}
export async function startDemo(port = 4177) {
  const html = await readFile(fileURLToPath(new URL('../public/demo.html', import.meta.url)), 'utf8');
  let projects = seed(); let theme = 'Light'; let notifications = false; let fault = ''; let loseCreate = false;
  const reset = (nextFault = '') => { projects = seed(); theme = 'Light'; notifications = false; fault = nextFault; loseCreate = false; };
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      const send = (data: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(data)); };
      if (request.method === 'GET' && !path.startsWith('/api/')) {
        response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" }); response.end(html); return;
      }
      if (request.method === 'POST' && path === '/api/login') {
        const input = await body(request); const valid = input.email === demoCredentials.email && input.password === demoCredentials.password;
        if ((valid && fault !== 'login') || (!valid && fault === 'invalid-login')) { response.setHeader('Set-Cookie', 'demo-session=demo-signed-in; Path=/; HttpOnly; SameSite=Strict'); send({ ok: true }); }
        else send({ error: 'Invalid credentials' }, 401);
        return;
      }
      if (!request.headers.cookie?.includes('demo-session=demo-signed-in')) { send({ error: 'Sign in required' }, 401); return; }
      if (request.method === 'GET' && path === '/api/state') {
        if (loseCreate) { projects = seed(); loseCreate = false; }
        send({ projects, theme, notifications }); return;
      }
      if (request.method === 'POST' && path === '/api/projects') {
        const input = await body(request);
        if (!String(input.name ?? '').trim() && fault !== 'required') { send({ error: 'Project name is required' }, 400); return; }
        if (input.id) { const item = projects.find(item => item.id === input.id); if (item && fault !== 'rename') item.name = String(input.name); }
        else { projects.push({ id: Math.max(...projects.map(item => item.id)) + 1, name: String(input.name ?? '') || 'Untitled', status: 'Active' }); if (fault === 'create') loseCreate = true; }
        send({ projects }); return;
      }
      if (request.method === 'POST' && path === '/api/archive') {
        const input = await body(request); const item = projects.find(item => item.id === input.id);
        if (item && fault !== 'archive') item.status = 'Archived'; send({ projects }); return;
      }
      if (request.method === 'POST' && path === '/api/settings') {
        const input = await body(request); if (fault !== 'theme' && typeof input.theme === 'string') theme = input.theme;
        if (fault !== 'notifications' && typeof input.notifications === 'boolean') notifications = input.notifications;
        send({ ok: true }); return;
      }
      if (request.method === 'GET' && path === '/api/search') {
        const query = new URL(request.url!, 'http://localhost').searchParams.get('q')?.toLowerCase() ?? '';
        const status = new URL(request.url!, 'http://localhost').searchParams.get('status') ?? 'All';
        await new Promise(resolve => setTimeout(resolve, 200));
        send({ projects: projects.filter(item => (fault === 'search' || item.name.toLowerCase().includes(query)) && (fault === 'filter' || status === 'All' || item.status === status)) }); return;
      }
      send({ error: 'Unknown endpoint' }, 404);
    } catch { response.writeHead(400); response.end('Invalid request.'); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Could not start demo.');
  const url = `http://127.0.0.1:${address.port}`;
  return { url, reset, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
    writeFixtures: async (directory = '.jev-e2e/demo') => {
      const location = resolve(directory); await mkdir(location, { recursive: true, mode: 0o700 });
      const state = { cookies: [{ name: 'demo-session', value: 'demo-signed-in', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Strict' }], origins: [] };
      await writeFile(join(location, 'auth.json'), JSON.stringify(state, null, 2), { mode: 0o600 });
      const fixtures = { inputs: { 'valid.email': { value: demoCredentials.email }, 'valid.password': { value: demoCredentials.password }, 'invalid.password': { value: demoCredentials.invalid } }, auth: { 'signed-in': { storageState: 'auth.json' } } };
      await writeFile(join(location, 'fixtures.json'), JSON.stringify(fixtures, null, 2), { mode: 0o600 });
      return join(location, 'fixtures.json');
    },
  };
}
