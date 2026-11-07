// The ideagen command line: what an agent sees (JSON on stdout, errors on stderr, exit codes)
// against an in-memory database and a fake model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError } from '../server/providers.ts';
import { newBoard, session } from './support/cli-session.ts';

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

// ---- batch 1: evolve keeps its results, respects limits; judge; seed failures name the idea

test('evolve reports each step on stderr as it happens', async () => {
  const { run } = session();
  const id = await newBoard(run);
  await run('seed', id, 'one');
  await run('seed', id, 'two');
  const { code, out, errLines } = await run('evolve', id, '--steps', '2');
  assert.equal(code, 0);
  const progress = errLines.filter((l) => 'step' in l);
  assert.equal(progress.length, out.steps.length);
  assert.deepEqual(progress.map((l) => l.step), out.steps.map((_: unknown, n: number) => n + 1));
});

test('evolve keeps the steps it finished when a later step fails', async () => {
  const s = session();
  const id = await newBoard(s.run);
  await s.run('seed', id, 'one');
  await s.run('seed', id, 'two');
  const first = await s.run('evolve', id, '--steps', '1');
  assert.equal(first.out.steps.length, 1);
  s.setFailure(new ProviderError('not_logged_in', 'Claude CLI: not logged in'));
  const { code, out, err } = await s.run('evolve', id, '--steps', '3');
  assert.equal(code, 1);
  assert.deepEqual(out.steps, [], 'no step finished, but stdout still says so');
  assert.equal(out.stopped.code, 'not_logged_in');
  assert.equal(err.code, 'not_logged_in');
});

test('evolve stops, without failing, once the board has spent its daily budget', async () => {
  const { run } = session({ costUsd: 0.6 });
  const id = await newBoard(run);
  await run('seed', id, 'one');
  await run('seed', id, 'two');
  const { code, out } = await run('evolve', id, '--steps', '5');
  assert.equal(code, 0);
  assert.deepEqual(out.steps, []);
  assert.equal(out.stopped.reason, 'board_budget');
});

test('evolve also stops at the global daily budget', async () => {
  const { run } = session({ costUsd: 0.6, settings: { maxUsdPerDay: 1 } });
  const id = await newBoard(run);
  await run('board', 'update', id, '--usd-per-day', '100');
  await run('seed', id, 'one');
  await run('seed', id, 'two');
  const { out } = await run('evolve', id, '--steps', '5');
  assert.equal(out.stopped.reason, 'global_budget');
});

test('judge re-judges an idea and returns its new score', async () => {
  const { run, chatCalls } = session();
  const id = await newBoard(run);
  const idea = (await run('seed', id, 'GOLD')).out.idea;
  const before = chatCalls.length;
  const { code, out } = await run('judge', String(idea.id));
  assert.equal(code, 0);
  assert.equal(chatCalls.length, before + 1);
  assert.equal(out.idea.medal, 'gold');
});

test('a seed whose judging fails still names the saved idea, so it can be re-judged', async () => {
  const s = session();
  const id = await newBoard(s.run);
  s.setFailure(new ProviderError('not_logged_in', 'nope'));
  const { code, err } = await s.run('seed', id, 'saved but unjudged');
  assert.equal(code, 1);
  assert.ok(Number.isInteger(err.ideaId));
  s.setFailure(null);
  const rejudged = await s.run('judge', String(err.ideaId));
  assert.equal(rejudged.out.idea.title, 'saved but unjudged');
  assert.equal(rejudged.out.idea.sum, 6);
});
