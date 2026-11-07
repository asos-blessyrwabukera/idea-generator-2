// The local API must only answer the app's own page: a malicious website in the same browser
// (cross-site request, or DNS rebinding to 127.0.0.1) must not reach it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import { join } from 'node:path';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { createAutopilot } from '../server/autopilot.ts';
import { createHandler } from '../server/app.ts';
import { checkRequest } from '../server/origin-guard.ts';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '../server/providers.ts';

let settings: AppSettings = structuredClone(DEFAULT_APP_SETTINGS);
const runtime = { get: () => settings, set: (s: AppSettings) => { settings = s; }, received: () => true };
const repo = openDb(':memory:');
const engine = createEngine({
  repo, chat: async () => ({ value: {}, costUsd: 0 }), settings: () => settings, gitInit: false,
  fetchPage: async () => ({ title: '', text: '' }), fetchPapers: async () => [], reveal: () => {},
});
const autopilot = createAutopilot({ repo, engine, settings: () => settings });
let server: Server;
let port = 0;

before(async () => {
  server = createServer(createHandler({ repo, engine, autopilot, runtime, publicDir: join(import.meta.dirname, '..', 'public') }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as any).port;
});
after(() => server.close());

type Reply = { status: number; body: string };
const send = (method: string, path: string, headers: Record<string, string>, body?: string) =>
  new Promise<Reply>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
const own = () => ({ Host: `localhost:${port}` });
const json = { 'Content-Type': 'application/json' };

test('pure check: loopback hosts pass, other hosts are DNS-rebinding attempts', () => {
  assert.equal(checkRequest({ method: 'GET', headers: { host: 'localhost:8300' } }), null);
  assert.equal(checkRequest({ method: 'GET', headers: { host: '127.0.0.1:8300' } }), null);
  assert.equal(checkRequest({ method: 'GET', headers: { host: '[::1]:8300' } }), null);
  assert.equal(checkRequest({ method: 'GET', headers: { host: 'evil.example:8300' } })?.status, 403);
  assert.equal(checkRequest({ method: 'GET', headers: { host: 'localhost.evil.example' } })?.status, 403);
  assert.equal(checkRequest({ method: 'GET', headers: {} })?.status, 403, 'no Host header at all');
});

test('pure check: a cross-site Origin is refused, the app\'s own Origin passes, no Origin passes', () => {
  const host = 'localhost:8300';
  assert.equal(checkRequest({ method: 'PUT', headers: { host, origin: 'http://localhost:8300' } }), null);
  assert.equal(checkRequest({ method: 'PUT', headers: { host } }), null, 'curl and server-side callers send no Origin');
  assert.equal(checkRequest({ method: 'PUT', headers: { host, origin: 'https://evil.example' } })?.status, 403);
  assert.equal(checkRequest({ method: 'PUT', headers: { host, origin: 'http://localhost:9999' } })?.status, 403, 'another local app on another port');
  assert.equal(checkRequest({ method: 'PUT', headers: { host, origin: 'null' } })?.status, 403, 'sandboxed iframes and file pages');
});

test('pure check: a request with a body must declare JSON', () => {
  const host = 'localhost:8300';
  assert.equal(checkRequest({ method: 'POST', headers: { host, 'content-length': '12', 'content-type': 'application/json' } }), null);
  assert.equal(checkRequest({ method: 'POST', headers: { host, 'content-length': '12', 'content-type': 'application/json; charset=utf-8' } }), null);
  assert.equal(checkRequest({ method: 'POST', headers: { host, 'content-length': '12', 'content-type': 'text/plain' } })?.status, 415);
  assert.equal(checkRequest({ method: 'POST', headers: { host, 'content-length': '12' } })?.status, 415);
  assert.equal(checkRequest({ method: 'POST', headers: { host, 'content-length': '0' } }), null, 'an empty POST has nothing to forge');
});

test('API: the app\'s own page works', async () => {
  const page = await send('GET', '/', own());
  assert.equal(page.status, 200);
  const created = await send('POST', '/api/boards', { ...own(), Origin: `http://localhost:${port}`, ...json }, JSON.stringify({ lang: 'en' }));
  assert.equal(created.status, 200);
});

test('API: settings cannot be pushed from another website', async () => {
  const before = JSON.stringify(settings);
  const forged = await send('PUT', '/api/runtime-settings', { ...own(), Origin: 'https://evil.example', ...json }, JSON.stringify({ projectsRoot: '/tmp/evil' }));
  assert.equal(forged.status, 403);
  assert.equal(JSON.stringify(settings), before, 'the settings are untouched');
});

test('API: a text/plain "simple request" cannot smuggle JSON in', async () => {
  const forged = await send('PUT', '/api/runtime-settings', { ...own(), 'Content-Type': 'text/plain' }, JSON.stringify({ projectsRoot: '/tmp/evil' }));
  assert.equal(forged.status, 415);
});

test('API: a rebinding hostname gets no answer, not even the static page', async () => {
  assert.equal((await send('GET', '/api/boards', { Host: 'attacker.example' })).status, 403);
  assert.equal((await send('GET', '/', { Host: 'attacker.example' })).status, 403);
});
