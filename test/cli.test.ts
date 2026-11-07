// The ideagen command line: what an agent sees (JSON on stdout, errors on stderr, exit codes)
// against an in-memory database and a fake model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { runCli } from '../server/cli.ts';
import { DEFAULT_APP_SETTINGS, ProviderError, type ChatRequest } from '../server/providers.ts';

type Session = { run: (...argv: string[]) => Promise<{ code: number; out: any; err: any; rawOut: string }>; chatCalls: ChatRequest[] };

function session(options: { failWith?: Error } = {}): Session {
  const chatCalls: ChatRequest[] = [];
  const chat = async (r: ChatRequest) => {
    chatCalls.push(r);
    if (options.failWith) throw options.failWith;
    const gold = /GOLD/.test(r.user);
    const value =
      r.schemaName === 'expand' ? { ideas: [1, 2, 3].map((k) => ({ title: `Child ${chatCalls.length}.${k}`, pitch: 'p' })) }
      : r.schemaName === 'judgement' ? { reason: 'Because.', originality: gold ? 5 : 2, feasibility: gold ? 5 : 2, impact: gold ? 5 : 2, keywords: ['k'] }
      : r.schemaName === 'brief' ? { name: 'Project', slug: 'project', oneLiner: 'o', problem: 'p', audience: 'a', mvp: ['m'], outOfScope: ['o'], stack: 's', firstSteps: ['f'], openQuestions: ['q'], risks: ['r'] }
      : { title: 'Crossed', pitch: 'c' };
    return { value, costUsd: 0 };
  };
  const repo = openDb(':memory:');
  const projectsRoot = mkdtempSync(join(tmpdir(), 'ideagen-cli-'));
  const settings = () => ({ ...structuredClone(DEFAULT_APP_SETTINGS), projectsRoot });
  const engine = createEngine({ repo, chat, settings, gitInit: false, fetchPage: async () => ({ title: '', text: '' }), fetchPapers: async () => [], reveal: () => {} });
  const run = async (...argv: string[]) => {
    let rawOut = '';
    let rawErr = '';
    const code = await runCli(argv, { repo, engine, stdout: (s) => (rawOut += s), stderr: (s) => (rawErr += s) });
    const parse = (s: string) => {
      try {
        return s.trim() ? JSON.parse(s) : null;
      } catch {
        return null;
      }
    };
    return { code, out: parse(rawOut), err: rawErr.trim() ? JSON.parse(rawErr.trim().split('\n').at(-1)!) : null, rawOut };
  };
  return { run, chatCalls };
}

test('board create prints the board as JSON and exits 0', async () => {
  const { run } = session();
  const { code, out, err } = await run('board', 'create', '--goal', 'Fewer car trips', '--title', 'Cars');
  assert.equal(code, 0);
  assert.equal(err, null);
  assert.equal(out.board.title, 'Cars');
  assert.equal(out.board.goal, 'Fewer car trips');
  assert.ok(Number.isInteger(out.board.id));
});

test('seed waits for the jury, so the answer already has its score and medal', async () => {
  const { run } = session();
  const { out: created } = await run('board', 'create', '--goal', 'g');
  const { code, out } = await run('seed', String(created.board.id), 'A GOLD idea');
  assert.equal(code, 0);
  assert.equal(out.idea.title, 'A GOLD idea');
  assert.equal(out.idea.originality, 5);
  assert.equal(out.idea.sum, 15);
  assert.equal(out.idea.medal, 'gold');
});

test('top lists the best ideas first and can demand a minimum medal', async () => {
  const { run } = session();
  const { out: created } = await run('board', 'create', '--goal', 'g');
  const id = String(created.board.id);
  await run('seed', id, 'plain one');
  await run('seed', id, 'GOLD one');
  const all = await run('top', id);
  assert.deepEqual(all.out.ideas.map((i: any) => i.title), ['GOLD one', 'plain one']);
  const gold = await run('top', id, '--min-medal', 'gold');
  assert.deepEqual(gold.out.ideas.map((i: any) => i.title), ['GOLD one']);
  const limited = await run('top', id, '--limit', '1');
  assert.equal(limited.out.ideas.length, 1);
});

test('expand adds three judged children; cross adds a judged combination', async () => {
  const { run } = session();
  const { out: created } = await run('board', 'create', '--goal', 'g');
  const id = String(created.board.id);
  const a = (await run('seed', id, 'one')).out.idea;
  const b = (await run('seed', id, 'two')).out.idea;
  const expanded = await run('expand', String(a.id));
  assert.equal(expanded.out.ideas.length, 3);
  assert.ok(expanded.out.ideas.every((i: any) => i.sum !== null), 'children are judged before the command returns');
  const crossed = await run('cross', id, String(a.id), String(b.id));
  assert.equal(crossed.out.idea.title, 'Crossed');
  assert.equal(crossed.out.idea.sum, 6);
});

test('evolve runs at most the requested steps and reports each one', async () => {
  const { run } = session();
  const { out: created } = await run('board', 'create', '--goal', 'g');
  const id = String(created.board.id);
  await run('seed', id, 'one');
  await run('seed', id, 'two');
  const { code, out } = await run('evolve', id, '--steps', '3');
  assert.equal(code, 0);
  assert.ok(out.steps.length >= 1 && out.steps.length <= 3);
  assert.ok(out.steps.every((s: any) => ['judge', 'expand', 'combine', 'idle'].includes(s.did)));
});

test('evolve refuses a step count that is missing, zero or above the hard cap', async () => {
  const { run } = session();
  const { out: created } = await run('board', 'create', '--goal', 'g');
  const id = String(created.board.id);
  for (const steps of [[], ['--steps', '0'], ['--steps', '51'], ['--steps', 'many']]) {
    const r = await run('evolve', id, ...steps);
    assert.equal(r.code, 2, `steps ${steps.join(' ')}`);
    assert.equal(r.err.code, 'usage');
  }
});

test('project writes the Claude Code folder and prints its path', async () => {
  const { run } = session();
  const { out: created } = await run('board', 'create', '--goal', 'g');
  const idea = (await run('seed', String(created.board.id), 'GOLD')).out.idea;
  const { code, out } = await run('project', String(idea.id));
  assert.equal(code, 0);
  assert.equal(typeof out.path, 'string');
  assert.ok(out.path.length > 0);
});

test('stdout carries only JSON; problems go to stderr as JSON with a distinct exit code', async () => {
  const { run } = session();
  const unknown = await run('frobnicate');
  assert.equal(unknown.code, 2);
  assert.equal(unknown.rawOut, '', 'nothing on stdout when it fails');
  assert.equal(unknown.err.code, 'usage');

  const missing = await run('top', '999');
  assert.equal(missing.code, 3);
  assert.equal(missing.err.code, 'not_found');

  const noArgs = await run('seed');
  assert.equal(noArgs.code, 2);
});

test('a model failure is exit 1 and keeps the provider code', async () => {
  const { run } = session({ failWith: new ProviderError('not_logged_in', 'Claude CLI: not logged in') });
  const { out: created } = await run('board', 'create', '--goal', 'g');
  const { code, err } = await run('seed', String(created.board.id), 'x');
  assert.equal(code, 1);
  assert.equal(err.code, 'not_logged_in');
});

test('--help lists the commands on stdout and exits 0', async () => {
  const { run } = session();
  const { code, rawOut } = await run('--help');
  assert.equal(code, 0);
  for (const word of ['board create', 'seed', 'expand', 'cross', 'top', 'evolve', 'project']) assert.match(rawOut, new RegExp(word));
});
