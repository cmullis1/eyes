#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { EyesError } from '../src/report.mjs';

const COMMANDS = ['look', 'run', 'diff', 'accept', 'film', 'serve', 'calibrate'];

const USAGE = `eyes - check visual work in web pages and Godot games

Usage: eyes <command> [args]

Commands:
  look       screenshot a URL or file at each display profile, with errors and layout problems
  run        run a scenario file with real input, checks and named shots
  diff       compare shots with approved baselines (--update proposes pending ones)
  accept     move pending baselines into place (a person runs this, never Claude)
  film       record frames under a fixed clock to a GIF, a contact sheet and a flicker score
  serve      start a dev server command on a free port and keep it running
  calibrate  record this PC's monitor window sizes (open the printed link on each monitor)

Environment: EYES_CALIBRATION=<file> reads and writes calibration there instead of
  ~/.claude/tools/eyes/profiles.json

Exit codes: 0 passed, 1 check/error/layout/diff failed, 2 bad usage, 3 environment failure`;

async function main(argv) {
  const [command, ...args] = argv;
  if (!command || command === '--help' || command === '-h' || !COMMANDS.includes(command)) {
    if (command && command !== '--help' && command !== '-h') {
      console.error(`Unknown command: ${command}\n`);
    }
    console.error(USAGE);
    return 2;
  }
  const modulePath = path.join(import.meta.dirname, '..', 'src', 'commands', `${command}.mjs`);
  const mod = await import(pathToFileURL(modulePath).href);
  return mod.default(args);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  if (err instanceof EyesError) {
    console.error(err.message);
    process.exitCode = err.exitCode;
  } else {
    console.error(err?.stack ?? String(err));
    process.exitCode = 3;
  }
}
