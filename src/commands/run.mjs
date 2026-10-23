// eyes run <scenario.yaml|.mjs>: play a scenario through the page with real input, at each profile.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { EyesError, Report } from '../report.mjs';
import { makeRunDir } from '../runDir.mjs';
import { resolveProfiles } from '../profiles.mjs';
import { checkViews, loadScenario } from '../scenario.mjs';
import { startServer, registerCleanup, killTree, killTreeSync } from '../serve.mjs';
import { BrowserSession, captureEach } from '../web/session.mjs';
import { captureProfile, finishRun } from '../web/capture.mjs';
import { runSteps, scriptTools } from '../web/steps.mjs';
import { freezeTime } from '../web/determinism.mjs';
import { DEFAULT_STEP_TIMEOUT_MS, StepTimeout, parseStepTimeout, withDeadline } from '../web/deadline.mjs';
import { godotProfile, listFrames, pruneFrames, resolveGodot, runGodot } from '../godot/runGodot.mjs';

const USAGE = 'Usage: eyes run <scenario.yaml|scenario.mjs> [--views a,b] [--out <projectRoot>] [--timeout <ms>] [--step-timeout <ms>]';
const OPTIONS = {
  views: { type: 'string' },
  out: { type: 'string' },
  timeout: { type: 'string' },
  'step-timeout': { type: 'string' },
};

const BEFORE_TIMEOUT_MS = 5 * 60 * 1000;
const BEFORE_OUTPUT_LINES = 20;
const BEFORE_CLOSE_GRACE_MS = 1000;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const IS_WIN = process.platform === 'win32';

