// A CLI session for tests: in-memory database, fake model, captured stdout and stderr.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../server/db.ts';
import { createEngine } from '../../server/engine.ts';
import { runCli } from '../../server/cli.ts';
import { DEFAULT_APP_SETTINGS, type AppSettings, type ChatRequest } from '../../server/providers.ts';

export type Run = { code: number; out: any; err: any; rawOut: string; errLines: any[] };
export type Session = { run: (...argv: string[]) => Promise<Run>; chatCalls: ChatRequest[]; setFailure: (e: Error | null) => void };
export type SessionOptions = { failWith?: Error; costUsd?: number; stdin?: string; settings?: Partial<AppSettings> };

const fakeAnswer = (r: ChatRequest, callNumber: number) => {
  const gold = /GOLD/.test(r.user);
  if (r.schemaName === 'expand') return { ideas: [1, 2, 3].map((k) => ({ title: `Child ${callNumber}.${k}`, pitch: 'p' })) };
  if (r.schemaName === 'judgement') {
    const score = gold ? 5 : 2;
    return { reason: 'Because.', originality: score, feasibility: score, impact: score, keywords: ['shared word'] };
  }
  if (r.schemaName === 'brief') {
    return { name: 'Project', slug: 'project', oneLiner: 'o', problem: 'p', audience: 'a', mvp: ['m'], outOfScope: ['o'], stack: 's', firstSteps: ['f'], openQuestions: ['q'], risks: ['r'] };
  }
  if (r.schemaName === 'summary') {
    return { headline: 'The board leans one way.', themes: [{ name: 'T', insight: 'I', ideas: ['one'] }], strongest: [{ title: 'one', why: 'w' }], gaps: ['g'], nextSteps: ['n'] };
  }
  if (r.schemaName === 'synthesis') {
    return { headline: 'Across boards.', insights: ['i1'], standouts: [{ title: 'one', board: 'B', why: 'w' }], opportunities: ['o1'], nextSteps: ['n1'] };
  }
  if (r.schemaName === 'research') return { leads: [{ id: 'paper-1', title: 'A paper lead', summary: 'S', hook: 'H' }] };
  return { title: 'Crossed', pitch: 'c' };
};

const parseJson = (s: string) => {
  try {
    return s.trim() ? JSON.parse(s) : null;
  } catch {
    return null;
  }
};

export function session(options: SessionOptions = {}): Session {
  const chatCalls: ChatRequest[] = [];
  let failure: Error | null = options.failWith ?? null;
  const chat = async (r: ChatRequest) => {
    chatCalls.push(r);
    if (failure) throw failure;
    return { value: fakeAnswer(r, chatCalls.length), costUsd: options.costUsd ?? 0 };
  };
  const repo = openDb(':memory:');
  const projectsRoot = mkdtempSync(join(tmpdir(), 'ideagen-cli-'));
  const settings = (): AppSettings => ({ ...structuredClone(DEFAULT_APP_SETTINGS), projectsRoot, ...options.settings });
  const engine = createEngine({
    repo, chat, settings, gitInit: false, fetchPage: async () => ({ title: '', text: '' }),
    fetchPapers: async () => [{ id: 'paper-1', title: 'A paper', summary: 'sum', published: '2026-11-01', upvotes: 3 }], reveal: () => {},
  });
  const run = async (...argv: string[]): Promise<Run> => {
    let rawOut = '';
    let rawErr = '';
    const code = await runCli(argv, {
      repo, engine, settings, stdout: (s) => (rawOut += s), stderr: (s) => (rawErr += s), readStdin: async () => options.stdin ?? '',
    });
    const errLines = rawErr.trim() ? rawErr.trim().split('\n').map((l) => JSON.parse(l)) : [];
    return { code, out: parseJson(rawOut), err: errLines.find((l) => 'error' in l) ?? null, rawOut, errLines };
  };
  return { run, chatCalls, setFailure: (e) => (failure = e) };
}

export const newBoard = async (run: Session['run'], ...extra: string[]) =>
  String((await run('board', 'create', '--goal', 'g', ...extra)).out.board.id);
