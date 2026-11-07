// The ideagen command line, for people and for agents: everything the web app does, on the
// same engine and database. JSON on stdout (Markdown for the export commands), problems as
// JSON on stderr, progress as JSON lines on stderr. Exit codes: 0 ok, 1 failed (model,
// network), 2 usage or a request the app refuses, 3 not found.

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { AppError, type Engine } from './engine.ts';
import type { Idea, Repo } from './db.ts';
import { rateCheck } from './autopilot.ts';
import { boardMarkdown, reportMarkdown } from './app.ts';
import { keySource, listModels, PROVIDERS, ROLES, type AppSettings, type ProviderId, type Role } from './providers.ts';
import { fitness, medal, scoreSum } from '../public/js/score.js';

export type CliIo = {
  repo: Repo;
  engine: Engine;
  settings: () => AppSettings;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readStdin?: () => Promise<string>;
};

class UsageError extends Error {}

/** A failure that still has something to say: partial output for stdout, extra fields for stderr. */
class CliFailure extends Error {
  readonly code: string;
  readonly extra: { output?: unknown; details?: object };
  constructor(code: string, message: string, extra: { output?: unknown; details?: object } = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

/** Raw text for stdout instead of JSON (the Markdown exports). */
class Raw {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

const MAX_EVOLVE_STEPS = 50;
const MEDAL_NAMES = ['none', 'bronze', 'silver', 'gold'] as const;
const MEDAL_VALUES: Record<string, number | null> = { none: 0, bronze: 1, silver: 2, gold: 3, auto: null };
const MIN_MEDAL: Record<string, number> = { bronze: 1, silver: 2, gold: 3 };

export const HELP = `ideagen: branch, cross and judge ideas on boards. JSON on stdout.

Boards
  ideagen board create --goal <text> [--title <text>] [--lang sv|en] [--template <id>]
  ideagen board list
  ideagen board show <boardId>
  ideagen board update <boardId> [--title <t>] [--goal <t>] [--lang sv|en] [--mode manual|auto]
        [--template <id>] [--judge-guidance <t>] [--auto-project on|off] [--steps-per-hour <n>]
        [--usd-per-day <n>] [--model <role>=<provider:model>]... [--x-focus <t>] [--research-focus <t>]
  ideagen board delete <boardId> --yes
  ideagen board export <boardId> [--lang sv|en]        Markdown on stdout
  ideagen board summary <boardId>

Ideas
  ideagen seed <boardId> <text or link> | --file <path or ->
  ideagen expand <ideaId>
  ideagen cross <boardId> <ideaA> <ideaB>
  ideagen judge <ideaId>
  ideagen top <boardId> [--min-medal bronze|silver|gold] [--limit <n>]
  ideagen evolve <boardId> --steps <1-${MAX_EVOLVE_STEPS}>
  ideagen project <ideaId>
  ideagen idea show <ideaId>
  ideagen idea medal <ideaId> none|bronze|silver|gold|auto
  ideagen idea delete <ideaId> --yes
  ideagen idea announce <ideaId> --to <boardId,boardId...|all>
  ideagen idea spinoff <ideaId>

Scouts
  ideagen leads list <boardId> [--source x|research]
  ideagen leads refresh <boardId> x|research
  ideagen leads seed <leadId>
  ideagen leads dismiss <leadId>

Across boards
  ideagen dashboard [--days <n>]
  ideagen keyword <keyword>
  ideagen report [--days <n>] [--markdown] [--lang sv|en]
  ideagen report synthesize [--days <n>] [--lang sv|en]

Templates and settings
  ideagen template list
  ideagen template create --name <t> --system <t> --expand <t> --combine <t>
  ideagen template update <id> --name <t> --system <t> --expand <t> --combine <t>
  ideagen template delete <id> --yes
  ideagen settings show
  ideagen providers list
  ideagen providers test <providerId>

evolve stops early, without failing, at the board's steps per hour or a daily dollar limit.
Exit codes: 0 ok, 1 failed, 2 usage or refused, 3 not found. Errors are JSON on stderr.
Medals come from the jury sum out of 15: bronze 9, silver 11, gold 13.
Settings: set IDEAGEN_SETTINGS to a JSON file (models per role, projectsRoot, maxUsdPerDay).
Keys come from the environment (OPENROUTER_API_KEY, ANTHROPIC_API_KEY, ...).
`;

const OPTIONS = {
  goal: { type: 'string' }, title: { type: 'string' }, lang: { type: 'string' }, template: { type: 'string' },
  mode: { type: 'string' }, 'judge-guidance': { type: 'string' }, 'auto-project': { type: 'string' },
  'steps-per-hour': { type: 'string' }, 'usd-per-day': { type: 'string' }, model: { type: 'string', multiple: true },
  'x-focus': { type: 'string' }, 'research-focus': { type: 'string' },
  'min-medal': { type: 'string' }, limit: { type: 'string' }, steps: { type: 'string' },
  file: { type: 'string' }, to: { type: 'string' }, source: { type: 'string' }, days: { type: 'string' },
  markdown: { type: 'boolean' }, yes: { type: 'boolean' },
  name: { type: 'string' }, system: { type: 'string' }, expand: { type: 'string' }, combine: { type: 'string' },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values'];
type Ctx = { io: CliIo; values: Values; args: string[] };

// ---------------------------------------------------------------- small helpers

const integer = (value: string | undefined, name: string) => {
  const n = Number(value);
  if (value === undefined || !Number.isInteger(n) || n < 1) throw new UsageError(`${name} must be a positive whole number`);
  return n;
};

const days = (value: string | undefined) => (value === undefined ? 30 : Math.min(365, integer(value, '--days')));
const lang = (value: string | undefined, fallback: 'sv' | 'en'): 'sv' | 'en' => (value === 'en' || value === 'sv' ? value : fallback);

const requireYes = (values: Values, what: string) => {
  if (!values.yes) throw new UsageError(`${what} cannot be undone; add --yes`);
};

const oneOf = <T extends string>(value: string, allowed: readonly T[], name: string): T => {
  if (!(allowed as readonly string[]).includes(value)) throw new UsageError(`${name} is ${allowed.join(', ')}`);
  return value as T;
};

const view = (idea: Idea) => {
  const sum = scoreSum(idea);
  const medalIndex = medal(idea);
  return {
    id: idea.id, boardId: idea.boardId, title: idea.title, pitch: idea.pitch, kind: idea.kind, generation: idea.generation,
    originality: idea.originality, feasibility: idea.feasibility, impact: idea.impact, sum,
    medal: medalIndex ? MEDAL_NAMES[medalIndex] : null, medalOverride: idea.medalOverride, reason: idea.reason,
    keywords: idea.keywords, sourceUrl: idea.sourceUrl, projectPath: idea.projectPath,
    originIdeaId: idea.originIdeaId, originBoardId: idea.originBoardId,
  };
};

const mustBoard = (io: CliIo, id: number) => {
  const board = io.repo.getBoard(id);
  if (!board) throw new AppError(404, 'not_found', `No board ${id}`);
  return board;
};

const mustIdea = (io: CliIo, id: number) => {
  const idea = io.repo.getIdea(id);
  if (!idea) throw new AppError(404, 'not_found', `No idea ${id}`);
  return idea;
};

const mustTemplate = (io: CliIo, id: number) => {
  const template = io.repo.listTemplates().find((t) => t.id === id);
  if (!template) throw new AppError(404, 'not_found', `No template ${id}`);
  return template;
};

const fresh = (io: CliIo, idea: Idea) => view(io.repo.getIdea(idea.id) ?? idea);

/**
 * Watch boards for background judging errors. Start it before (or, for synchronous engine calls,
 * right after) the call that queues judgements; then wait for the jury and fail if anything failed.
 */
function watchJudging(io: CliIo, boardIds: number[]) {
  const failures: { code: string; message: string; ideaId: unknown }[] = [];
  const stops = boardIds.map((id) =>
    io.engine.bus.on(id, (e) => {
      if (e.type === 'error') failures.push({ code: String(e.code), message: String(e.message), ideaId: e.ideaId });
    }),
  );
  return async () => {
    try {
      await io.engine.idle();
    } finally {
      stops.forEach((stop) => stop());
    }
    const [first] = failures;
    if (first) throw new CliFailure(first.code, first.message, { details: { ideaId: first.ideaId } });
  };
}

async function seedText({ io, values, args }: Ctx) {
  if (values.file === '-') return (await (io.readStdin ?? (async () => ''))()).trim();
  if (values.file !== undefined) {
    try {
      return readFileSync(values.file, 'utf8').trim();
    } catch (e: any) {
      throw new UsageError(`cannot read ${values.file}: ${e?.code ?? e?.message}`);
    }
  }
  return args.join(' ').trim();
}

function boardConfigPatch(io: CliIo, values: Values) {
  const config: Record<string, unknown> = {};
  if (values.lang !== undefined) config.lang = oneOf(values.lang, ['sv', 'en'] as const, '--lang');
  if (values.mode !== undefined) config.mode = oneOf(values.mode, ['manual', 'auto'] as const, '--mode');
  if (values['judge-guidance'] !== undefined) config.judgeGuidance = values['judge-guidance'];
  if (values['auto-project'] !== undefined) config.autoProjectOnGold = oneOf(values['auto-project'], ['on', 'off'] as const, '--auto-project') === 'on';
  const rate: Record<string, number> = {};
  if (values['steps-per-hour'] !== undefined) rate.stepsPerHour = integer(values['steps-per-hour'], '--steps-per-hour');
  if (values['usd-per-day'] !== undefined) {
    const usd = Number(values['usd-per-day']);
    if (!Number.isFinite(usd) || usd < 0) throw new UsageError('--usd-per-day must be a number, 0 or more');
    rate.usdPerDay = usd;
  }
  if (Object.keys(rate).length) config.rate = rate;
  if (values.model?.length) config.models = Object.fromEntries(values.model.map(modelOverride));
  const researchers: Record<string, { focus: string }> = {};
  if (values['x-focus'] !== undefined) researchers.x = { focus: values['x-focus'] };
  if (values['research-focus'] !== undefined) researchers.research = { focus: values['research-focus'] };
  if (Object.keys(researchers).length) config.researchers = researchers;
  if (values.template !== undefined) {
    const t = mustTemplate(io, integer(values.template, '--template'));
    Object.assign(config, { flowName: t.name, flow: { system: t.system, expand: t.expand, combine: t.combine } });
  }
  return config;
}

function modelOverride(entry: string): [Role, string] {
  const at = entry.indexOf('=');
  const role = at > 0 ? entry.slice(0, at) : '';
  if (!(ROLES as string[]).includes(role)) throw new UsageError(`--model is <role>=<provider:model>; roles are ${ROLES.join(', ')}`);
  return [role as Role, entry.slice(at + 1)];
}

function templateFields(values: Values) {
  const t = { name: values.name?.trim() ?? '', system: values.system?.trim() ?? '', expand: values.expand?.trim() ?? '', combine: values.combine?.trim() ?? '' };
  if (!t.name || !t.system || !t.expand || !t.combine) throw new UsageError('a template needs --name, --system, --expand and --combine');
  return t;
}

function providerStatus(io: CliIo) {
  const s = io.settings();
  return (Object.keys(PROVIDERS) as ProviderId[]).map((id) => ({
    id, label: PROVIDERS[id].label, local: !!PROVIDERS[id].local, needsKey: PROVIDERS[id].needsKey,
    search: !!PROVIDERS[id].search, keySource: keySource(s, id), baseUrl: s.baseUrls[id] ?? null,
  }));
}

// ---------------------------------------------------------------- evolve

async function evolve({ io, values, args }: Ctx) {
  const boardId = integer(args[0], 'boardId');
  const requested = integer(values.steps, '--steps');
  if (requested > MAX_EVOLVE_STEPS) throw new UsageError(`--steps is at most ${MAX_EVOLVE_STEPS}`);
  const board = mustBoard(io, boardId);
  const steps: unknown[] = [];
  const stop = (stopped: object) => ({ steps, stopped });
  for (let n = 0; n < requested; n++) {
    if (n >= board.config.rate.stepsPerHour) return stop({ reason: 'hourly', limit: board.config.rate.stepsPerHour });
    const decision = rateCheck({
      now: Date.now(), steps: [], lastAt: 0, paceSeconds: 0, stepsPerHour: Infinity, errors: 0, lastErrorAt: 0,
      boardSpent: io.repo.spentOn(boardId), boardUsdPerDay: board.config.rate.usdPerDay,
      globalSpent: io.repo.spentOn(null), globalUsdPerDay: io.settings().maxUsdPerDay,
    });
    if (!decision.ok) return stop({ reason: decision.reason, until: new Date(decision.until).toISOString() });
    let step: Awaited<ReturnType<Engine['autoStep']>>;
    try {
      step = await io.engine.autoStep(boardId);
    } catch (e: any) {
      const code = e?.code ?? 'error';
      throw new CliFailure(code, e?.message ?? String(e), { output: stop({ code, message: e?.message ?? String(e) }) });
    }
    steps.push(step);
    io.stderr(`${JSON.stringify({ step: n + 1, ...step })}\n`);
    if (step.did === 'idle') break;
  }
  return { steps };
}

// ---------------------------------------------------------------- commands

type Command = (ctx: Ctx) => unknown | Promise<unknown>;

const boardCommands: Record<string, Command> = {
  create: ({ io, values }) => {
    if (!values.goal) throw new UsageError('board create needs --goal');
    const boardLang = lang(values.lang, 'sv');
    const templateId = values.template === undefined ? null : mustTemplate(io, integer(values.template, '--template')).id;
    return {
      board: io.repo.createBoard({ title: values.title ?? (boardLang === 'en' ? 'New board' : 'Ny tavla'), goal: values.goal, templateId, config: { lang: boardLang } }),
    };
  },
  list: ({ io }) => ({ boards: io.repo.listBoards() }),
  show: ({ io, args }) => {
    const board = mustBoard(io, integer(args[0], 'boardId'));
    return {
      board, ideas: io.repo.listIdeas(board.id).map(view), edges: io.repo.listEdges(board.id),
      leads: io.repo.listLeads(board.id), spinoffs: io.repo.spinoffs(board.id), spentToday: io.repo.spentOn(board.id),
    };
  },
  update: ({ io, values, args }) => {
    const board = mustBoard(io, integer(args[0], 'boardId'));
    const patch: { title?: string; goal?: string; config?: object } = {};
    if (values.title?.trim()) patch.title = values.title.trim().slice(0, 120);
    if (values.goal !== undefined) patch.goal = values.goal.trim().slice(0, 600);
    const config = boardConfigPatch(io, values);
    if (Object.keys(config).length) patch.config = config;
    if (!Object.keys(patch).length) throw new UsageError('board update needs at least one change');
    return io.engine.updateBoard(board.id, patch);
  },
  delete: ({ io, values, args }) => {
    const board = mustBoard(io, integer(args[0], 'boardId'));
    requireYes(values, 'Deleting a board and all its ideas');
    return { ok: io.repo.deleteBoard(board.id) };
  },
  export: ({ io, values, args }) => {
    const board = mustBoard(io, integer(args[0], 'boardId'));
    return new Raw(`${boardMarkdown(board, io.repo.listIdeas(board.id), io.repo.listEdges(board.id), lang(values.lang, board.config.lang))}\n`);
  },
  summary: ({ io, args }) => io.engine.summarize(integer(args[0], 'boardId')),
};

const ideaCommands: Record<string, Command> = {
  show: ({ io, args }) => {
    const idea = mustIdea(io, integer(args[0], 'ideaId'));
    return { idea: view(idea), parents: io.repo.parentsOf(idea.id).map(view), lineage: io.repo.lineage(idea.id).map(view) };
  },
  medal: ({ io, args }) => {
    const idea = mustIdea(io, integer(args[0], 'ideaId'));
    const value = MEDAL_VALUES[args[1] ?? ''];
    if (value === undefined) throw new UsageError('idea medal takes none, bronze, silver, gold or auto');
    return { idea: view(io.engine.setMedal(idea.id, value).idea) };
  },
  delete: ({ io, values, args }) => {
    const idea = mustIdea(io, integer(args[0], 'ideaId'));
    requireYes(values, 'Deleting an idea');
    return io.engine.deleteIdea(idea.id);
  },
  announce: async ({ io, values, args }) => {
    const idea = mustIdea(io, integer(args[0], 'ideaId'));
    if (!values.to) throw new UsageError('idea announce needs --to <boardId,boardId...|all>');
    const targets = values.to === 'all' ? 'all' : values.to.split(',').map((x) => integer(x.trim(), '--to'));
    const out = io.engine.announce(idea.id, targets);
    await watchJudging(io, out.guests.map((g) => g.boardId))();
    return { guests: out.guests.map((g) => ({ boardId: g.boardId, idea: fresh(io, g.idea) })), skipped: out.skipped };
  },
  spinoff: async ({ io, args }) => {
    const idea = mustIdea(io, integer(args[0], 'ideaId'));
    const out = io.engine.spinoff(idea.id);
    await watchJudging(io, [out.board!.id])();
    return { board: io.repo.getBoard(out.board!.id), idea: fresh(io, out.idea) };
  },
};

const leadCommands: Record<string, Command> = {
  list: ({ io, values, args }) => {
    const board = mustBoard(io, integer(args[0], 'boardId'));
    const source = values.source === undefined ? null : oneOf(values.source, ['x', 'research'] as const, '--source');
    return { leads: io.repo.listLeads(board.id).filter((l) => !source || l.source === source) };
  },
  refresh: ({ io, args }) => {
    const board = mustBoard(io, integer(args[0], 'boardId'));
    return io.engine.refreshLeads(board.id, oneOf(args[1] ?? '', ['x', 'research'] as const, 'the source'));
  },
  seed: async ({ io, args }) => {
    const leadId = integer(args[0], 'leadId');
    const lead = io.repo.getLead(leadId);
    if (!lead) throw new AppError(404, 'not_found', `No lead ${leadId}`);
    const done = watchJudging(io, [lead.boardId]);
    const out = io.engine.seedLead(leadId, {});
    await done();
    return { idea: fresh(io, out.idea), lead: out.lead };
  },
  dismiss: ({ io, args }) => {
    const leadId = integer(args[0], 'leadId');
    if (!io.repo.deleteLead(leadId)) throw new AppError(404, 'not_found', `No lead ${leadId}`);
    return { ok: true };
  },
};

const templateCommands: Record<string, Command> = {
  list: ({ io }) => ({ templates: io.repo.listTemplates() }),
  create: ({ io, values }) => ({ template: io.repo.createTemplate(templateFields(values)) }),
  update: ({ io, values, args }) => {
    const template = mustTemplate(io, integer(args[0], 'templateId'));
    return { template: io.repo.updateTemplate(template.id, templateFields(values)) };
  },
  delete: ({ io, values, args }) => {
    const template = mustTemplate(io, integer(args[0], 'templateId'));
    requireYes(values, 'Deleting a template');
    if (!io.repo.deleteTemplate(template.id)) throw new AppError(400, 'last_template', 'The last template cannot be deleted');
    return { ok: true };
  },
};

const groups: Record<string, Record<string, Command>> = {
  board: boardCommands,
  idea: ideaCommands,
  leads: leadCommands,
  template: templateCommands,
  settings: {
    show: ({ io }) => {
      const { keys: _keys, ...visible } = io.settings();
      return { ...visible, providers: providerStatus(io) };
    },
  },
  providers: {
    list: ({ io }) => ({ providers: providerStatus(io) }),
    test: async ({ io, args }) => {
      const id = args[0] ?? '';
      if (!(id in PROVIDERS)) throw new AppError(404, 'not_found', `No provider "${id}"; see providers list`);
      return { models: await listModels(io.settings(), id as ProviderId) };
    },
  },
};

const verbs: Record<string, Command> = {
  seed: async (ctx) => {
    const { io, args } = ctx;
    const boardId = integer(args[0], 'boardId');
    const text = await seedText({ ...ctx, args: args.slice(1) });
    if (!text) throw new UsageError('seed needs the idea text, a link, or --file');
    mustBoard(io, boardId);
    const done = watchJudging(io, [boardId]);
    const { idea } = await io.engine.seed(boardId, { text });
    await done();
    return { idea: fresh(io, idea) };
  },
  expand: async ({ io, args }) => {
    const idea = mustIdea(io, integer(args[0], 'ideaId'));
    const done = watchJudging(io, [idea.boardId]);
    const { ideas } = await io.engine.expand(idea.id);
    await done();
    return { ideas: ideas.map((i) => fresh(io, i)) };
  },
  cross: async ({ io, args }) => {
    const [boardId, a, b] = [integer(args[0], 'boardId'), integer(args[1], 'ideaA'), integer(args[2], 'ideaB')];
    mustBoard(io, boardId);
    const done = watchJudging(io, [boardId]);
    const { idea } = await io.engine.combine(boardId, a, b);
    await done();
    return { idea: fresh(io, idea) };
  },
  judge: async ({ io, args }) => {
    const idea = mustIdea(io, integer(args[0], 'ideaId'));
    const out = await io.engine.judge(idea.id);
    return { ...out, idea: view(out.idea) };
  },
  top: ({ io, values, args }) => {
    const board = mustBoard(io, integer(args[0], 'boardId'));
    const minMedal = values['min-medal'] === undefined ? 0 : MIN_MEDAL[values['min-medal']];
    if (minMedal === undefined) throw new UsageError('--min-medal is bronze, silver or gold');
    const limit = values.limit === undefined ? Infinity : integer(values.limit, '--limit');
    const ideas = io.repo.listIdeas(board.id)
      .filter((i) => fitness(i) !== null && (medal(i) ?? 0) >= minMedal)
      .sort((x, y) => fitness(y)! - fitness(x)!)
      .slice(0, limit);
    return { ideas: ideas.map(view) };
  },
  evolve,
  project: async ({ io, args }) => {
    const { path, existed } = await io.engine.createProject(integer(args[0], 'ideaId'));
    return { path, existed };
  },
  dashboard: ({ io, values }) => io.repo.dashboard(days(values.days)),
  keyword: ({ io, args }) => {
    const keyword = args.join(' ').trim().toLowerCase();
    if (!keyword) throw new UsageError('keyword needs a keyword');
    return { ideas: io.repo.ideasWithKeyword(keyword).map((i) => ({ ...view(i), boardTitle: i.boardTitle })) };
  },
  report: ({ io, values, args }) => {
    if (args[0] === 'synthesize') return io.engine.synthesize(days(values.days), lang(values.lang, 'sv'));
    if (args[0] !== undefined) throw new UsageError('report takes no argument, or synthesize');
    const report = io.repo.report(days(values.days));
    return values.markdown ? new Raw(`${reportMarkdown(report, lang(values.lang, 'sv'))}\n`) : report;
  },
};

async function dispatch(argv: string[], io: CliIo): Promise<unknown> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
  const [command, ...rest] = positionals;
  const group = command ? groups[command] : undefined;
  if (group) {
    const [action, ...args] = rest;
    const run = action ? group[action] : undefined;
    if (!run) throw new UsageError(`${command} takes ${Object.keys(group).join(', ')}`);
    return run({ io, values, args });
  }
  const verb = command ? verbs[command] : undefined;
  if (!verb) throw new UsageError(command ? `unknown command "${command}"` : 'no command given');
  return verb({ io, values, args: rest });
}

const PARSE_ERRORS = new Set(['ERR_PARSE_ARGS_UNKNOWN_OPTION', 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE', 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL']);

function describeFailure(e: any): { exit: number; code: string; details?: object; output?: unknown } {
  if (e instanceof UsageError || PARSE_ERRORS.has(e?.code)) return { exit: 2, code: 'usage' };
  if (e instanceof CliFailure) return { exit: 1, code: e.code, details: e.extra.details, output: e.extra.output };
  if (e instanceof AppError && e.status === 404) return { exit: 3, code: e.code };
  if (e instanceof AppError && e.status === 400) return { exit: 2, code: e.code };
  return { exit: 1, code: e?.code ?? 'error' };
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout(HELP);
    return 0;
  }
  try {
    const out = await dispatch(argv, io);
    io.stdout(out instanceof Raw ? out.text : `${JSON.stringify(out)}\n`);
    return 0;
  } catch (e: any) {
    const failure = describeFailure(e);
    if (failure.output !== undefined) io.stdout(`${JSON.stringify(failure.output)}\n`);
    io.stderr(`${JSON.stringify({ error: e?.message ?? String(e), code: failure.code, ...failure.details })}\n`);
    return failure.exit;
  }
}
