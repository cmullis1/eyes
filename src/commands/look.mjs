// eyes look <url|file>: screenshot a page at each profile and report layout problems.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { EyesError, Report } from '../report.mjs';
import { makeRunDir } from '../runDir.mjs';
import { projectRootFrom } from '../baseline.mjs';
import { resolveProfiles } from '../profiles.mjs';
import { BrowserSession, captureEach } from '../web/session.mjs';
import { captureProfile, finishRun, slug } from '../web/capture.mjs';
import { parseStepTimeout } from '../web/deadline.mjs';

const USAGE =
  'Usage: eyes look <url|file> [--views a,b] [--wait <selector>] [--full] [--name <n>] [--out <projectRoot>] [--timeout <ms>] [--step-timeout <ms>]';

const OPTIONS = {
  views: { type: 'string' },
  wait: { type: 'string' },
  full: { type: 'boolean' },
  name: { type: 'string' },
  out: { type: 'string' },
  timeout: { type: 'string' },
  'step-timeout': { type: 'string' },
};

const WEB_URL = /^(https?|file):\/\//i;

function parse(args) {
  let parsed;
  try {
    parsed = parseArgs({ args, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    throw new EyesError(`${err.message}\n${USAGE}`, 2);
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1) throw new EyesError(`eyes look needs exactly one URL or file.\n${USAGE}`, 2);

  let timeoutMs;
  if (values.timeout !== undefined) {
    timeoutMs = Number(values.timeout);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new EyesError(`--timeout must be a positive number of milliseconds, got "${values.timeout}"`, 2);
    }
  }
  const views = values.views === undefined ? undefined : values.views.split(',').map((v) => v.trim()).filter(Boolean);
  if (views && views.length === 0) throw new EyesError(`--views needs at least one view name.\n${USAGE}`, 2);

  return {
    target: positionals[0],
    views,
    wait: values.wait,
    full: Boolean(values.full),
    name: values.name,
    // --out, else the nearest folder above the current one that has a .eyes project, else here.
    projectRoot: projectRootFrom(process.cwd(), values.out),
    timeoutMs,
    stepTimeoutMs: parseStepTimeout(values['step-timeout']),
  };
}

// A URL stays as given; anything else is a file path and becomes a file:/// URL.
export function resolveTarget(target) {
  if (WEB_URL.test(target)) {
    const url = new URL(target);
    return { url: url.href, stem: url.protocol === 'file:' ? path.parse(decodeURIComponent(url.pathname)).name : url.host };
  }
  const file = path.resolve(target);
  if (!fs.existsSync(file)) throw new EyesError(`File not found: ${file}`, 2);
  return { url: pathToFileURL(file).href, stem: path.parse(file).name };
}

// Screenshots `url` at every profile and ends with `finish({report, runDir, shotsByProfile, name})`
// (finishRun by default). `eyes diff` calls this with its own ending.
// stepTimeoutMs: how long each shot and the layout scan may take.
export async function lookAt({ url, name, profiles, projectRoot, wait, full = false, timeoutMs, stepTimeoutMs, finish = finishRun }) {
  const report = new Report(name, profiles.map((p) => p.name));
  const session = await BrowserSession.open();
  try {
    report.setGpu(session.gpu);
    const runDir = makeRunDir(projectRoot, name);
    session.saveLogIn(runDir);

    const shotsByProfile = await captureEach({
      session,
      profiles,
      report,
      capture: (browser, profile) =>
        captureProfile({ browser, profile, report, runDir, url, wait, timeoutMs, stepTimeoutMs }, async (page, tools) => {
          await tools.shot('look', { full, file: slug(profile.name) });
          await tools.layout();
        }),
    });
    return await finish({ report, runDir, shotsByProfile, name });
  } finally {
    await session.close();
  }
}

export default async function command(args) {
  const opts = parse(args);
  const profiles = resolveProfiles(opts.views);
  const { url, stem } = resolveTarget(opts.target);
  return lookAt({
    url,
    name: slug(opts.name ?? stem),
    profiles,
    projectRoot: opts.projectRoot,
    wait: opts.wait,
    full: opts.full,
    timeoutMs: opts.timeoutMs,
    stepTimeoutMs: opts.stepTimeoutMs,
  });
}
