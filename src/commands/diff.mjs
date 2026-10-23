// eyes diff <scenario|url|file> [--update]: run like `run` (or `look` for a page), then compare each
// shot with its approved baseline. Changed shots fail the run and get a side-by-side in the contact sheet.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { EyesError } from '../report.mjs';
import { resolveProfiles } from '../profiles.mjs';
import { checkViews, loadScenario } from '../scenario.mjs';
import { finishRun, slug } from '../web/capture.mjs';
import { diffShots, projectRootFrom } from '../baseline.mjs';
import { findProjectRoot, runScenario } from './run.mjs';
import { parseStepTimeout } from '../web/deadline.mjs';
import { lookAt, resolveTarget } from './look.mjs';

const USAGE =
  'Usage: eyes diff <scenario.yaml|scenario.mjs|url|file> [--update] [--views a,b] [--wait <selector>] [--full] [--name <n>] [--out <projectRoot>] [--timeout <ms>] [--step-timeout <ms>]';
const OPTIONS = {
  update: { type: 'boolean' },
  views: { type: 'string' },
  wait: { type: 'string' },
  full: { type: 'boolean' },
  name: { type: 'string' },
  out: { type: 'string' },
  timeout: { type: 'string' },
  'step-timeout': { type: 'string' },
};
const SCENARIO_FILE = /\.(ya?ml|mjs)$/i;
const WEB_URL = /^(https?|file):\/\//i;

function parse(args) {
  let parsed;
  try {
    parsed = parseArgs({ args, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    throw new EyesError(`${err.message}\n${USAGE}`, 2);
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1) throw new EyesError(`eyes diff needs exactly one scenario, URL or file.\n${USAGE}`, 2);

  let timeoutMs;
  if (values.timeout !== undefined) {
    timeoutMs = Number(values.timeout);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new EyesError(`--timeout must be a positive number of milliseconds, got "${values.timeout}"`, 2);
    }
  }
  const views = values.views === undefined ? undefined : values.views.split(',').map((v) => v.trim()).filter(Boolean);
  if (views && views.length === 0) throw new EyesError(`--views needs at least one view name.\n${USAGE}`, 2);
  return { target: positionals[0], views, update: Boolean(values.update), wait: values.wait, full: Boolean(values.full), name: values.name, out: values.out, timeoutMs, stepTimeoutMs: parseStepTimeout(values['step-timeout']) };
}

// The ending of a run: compare the shots, then the usual contact sheet and report. When something
// changed, the sheet shows the side-by-sides (and new shots) one per row so each is legible.
function ending({ projectRoot, update }) {
  return async ({ report, runDir, shotsByProfile, name }) => {
    const result = await diffShots({ projectRoot, scenario: name, shotsByProfile, report, update });
    if (result.refused) report.addNote('--update: run failed; nothing proposed. Fix the errors above first.');
    else if (update && result.pending > 0) {
      report.addNote(`Pending: ${result.pending} images. A person accepts them with: eyes accept ${name}`);
    }
    const sheet = result.changed ? { items: result.items, columns: 1 } : undefined;
    return finishRun({ report, runDir, shotsByProfile, sheet });
  };
}

export default async function command(args) {
  const opts = parse(args);

  if (!WEB_URL.test(opts.target) && SCENARIO_FILE.test(opts.target)) {
    const scenario = await loadScenario(opts.target);
    if (scenario.kind === 'godot' && opts.views) {
      throw new EyesError(`--views is for web scenarios; a Godot scenario sets its size with godot.resolution (${scenario.file})`, 2);
    }
    if (scenario.kind === 'godot' && opts.stepTimeoutMs !== undefined) {
      throw new EyesError(`--step-timeout is for web scenarios; a Godot run is bounded by --timeout (${scenario.file})`, 2);
    }
    // A Godot scenario's shots are compared the same way, under its one profile (godot <resolution>).
    const profiles = scenario.kind === 'godot' ? [] : resolveProfiles(opts.views ?? scenario.views);
    checkViews(scenario, profiles);
    const projectRoot = findProjectRoot(scenario.dir) ?? process.cwd();
    const outRoot = path.resolve(opts.out ?? projectRoot);
    return runScenario(scenario, {
      profiles,
      projectRoot,
      outRoot,
      timeoutMs: opts.timeoutMs,
      stepTimeoutMs: opts.stepTimeoutMs,
      finish: ending({ projectRoot, update: opts.update }),
    });
  }

  const profiles = resolveProfiles(opts.views);
  const { url, stem } = resolveTarget(opts.target);
  const projectRoot = projectRootFrom(process.cwd(), opts.out);
  return lookAt({
    url,
    name: slug(opts.name ?? stem),
    profiles,
    projectRoot,
    wait: opts.wait,
    full: opts.full,
    timeoutMs: opts.timeoutMs,
    stepTimeoutMs: opts.stepTimeoutMs,
    finish: ending({ projectRoot, update: opts.update }),
  });
}
