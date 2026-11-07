#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { DEFAULT_APP_SETTINGS, makeChat } from '../server/providers.ts';
import { runCli } from '../server/cli.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'data'), { recursive: true });

const repo = openDb(process.env.DB_FILE ?? join(root, 'data', 'ideas.db'));
const settings = () => structuredClone(DEFAULT_APP_SETTINGS);
const engine = createEngine({ repo, chat: makeChat(settings), settings });

process.exitCode = await runCli(process.argv.slice(2), {
  repo,
  engine,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
