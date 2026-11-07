#!/usr/bin/env node
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { DEFAULT_APP_SETTINGS, makeChat, mergeAppSettings, type AppSettings } from '../server/providers.ts';
import { runCli } from '../server/cli.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'data'), { recursive: true });

function loadSettings(): AppSettings {
  const file = process.env.IDEAGEN_SETTINGS;
  if (!file) return structuredClone(DEFAULT_APP_SETTINGS);
  try {
    return mergeAppSettings(JSON.parse(readFileSync(file, 'utf8')));
  } catch (e: any) {
    process.stderr.write(`${JSON.stringify({ error: `IDEAGEN_SETTINGS ${file}: ${e?.message ?? e}`, code: 'usage' })}\n`);
    process.exit(2);
  }
}

async function readStdin() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const appSettings = loadSettings();
const settings = () => appSettings;
const repo = openDb(process.env.DB_FILE ?? join(root, 'data', 'ideas.db'));
const engine = createEngine({ repo, chat: makeChat(settings), settings });

process.exitCode = await runCli(process.argv.slice(2), {
  repo,
  engine,
  settings,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  readStdin,
});
