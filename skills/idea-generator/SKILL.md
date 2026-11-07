---
name: idea-generator
description: Generate, branch, cross and rank ideas toward a goal with the local ideagen CLI. Use when asked to brainstorm, explore options, find the strongest idea, or breed ideas on a board; it scores each idea with a calibrated jury and can turn a top idea into a Claude Code project folder.
---

# idea-generator

Runs the `ideagen` CLI from the idea-generator-2 repo. It uses the user's own Claude subscription through the local `claude` command, so it needs no API key but it does spend plan usage: every idea costs one or more model calls of 10-15 seconds.

Run it from the repo folder: `node bin/ideagen.ts <command>` (or `npm run -s ideagen -- <command>`). Output is JSON on stdout; errors are JSON on stderr. Exit codes: 0 ok, 1 failed (model or network), 2 usage, 3 not found.

## Workflow

1. `board create --goal "<what the ideas must serve>" --lang en` gives a board id. The goal steers every later step, so make it specific.
2. `seed <boardId> "<idea or link>"` adds an idea and waits for its jury score. Add 2-3 seeds.
3. `expand <ideaId>` branches one idea into three. `cross <boardId> <a> <b>` combines two.
4. `evolve <boardId> --steps 5` lets the autopilot breed and judge. `--steps` is required and capped at 50. Start small.
5. `top <boardId> --min-medal silver --limit 5` shows the best ideas, best first.
6. `project <ideaId>` writes a project folder (CLAUDE.md, README, brief) for an idea worth building and prints its path.

## Reading the scores

Each idea gets originality, feasibility and impact, 1-5 each, with a one-sentence `reason` and keywords. `sum` is out of 15. The medal comes from the sum, never from the model: bronze from 9, silver from 11, gold from 13. Gold is rare on purpose, so silver is a strong result. A bare topic such as "electric cars" scores about 5 and gets no medal.

## Cautions

- Report the `reason` of the ideas you recommend; the score alone is not an argument.
- Do not loop `evolve` unattended. Each step is several calls against the user's subscription limits. Ask before running more than about 20 steps.
- The database is shared with the web app (`data/ideas.db`, or `DB_FILE`). Do not run `evolve` on a board whose autopilot is on in the app.
- Exit code 1 with code `not_logged_in` means the user must run `claude` once in a terminal and log in.
