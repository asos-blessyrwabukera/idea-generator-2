// The ideagen command line, for people and for agents. JSON on stdout, problems as JSON on
// stderr, exit codes: 0 ok, 1 failed (model, network), 2 usage, 3 not found.

import { parseArgs } from 'node:util';
import { AppError, type Engine } from './engine.ts';
import type { Idea, Repo } from './db.ts';
import { fitness, medal, scoreSum } from '../public/js/score.js';

export type CliIo = { repo: Repo; engine: Engine; stdout: (text: string) => void; stderr: (text: string) => void };

class UsageError extends Error {}

const MAX_EVOLVE_STEPS = 50;
const MEDAL_NAMES = ['none', 'bronze', 'silver', 'gold'] as const;
const MIN_MEDAL: Record<string, number> = { bronze: 1, silver: 2, gold: 3 };

export const HELP = `ideagen: branch, cross and judge ideas on boards. JSON on stdout.

  ideagen board create --goal <text> [--title <text>] [--lang sv|en]
  ideagen board list
  ideagen board show <boardId>
  ideagen seed <boardId> <text or link>
  ideagen expand <ideaId>
  ideagen cross <boardId> <ideaA> <ideaB>
  ideagen top <boardId> [--min-medal bronze|silver|gold] [--limit <n>]
  ideagen evolve <boardId> --steps <1-${MAX_EVOLVE_STEPS}>
  ideagen project <ideaId>

Exit codes: 0 ok, 1 failed, 2 usage, 3 not found. Errors are JSON on stderr.
Medals come from the jury sum out of 15: bronze 9, silver 11, gold 13.
`;

const integer = (value: string | undefined, name: string) => {
  const n = Number(value);
  if (value === undefined || !Number.isInteger(n) || n < 1) throw new UsageError(`${name} must be a positive whole number`);
  return n;
};

const view = (idea: Idea) => {
  const sum = scoreSum(idea);
  const medalIndex = medal(idea);
  return {
    id: idea.id, boardId: idea.boardId, title: idea.title, pitch: idea.pitch, kind: idea.kind, generation: idea.generation,
    originality: idea.originality, feasibility: idea.feasibility, impact: idea.impact, sum,
    medal: medalIndex ? MEDAL_NAMES[medalIndex] : null, reason: idea.reason, keywords: idea.keywords, projectPath: idea.projectPath,
  };
};

/** Run a command that queues judgements, wait for them, and fail if any of them failed. */
async function judged<T>(io: CliIo, boardId: number, work: () => Promise<T>): Promise<T> {
  const failures: { code: string; message: string }[] = [];
  const stop = io.engine.bus.on(boardId, (e) => {
    if (e.type === 'error') failures.push({ code: String(e.code), message: String(e.message) });
  });
  try {
    const result = await work();
    await io.engine.idle();
    const [first] = failures;
    if (first) throw new AppError(502, first.code, first.message);
    return result;
  } finally {
    stop();
  }
}

const mustBoard = (io: CliIo, id: number) => {
  const board = io.repo.getBoard(id);
  if (!board) throw new AppError(404, 'not_found', `No board ${id}`);
  return board;
};

async function dispatch(argv: string[], io: CliIo): Promise<unknown> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      goal: { type: 'string' }, title: { type: 'string' }, lang: { type: 'string' },
      'min-medal': { type: 'string' }, limit: { type: 'string' }, steps: { type: 'string' },
    },
  });
  const [command, ...rest] = positionals;

  if (command === 'board') {
    const [action, id] = rest;
    if (action === 'create') {
      if (!values.goal) throw new UsageError('board create needs --goal');
      const lang = values.lang === 'en' ? 'en' : 'sv';
      return { board: io.repo.createBoard({ title: values.title ?? (lang === 'en' ? 'New board' : 'Ny tavla'), goal: values.goal, config: { lang } }) };
    }
    if (action === 'list') return { boards: io.repo.listBoards() };
    if (action === 'show') {
      const board = mustBoard(io, integer(id, 'boardId'));
      return { board, ideas: io.repo.listIdeas(board.id).map(view) };
    }
    throw new UsageError('board takes create, list or show');
  }

  if (command === 'seed') {
    const boardId = integer(rest[0], 'boardId');
    const text = rest.slice(1).join(' ').trim();
    if (!text) throw new UsageError('seed needs the idea text or a link');
    mustBoard(io, boardId);
    const { idea } = await judged(io, boardId, () => io.engine.seed(boardId, { text }));
    return { idea: view(io.repo.getIdea(idea.id)!) };
  }

  if (command === 'expand') {
    const ideaId = integer(rest[0], 'ideaId');
    const boardId = io.repo.getIdea(ideaId)?.boardId;
    if (!boardId) throw new AppError(404, 'not_found', `No idea ${ideaId}`);
    const { ideas } = await judged(io, boardId, () => io.engine.expand(ideaId));
    return { ideas: ideas.map((i) => view(io.repo.getIdea(i.id)!)) };
  }

  if (command === 'cross') {
    const [boardId, a, b] = [integer(rest[0], 'boardId'), integer(rest[1], 'ideaA'), integer(rest[2], 'ideaB')];
    mustBoard(io, boardId);
    const { idea } = await judged(io, boardId, () => io.engine.combine(boardId, a, b));
    return { idea: view(io.repo.getIdea(idea.id)!) };
  }

  if (command === 'top') {
    const board = mustBoard(io, integer(rest[0], 'boardId'));
    const minMedal = values['min-medal'] === undefined ? 0 : MIN_MEDAL[values['min-medal']];
    if (minMedal === undefined) throw new UsageError('--min-medal is bronze, silver or gold');
    const limit = values.limit === undefined ? Infinity : integer(values.limit, '--limit');
    const ideas = io.repo.listIdeas(board.id)
      .filter((i) => fitness(i) !== null && (medal(i) ?? 0) >= minMedal)
      .sort((x, y) => fitness(y)! - fitness(x)!)
      .slice(0, limit);
    return { ideas: ideas.map(view) };
  }

  if (command === 'evolve') {
    const boardId = integer(rest[0], 'boardId');
    const steps = integer(values.steps, '--steps');
    if (steps > MAX_EVOLVE_STEPS) throw new UsageError(`--steps is at most ${MAX_EVOLVE_STEPS}`);
    mustBoard(io, boardId);
    const done: unknown[] = [];
    for (let n = 0; n < steps; n++) {
      const step = await io.engine.autoStep(boardId);
      done.push(step);
      if (step.did === 'idle') break;
    }
    return { steps: done };
  }

  if (command === 'project') {
    const { path, existed } = await io.engine.createProject(integer(rest[0], 'ideaId'));
    return { path, existed };
  }

  throw new UsageError(command ? `unknown command "${command}"` : 'no command given');
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout(HELP);
    return 0;
  }
  try {
    io.stdout(`${JSON.stringify(await dispatch(argv, io))}\n`);
    return 0;
  } catch (e: any) {
    const usage = e instanceof UsageError || e?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || e?.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE';
    const notFound = e instanceof AppError && e.status === 404;
    const code = usage ? 'usage' : (e?.code ?? 'error');
    io.stderr(`${JSON.stringify({ error: e?.message ?? String(e), code })}\n`);
    return usage ? 2 : notFound ? 3 : 1;
  }
}
