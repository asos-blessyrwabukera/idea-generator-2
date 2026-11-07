// Everything the web app can do, from the command line: boards, ideas, scouts, reports,
// templates and settings. Same engine, same database, JSON out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_APP_SETTINGS } from '../server/providers.ts';
import { newBoard, session } from './support/cli-session.ts';

// ---- boards

test('board update changes title, goal and config, and rejects bad values', async () => {
  const { run } = session();
  const id = await newBoard(run);
  const { code, out } = await run('board', 'update', id,
    '--title', 'Renamed', '--goal', 'New goal', '--lang', 'en', '--mode', 'auto', '--judge-guidance', 'Be strict',
    '--auto-project', 'off', '--steps-per-hour', '12', '--usd-per-day', '0.5', '--model', 'judge=claude-cli:opus',
    '--x-focus', 'retail', '--research-focus', 'agents');
  assert.equal(code, 0);
  const b = out.board;
  assert.deepEqual([b.title, b.goal, b.config.lang, b.config.mode, b.config.judgeGuidance], ['Renamed', 'New goal', 'en', 'auto', 'Be strict']);
  assert.equal(b.config.autoProjectOnGold, false);
  assert.deepEqual(b.config.rate, { stepsPerHour: 12, usdPerDay: 0.5 });
  assert.equal(b.config.models.judge, 'claude-cli:opus');
  assert.equal(b.config.researchers.x.focus, 'retail');
  assert.equal(b.config.researchers.research.focus, 'agents');

  const cleared = await run('board', 'update', id, '--model', 'judge=');
  assert.equal(cleared.out.board.config.models.judge, undefined, 'an empty model falls back to the app setting');

  for (const bad of [['--model', 'chef=claude-cli:opus'], ['--mode', 'turbo'], ['--auto-project', 'maybe'], ['--steps-per-hour', 'lots'], []]) {
    assert.equal((await run('board', 'update', id, ...bad)).code, 2, `rejects ${bad.join(' ') || 'an empty update'}`);
  }
});

test('board create can start from a template, and board update can switch template', async () => {
  const { run } = session();
  const templates = (await run('template', 'list')).out.templates;
  assert.ok(templates.length >= 2);
  const [first, second] = templates;
  const created = await run('board', 'create', '--goal', 'g', '--template', String(second.id));
  assert.equal(created.out.board.config.flowName, second.name);
  const switched = await run('board', 'update', String(created.out.board.id), '--template', String(first.id));
  assert.equal(switched.out.board.config.flowName, first.name);
  assert.equal(switched.out.board.config.flow.system, first.system);
  assert.equal((await run('board', 'update', String(created.out.board.id), '--template', '999')).code, 3);
});

test('evolve never takes more steps in one run than the board allows per hour', async () => {
  const { run } = session();
  const id = await newBoard(run);
  await run('board', 'update', id, '--steps-per-hour', '1');
  await run('seed', id, 'one');
  await run('seed', id, 'two');
  const { out } = await run('evolve', id, '--steps', '5');
  assert.equal(out.steps.length, 1);
  assert.equal(out.stopped.reason, 'hourly');
});

test('board delete needs --yes, then removes the board', async () => {
  const { run } = session();
  const id = await newBoard(run);
  assert.equal((await run('board', 'delete', id)).code, 2);
  assert.equal((await run('board', 'show', id)).code, 0, 'still there');
  const { code, out } = await run('board', 'delete', id, '--yes');
  assert.equal(code, 0);
  assert.equal(out.ok, true);
  assert.equal((await run('board', 'show', id)).code, 3);
});