function parse(args) {
  let parsed;
  try {
    parsed = parseArgs({ args, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    throw new EyesError(`${err.message}\n${USAGE}`, 2);
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1) throw new EyesError(`eyes run needs exactly one scenario file.\n${USAGE}`, 2);

  let timeoutMs;
  if (values.timeout !== undefined) {
    timeoutMs = Number(values.timeout);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new EyesError(`--timeout must be a positive number of milliseconds, got "${values.timeout}"`, 2);
    }
  }
  const views = values.views === undefined ? undefined : values.views.split(',').map((v) => v.trim()).filter(Boolean);
  if (views && views.length === 0) throw new EyesError(`--views needs at least one view name.\n${USAGE}`, 2);
  return { file: positionals[0], views, out: values.out, timeoutMs, stepTimeoutMs: parseStepTimeout(values['step-timeout']) };
}

// The folder holding the .eyes directory the scenario lives under, if there is one.
export function findProjectRoot(scenarioDir) {
  for (let dir = scenarioDir; ; dir = path.dirname(dir)) {
    if (path.basename(dir) === '.eyes') return path.dirname(dir);
    if (path.dirname(dir) === dir) return null;
  }
}

// Safe as a folder name and as one word in the report's first line.
export function scenarioSlug(name) {
  const text = String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return text || 'scenario';
}

// Runs the scenario's `before` command once, to completion, in the project root. A non-zero exit
// is exit 3 with the last lines of output. The process tree is killed on timeout or Ctrl-C.
export async function runBefore(command, cwd) {
  const lines = [];
  let partial = '';
  const onData = (chunk) => {
    const parts = (partial + chunk.toString()).split(/\r?\n/);
    partial = parts.pop();
    lines.push(...parts);
    if (lines.length > 200) lines.splice(0, lines.length - 200);
  };
  const child = spawn(command, { cwd, shell: true, windowsHide: true, detached: !IS_WIN, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  // The streams can still hold unread output when 'exit' fires, so finish on 'close'. A grandchild
  // that inherited the pipes can keep them open, so after 'exit' wait only a short while for 'close'.
  let exited = false;
  const done = new Promise((resolve) => {
    let result = null;
    let grace = null;
    const finish = () => {
      clearTimeout(grace);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(result);
    };
    child.once('exit', (code, signal) => {
      exited = true;
      result = { code, signal };
      grace = setTimeout(finish, BEFORE_CLOSE_GRACE_MS);
    });
    child.once('close', () => {
      if (result) finish();
    });
    child.once('error', (err) => {
      exited = true;
      result = { code: null, signal: null, error: err };
      finish();
    });
  });
  const unregister = registerCleanup(({ sync }) => {
    if (exited) return undefined;
    return sync ? killTreeSync(child.pid) : killTree(child.pid);
  });

  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(resolve, BEFORE_TIMEOUT_MS, 'timeout');
  });
  const result = await Promise.race([done, timedOut]);
  clearTimeout(timer);
  if (result === 'timeout' && !exited) await killTree(child.pid);
  unregister();

  const tail = () => {
    const all = partial ? [...lines, partial] : lines;
    const text = all.slice(-BEFORE_OUTPUT_LINES).join('\n');
    return text ? `\nLast output:\n${text}` : '\n(it printed nothing)';
  };
  if (result === 'timeout') {
    throw new EyesError(`The "before" command did not finish within ${BEFORE_TIMEOUT_MS / 1000} s: ${command}${tail()}`, 3);
  }
  if (result.error) throw new EyesError(`The "before" command could not start: ${result.error.message}`, 3);
  if (result.code !== 0) {
    const how = result.signal ? `signal ${result.signal}` : `exit code ${result.code}`;
    throw new EyesError(`The "before" command failed (${how}): ${command}${tail()}`, 3);
  }
}

// url: a path on the served origin, an absolute URL, or a file path relative to the scenario file.
export function resolveUrl(scenario, origin) {
  const { url } = scenario;
  if (url && SCHEME.test(url)) return new URL(url).href;
  if (origin) return new URL(url ?? '/', origin).href;
  if (!url) throw new EyesError(`${scenario.file}: the scenario needs a "url" (a page, a URL, or a path on its "serve" server)`, 2);
  const file = path.resolve(scenario.dir, url);
  if (!fs.existsSync(file)) throw new EyesError(`Page file not found: ${file} (url "${url}" is relative to the scenario file)`, 2);
  return pathToFileURL(file).href;
}

// Plays the scenario at every profile in a fresh page. A problem at one profile is recorded and
// the run goes on to the next. Returns the shots taken, grouped by profile, for the contact sheet.
// origin: the served origin when the scenario has a dev server; its url is then a path on it.
// maxSteps: run only the first N steps of a YAML scenario.
// finale({page, profile, runDir, report, tools, stepTimeoutMs}): runs after the steps passed, in place of
// the layout check and the closing 'final' shot (`eyes film` records its frames here).
// stepTimeoutMs (--step-timeout) overrides the scenario's stepTimeout: the time each step, the whole
// .mjs script, each shot and the layout scan may take.
export async function runWebScenario(scenario, { profiles, runDir, report, origin, timeoutMs, maxSteps, finale, stepTimeoutMs }) {
  const url = resolveUrl(scenario, origin);
  const deadline = stepTimeoutMs ?? scenario.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const session = await BrowserSession.open();
  session.saveLogIn(runDir);
  try {
    report.setGpu(session.gpu);
    const capture = (browser, profile) =>
      captureProfile(
        {
          browser,
          profile,
          report,
          runDir,
          url,
          wait: scenario.wait,
          mask: scenario.mask,
          timeoutMs,
          stopOnProblem: true,
          nameShots: true,
          beforeNavigate: scenario.clock === 'fixed' ? (page) => freezeTime(page, { seed: scenario.seed }) : undefined,
          frames: scenario.clock !== 'fixed',
          stepTimeoutMs: deadline,
        },
        async (page, tools) => {
          let taken = 0;
          const counted = {
            ...tools,
            shot: (...args) => {
              taken += 1;
              return tools.shot(...args);
            },
          };
          let ok;
          if (scenario.script) {
            const script = scriptTools({ profile, report, tools: counted });
            try {
              await withDeadline(scenario.script(page, script.eyes), deadline, 'the scenario script');
            } catch (err) {
              if (!(err instanceof StepTimeout)) throw err;
              await script.timedOut(err);
            }
            await script.settle();
            ok = !script.failed();
          } else {
            const steps = maxSteps === undefined ? scenario.steps : scenario.steps.slice(0, maxSteps);
            ok = await runSteps(page, steps, { profile, report, tools: counted, stepTimeoutMs: deadline, clockFixed: scenario.clock === 'fixed' });
          }
          if (ok) {
            if (finale) await finale({ page, profile, runDir, report, tools, stepTimeoutMs: deadline });
            else await tools.layout();
          }
          // A run always leaves a shot for the sheet, unless a finale is about to take the frames.
          if (taken === 0 && !(ok && finale)) await counted.shot('final');
        },
      );
    return await captureEach({ session, profiles, report, capture });
  } finally {
    await session.close();
  }
}

// kind: godot. The scenario's `before` command, then one Godot run at the scenario's resolution.
// `finish` also receives `godot`: {profile, shots, framePaths, fps}. Only the shots' frames are kept,
// unless `film` is set: then every frame reaches `finish` (`eyes film` makes its GIF and prunes them itself).
async function runGodotScenario(scenario, { projectRoot, outRoot, timeoutMs, finish, film = false }) {
  if (scenario.before) await runBefore(scenario.before, projectRoot);
  const resolved = resolveGodot(scenario, { projectRoot }); // exit 2 or 3 before any run folder exists
  const name = scenarioSlug(scenario.name);
  const report = new Report(name, [godotProfile(scenario)]);
  const runDir = makeRunDir(outRoot, name);
  let godot;
  try {
    godot = await runGodot(scenario, { runDir, report, projectRoot, timeoutMs, resolved, finalShot: !film });
  } catch (err) {
    // A run that stops with an error (a timeout, a bad input name) keeps only its last frame, to show where it got to.
    const left = listFrames(path.join(runDir, 'frames'));
    pruneFrames(left, left.slice(-1));
    throw err;
  }
  if (!film) pruneFrames(godot.framePaths, godot.shots.map((shot) => shot.path));
  return finish({ report, runDir, shotsByProfile: [godot.shots], name, godot });
}

// The whole run flow: the scenario's `before` command, its dev server, every profile, then the ending.
// `finish({report, runDir, shotsByProfile, name})` is the ending; it prints the report and returns the
// exit code (finishRun by default). `eyes diff` passes its own, which compares the shots first.
// play: extra options for runWebScenario (maxSteps, finale).
// A Godot scenario runs in Godot instead: profiles do not apply, and play.film keeps every frame for `eyes film`.
export async function runScenario(scenario, { profiles, projectRoot, outRoot, timeoutMs, stepTimeoutMs, finish = finishRun, play = {} }) {
  if (scenario.kind === 'godot') return runGodotScenario(scenario, { projectRoot, outRoot, timeoutMs, finish, film: play.film });
  // `before` and `serve` run in the project root; outRoot only says where the run folder goes.
  if (scenario.before) await runBefore(scenario.before, projectRoot);

  let server = null;
  let exitCode;
  let stopError = null;
  try {
    if (scenario.serve) server = await startServer(scenario.serve, { cwd: projectRoot });
    const origin = server?.url;
    resolveUrl(scenario, origin); // a bad url is exit 2 before any run folder exists
    const name = scenarioSlug(scenario.name);
    const report = new Report(name, profiles.map((p) => p.name));
    const runDir = makeRunDir(outRoot, name);
    const shotsByProfile = await runWebScenario(scenario, { profiles, runDir, report, origin, timeoutMs, stepTimeoutMs, ...play });
    const early = server?.exitedEarly();
    if (early) {
      const tail = server.logTail();
      report.addError({ kind: 'server', text: `The dev server exited during the run (${early}): ${scenario.serve}${tail ? `. Its output ended: ${tail}` : ''}` });
    }
    exitCode = await finish({ report, runDir, shotsByProfile, name });
  } finally {
    // Stopping the server must not hide the report that was already printed, or an earlier error.
    if (server) {
      try {
        await server.stop();
      } catch (err) {
        stopError = err;
        if (exitCode === undefined) console.error(err.message);
      }
    }
  }
  if (stopError) throw stopError;
  return exitCode;
}

export default async function command(args) {
  const opts = parse(args);
  const scenario = await loadScenario(opts.file);
  if (scenario.kind === 'godot' && opts.views) {
    throw new EyesError(`--views is for web scenarios; a Godot scenario sets its size with godot.resolution (${scenario.file})`, 2);
  }
  if (scenario.kind === 'godot' && opts.stepTimeoutMs !== undefined) {
    throw new EyesError(`--step-timeout is for web scenarios; a Godot run is bounded by --timeout (${scenario.file})`, 2);
  }
  const profiles = scenario.kind === 'godot' ? [] : resolveProfiles(opts.views ?? scenario.views);
  checkViews(scenario, profiles);
  const projectRoot = findProjectRoot(scenario.dir) ?? process.cwd();
  const outRoot = path.resolve(opts.out ?? projectRoot);
  return runScenario(scenario, { profiles, projectRoot, outRoot, timeoutMs: opts.timeoutMs, stepTimeoutMs: opts.stepTimeoutMs });
}
