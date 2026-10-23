// eyes accept <scenario> [--list]: a person moves pending images into place as the new baselines.
// Claude proposes with `eyes diff --update`; it must never be the one to accept.

import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { EyesError } from '../report.mjs';
import { loadScenario } from '../scenario.mjs';
import { acceptPending, listPending, pendingDir, projectRootFrom } from '../baseline.mjs';
import { findProjectRoot, scenarioSlug } from './run.mjs';

const USAGE = 'Usage: eyes accept <scenario> [--list] [--out <projectRoot>]';
const OPTIONS = { list: { type: 'boolean' }, out: { type: 'string' } };
const SCENARIO_FILE = /\.(ya?ml|mjs)$/i;

function parse(args) {
  try {
    return parseArgs({ args, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    throw new EyesError(`${err.message}\n${USAGE}`, 2);
  }
}

export default async function command(args) {
  const { values, positionals } = parse(args);
  if (positionals.length !== 1) throw new EyesError(`eyes accept needs exactly one scenario.\n${USAGE}`, 2);

  if (!values.list && (process.env.CLAUDECODE || process.env.CLAUDE_CODE_SESSION_ID)) {
    throw new EyesError('eyes accept is for you to run in your own terminal after looking at the pending images', 2);
  }

  // A scenario file stands for its report name; anything else is that name.
  const [target] = positionals;
  let scenario = target;
  let projectRoot = projectRootFrom(process.cwd(), values.out);
  if (SCENARIO_FILE.test(target) && fs.existsSync(target)) {
    const loaded = await loadScenario(target);
    scenario = scenarioSlug(loaded.name);
    if (!values.out) projectRoot = findProjectRoot(loaded.dir) ?? projectRoot;
  }

  const items = listPending(projectRoot, scenario);
  if (items.length === 0) throw new EyesError(`No pending images for ${scenario} (looked in ${pendingDir(projectRoot, scenario)})`, 2);

  if (values.list) {
    console.log(`Pending for ${scenario}: ${items.length} images`);
    for (const item of items) console.log(`  ${item.file}  ${item.pending}`);
    return 0;
  }
  acceptPending(projectRoot, scenario);
  console.log(`Accepted ${items.length} image${items.length === 1 ? '' : 's'} for ${scenario}:`);
  for (const item of items) console.log(`  ${item.baseline}`);
  return 0;
}