test('board export prints Markdown, not JSON', async () => {
  const { run } = session();
  const id = await newBoard(run, '--title', 'Export me', '--lang', 'en');
  await run('seed', id, 'GOLD idea');
  const { code, rawOut } = await run('board', 'export', id);
  assert.equal(code, 0);
  assert.match(rawOut, /^# Export me/m);
  assert.match(rawOut, /GOLD idea/);
});

test('board summary saves a headline on the board, and needs two ideas', async () => {
  const { run } = session();
  const id = await newBoard(run);
  await run('seed', id, 'one');
  await run('seed', id, 'two');
  const { code, out } = await run('board', 'summary', id);
  assert.equal(code, 0);
  assert.equal(out.board.summary.headline, 'The board leans one way.');
  const tooFew = await run('board', 'summary', await newBoard(run));
  assert.equal(tooFew.code, 2);
  assert.equal(tooFew.err.code, 'too_few');
});

test('board show includes edges, leads and spin-offs, as the app does', async () => {
  const { run } = session();
  const id = await newBoard(run);
  const a = (await run('seed', id, 'one')).out.idea;
  await run('expand', String(a.id));
  const { out } = await run('board', 'show', id);
  assert.equal(out.edges.length, 3);
  assert.deepEqual(out.leads, []);
  assert.deepEqual(out.spinoffs, []);
});

// ---- ideas

test('idea show gives the idea with its parents and lineage', async () => {
  const { run } = session();
  const id = await newBoard(run);
  const a = (await run('seed', id, 'one')).out.idea;
  const b = (await run('seed', id, 'two')).out.idea;
  const crossed = (await run('cross', id, String(a.id), String(b.id))).out.idea;
  const { code, out } = await run('idea', 'show', String(crossed.id));
  assert.equal(code, 0);
  assert.equal(out.idea.title, 'Crossed');
  assert.deepEqual(out.parents.map((p: any) => p.title).sort(), ['one', 'two']);
  assert.ok(out.lineage.length >= 2);
  assert.equal((await run('idea', 'show', '999')).code, 3);
});

test('idea medal sets a medal by hand, and auto hands it back to the jury', async () => {
  const { run } = session();
  const id = await newBoard(run);
  const idea = (await run('seed', id, 'plain')).out.idea;
  assert.equal(idea.medal, null);
  const gold = await run('idea', 'medal', String(idea.id), 'gold');
  assert.equal(gold.out.idea.medal, 'gold');
  assert.equal(gold.out.idea.medalOverride, 3);
  const none = await run('idea', 'medal', String(idea.id), 'none');
  assert.equal(none.out.idea.medal, null);
  assert.equal(none.out.idea.medalOverride, 0);
  const auto = await run('idea', 'medal', String(idea.id), 'auto');
  assert.equal(auto.out.idea.medalOverride, null);
  assert.equal((await run('idea', 'medal', String(idea.id), 'platinum')).code, 2);
});

test('idea delete needs --yes', async () => {
  const { run } = session();
  const id = await newBoard(run);
  const idea = (await run('seed', id, 'doomed')).out.idea;
  assert.equal((await run('idea', 'delete', String(idea.id))).code, 2);
  const { out } = await run('idea', 'delete', String(idea.id), '--yes');
  assert.equal(out.ok, true);
  assert.equal((await run('idea', 'show', String(idea.id))).code, 3);
});

test('idea announce sends a judged guest copy to other boards, skipping ones that have it', async () => {
  const { run } = session();
  const home = await newBoard(run);
  const away = await newBoard(run);
  const third = await newBoard(run);
  const idea = (await run('seed', home, 'travelling idea')).out.idea;
  const { code, out } = await run('idea', 'announce', String(idea.id), '--to', `${away},${third}`);
  assert.equal(code, 0);
  assert.equal(out.guests.length, 2);
  assert.ok(out.guests.every((g: any) => g.idea.kind === 'guest' && g.idea.sum === 6), 'guests are judged before returning');
  const again = await run('idea', 'announce', String(idea.id), '--to', 'all');
  assert.deepEqual(again.out.guests, []);
  assert.deepEqual([...again.out.skipped].sort(), [Number(away), Number(third)].sort());
  assert.equal((await run('idea', 'announce', String(idea.id))).code, 2, '--to is required');
});

test('idea spinoff creates a board whose goal is the idea, seeded and judged', async () => {
  const { run } = session();
  const id = await newBoard(run);
  const idea = (await run('seed', id, 'grow me')).out.idea;
  const { code, out } = await run('idea', 'spinoff', String(idea.id));
  assert.equal(code, 0);
  assert.equal(out.board.goal, 'grow me');
  assert.equal(out.idea.sum, 6);
});

test('seed reads long text from a file or from stdin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ideagen-seed-'));
  const file = join(dir, 'idea.txt');
  writeFileSync(file, 'From a file');
  const { run } = session({ stdin: 'From stdin\n' });
  const id = await newBoard(run);
  assert.equal((await run('seed', id, '--file', file)).out.idea.title, 'From a file');
  assert.equal((await run('seed', id, '--file', '-')).out.idea.title, 'From stdin');
  assert.equal((await run('seed', id, '--file', join(dir, 'missing.txt'))).code, 2);
});

