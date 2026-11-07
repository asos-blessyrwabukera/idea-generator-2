// The Claude CLI provider: runs the local `claude` binary (subscription login, no API key).
// A fake CLI script records how it was called and answers like `claude -p --output-format json`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_APP_SETTINGS, listModels, makeChat, mergeAppSettings, ProviderError, type AppSettings } from '../server/providers.ts';

function useCommand(c: string) {
  process.env.CLAUDE_CLI_PATH = c;
}

let dir = '';
let callLog = '';
let answerFile = '';

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'fake-claude-'));
  callLog = join(dir, 'call.json');
  answerFile = join(dir, 'answer.json');
  // The executable comes from the server's environment, never from browser-pushed settings.
  useCommand(`"${process.execPath}" "${join(dir, 'fake.mjs')}"`);
  writeFileSync(
    join(dir, 'fake.mjs'),
    `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const stdin = readFileSync(0, 'utf8');
writeFileSync(${JSON.stringify(callLog)}, JSON.stringify({ args: process.argv.slice(2), stdin }));
const answer = JSON.parse(readFileSync(${JSON.stringify(answerFile)}, 'utf8'));
if (answer.delayMs) {
  appendFileSync(${JSON.stringify(callLog + '.events')}, 's\\n');
  await new Promise((r) => setTimeout(r, answer.delayMs));
  appendFileSync(${JSON.stringify(callLog + '.events')}, 'e\\n');
}
if (answer.exit) { process.stderr.write(answer.stderr ?? ''); process.exit(answer.exit); }
process.stdout.write(JSON.stringify(answer.envelope));`,
  );
});
after(() => { delete process.env.CLAUDE_CLI_PATH; rmSync(dir, { recursive: true, force: true }); });

const schema = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false };
const req = (model: string) => ({ model, system: 'be brief', user: 'make an idea', schemaName: 'idea', schema, temperature: 0.9 });
const command = () => `"${process.execPath}" "${join(dir, 'fake.mjs')}"`;
const settingsWith = (): AppSettings => structuredClone(DEFAULT_APP_SETTINGS);
const answer = (a: object) => writeFileSync(answerFile, JSON.stringify(a));
const lastCall = () => JSON.parse(readFileSync(callLog, 'utf8')) as { args: string[]; stdin: string };
const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

test('claude-cli: structured output comes back as the value, costing nothing', async () => {
  answer({ envelope: { type: 'result', is_error: false, structured_output: { title: 'Ok' }, total_cost_usd: 0.04 } });
  const out = await makeChat(settingsWith)(req('claude-cli:sonnet'));
  assert.deepEqual(out.value, { title: 'Ok' });
  assert.equal(out.costUsd, 0, 'a subscription has no per-call cost for the budget limiter');
});

test('claude-cli: prompt goes on stdin; model, system prompt and schema go as flags; no tools, no saved session', async () => {
  answer({ envelope: { type: 'result', is_error: false, structured_output: { title: 'x' } } });
  await makeChat(settingsWith)(req('claude-cli:opus'));
  const { args, stdin } = lastCall();
  assert.equal(stdin, 'make an idea');
  assert.ok(args.includes('-p'));
  assert.equal(flag(args, '--output-format'), 'json');
  assert.equal(flag(args, '--model'), 'opus');
  assert.equal(flag(args, '--system-prompt'), 'be brief');
  assert.deepEqual(JSON.parse(flag(args, '--json-schema')), schema);
  assert.equal(flag(args, '--tools'), '');
  assert.ok(args.includes('--no-session-persistence'));
});

test('claude-cli: falls back to JSON in the text result when there is no structured output', async () => {
  answer({ envelope: { type: 'result', is_error: false, result: 'Sure!\n```json\n{"title":"Text"}\n```' } });
  const out = await makeChat(settingsWith)(req('claude-cli:haiku'));
  assert.deepEqual(out.value, { title: 'Text' });
});

test('claude-cli: a logged-out CLI is a bad_key-style error, not a retry loop', async () => {
  answer({ envelope: { type: 'result', is_error: true, result: 'Not logged in · Please run /login' } });
  await assert.rejects(makeChat(settingsWith)(req('claude-cli:sonnet')), (e: any) => e instanceof ProviderError && e.code === 'not_logged_in');
});

test('claude-cli: a missing binary says so', async () => {
  const real = process.env.CLAUDE_CLI_PATH!;
  useCommand(join(dir, 'does-not-exist'));
  try {
    await assert.rejects(makeChat(settingsWith)(req('claude-cli:sonnet')), (e: any) => e instanceof ProviderError && e.code === 'unreachable');
  } finally {
    useCommand(real);
  }
});

test('claude-cli: cannot search X, and lists model aliases as its connection test', async () => {
  answer({ envelope: { type: 'result', is_error: false, structured_output: {} } });
  await assert.rejects(makeChat(settingsWith)({ ...req('claude-cli:sonnet'), plugins: [{ id: 'web' }] }), (e: any) => e.code === 'no_search');
  assert.deepEqual(await listModels(settingsWith(), 'claude-cli'), ['opus', 'sonnet', 'haiku']);
});

test('claude-cli: at most 3 CLI processes run at once, the rest wait their turn', async () => {
  answer({ delayMs: 300, envelope: { type: 'result', is_error: false, structured_output: { title: 'Ok' } } });
  const chat = makeChat(settingsWith);
  const results = await Promise.all(Array.from({ length: 8 }, () => chat(req('claude-cli:haiku'))));
  assert.equal(results.length, 8);
  const events = readFileSync(callLog + '.events', 'utf8').trim().split('\n');
  const peak = events.reduce((acc, e) => {
    const running = acc.running + (e === 's' ? 1 : -1);
    return { running, peak: Math.max(acc.peak, running) };
  }, { running: 0, peak: 0 }).peak;
  assert.equal(events.filter((e) => e === 's').length, 8);
  assert.ok(peak <= 3, `peak concurrency was ${peak}`);
  assert.ok(peak >= 2, 'it still runs in parallel');
});

test('claude-cli: a command pushed from the browser is ignored and never executed', async () => {
  const marker = join(dir, 'pwned');
  const hostile = mergeAppSettings({ baseUrls: { 'claude-cli': `"${process.execPath}" -e "require('fs').writeFileSync('${marker.replace(/\\/g, '/')}','x')"` } });
  assert.equal(hostile.baseUrls['claude-cli'], undefined);
  answer({ envelope: { type: 'result', is_error: false, structured_output: { title: 'Ok' } } });
  await makeChat(() => hostile)(req('claude-cli:sonnet'));
  assert.equal(existsSync(marker), false);
});