// ---- scouts, dashboard, report

test('leads: refresh from research, list, seed one onto the board, dismiss it', async () => {
  const { run } = session();
  const id = await newBoard(run);
  const refreshed = await run('leads', 'refresh', id, 'research');
  assert.equal(refreshed.code, 0);
  assert.equal(refreshed.out.leads.length, 1);
  const lead = refreshed.out.leads[0];
  assert.equal((await run('leads', 'list', id)).out.leads.length, 1);
  const seeded = await run('leads', 'seed', String(lead.id));
  assert.equal(seeded.out.idea.title, 'A paper lead');
  assert.equal(seeded.out.idea.sum, 6, 'seeded leads are judged');
  assert.equal((await run('leads', 'dismiss', String(lead.id))).out.ok, true);
  assert.equal((await run('leads', 'refresh', id, 'tiktok')).code, 2);
});

test('dashboard, keyword and report read across every board', async () => {
  const { run } = session();
  const id = await newBoard(run, '--lang', 'en', '--title', 'Reported');
  await run('seed', id, 'one');
  await run('seed', id, 'two');
  const dash = await run('dashboard', '--days', '7');
  assert.equal(dash.code, 0);
  assert.ok(JSON.stringify(dash.out).includes('shared word'));
  assert.equal((await run('keyword', 'shared word')).out.ideas.length, 2);
  assert.equal((await run('report', '--days', '30')).out.totals.ideas, 2);
  const md = await run('report', '--markdown', '--lang', 'en');
  assert.match(md.rawOut, /^# Report/m);
  assert.match(md.rawOut, /## Reported/);
  const synth = await run('report', 'synthesize', '--lang', 'en');
  assert.equal(synth.out.synthesis.headline, 'Across boards.');
});

// ---- templates and settings

test('templates: create, update, delete, and the last one cannot go', async () => {
  const { run } = session();
  const created = await run('template', 'create', '--name', 'Mine', '--system', 'S', '--expand', 'E', '--combine', 'C');
  assert.equal(created.code, 0);
  const tid = String(created.out.template.id);
  assert.equal((await run('template', 'create', '--name', 'Half')).code, 2, 'all three prompts are required');
  const updated = await run('template', 'update', tid, '--name', 'Mine 2', '--system', 'S2', '--expand', 'E2', '--combine', 'C2');
  assert.equal(updated.out.template.name, 'Mine 2');
  assert.equal((await run('template', 'delete', tid)).code, 2, 'needs --yes');
  assert.equal((await run('template', 'delete', tid, '--yes')).out.ok, true);
  const rest = (await run('template', 'list')).out.templates;
  for (const t of rest.slice(1)) await run('template', 'delete', String(t.id), '--yes');
  const last = await run('template', 'delete', String(rest[0].id), '--yes');
  assert.equal(last.code, 2);
  assert.equal(last.err.code, 'last_template');
});

test('settings show never prints a key, only where it came from', async () => {
  const { run } = session({ settings: { keys: { openrouter: 'sk-secret-123' } } });
  const { code, out, rawOut } = await run('settings', 'show');
  assert.equal(code, 0);
  assert.ok(!rawOut.includes('sk-secret-123'));
  assert.equal(out.providers.find((p: any) => p.id === 'openrouter').keySource, 'browser');
  assert.equal(out.models.judge, DEFAULT_APP_SETTINGS.models.judge);
  assert.equal(out.keys, undefined);
  assert.equal((await run('providers', 'test', 'nonsense')).code, 3);
});

test('--help names every command', async () => {
  const { run } = session();
  const { rawOut } = await run('--help');
  const commands = ['board update', 'board delete', 'board export', 'board summary', 'judge', 'idea show', 'idea medal', 'idea delete',
    'idea announce', 'idea spinoff', 'leads refresh', 'leads seed', 'dashboard', 'keyword', 'report synthesize', 'template create',
    'settings show', 'providers test'];
  for (const word of commands) assert.match(rawOut, new RegExp(word), word);
});
