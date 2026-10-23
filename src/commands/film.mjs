// eyes film <url|file|scenario>: record a deterministic frame sequence under a controlled clock,
// make a GIF and a contact sheet of sampled frames, and score how much the picture flickers.
// The page's clock is installed paused before the page runs, so its animation moves only when
// Eyes moves it: one frame is one `runFor(1000 / fps)` and a screenshot.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { EyesError } from '../report.mjs';
import { resolveProfiles } from '../profiles.mjs';
import { checkViews, loadScenario } from '../scenario.mjs';
import { FlickerMeter, TILE, judgeFlicker } from '../flicker.mjs';
import { readRgba, toGif } from '../images.mjs';
import { advanceTime } from '../web/animations.mjs';
import { finishRun, profileLabel, slug } from '../web/capture.mjs';
import { findProjectRoot, runScenario } from './run.mjs';
import { parseStepTimeout, withDeadline } from '../web/deadline.mjs';
import { pruneFrames } from '../godot/runGodot.mjs';
import { resolveTarget } from './look.mjs';
import { projectRootFrom } from '../baseline.mjs';

const USAGE =
  'Usage: eyes film <url|file|scenario.yaml|scenario.mjs> [--seconds 3] [--fps 20] [--views a,b] [--after <step-count>] [--out <projectRoot>] [--timeout <ms>] [--step-timeout <ms>]';
const OPTIONS = {
  seconds: { type: 'string' },
  fps: { type: 'string' },
  views: { type: 'string' },
  after: { type: 'string' },
  out: { type: 'string' },
  timeout: { type: 'string' },
  'step-timeout': { type: 'string' },
};
const SCENARIO_FILE = /\.(ya?ml|mjs)$/i;
const WEB_URL = /^(https?|file):\/\//i;

const DEFAULT_SECONDS = 3;
const DEFAULT_FPS = 20;
const MAX_FPS = 50; // a GIF frame lasts at least 20 ms
const MAX_FRAMES = 600; // across all views
const SHEET_FRAMES = 12;
const GIF_MAX_WIDTH = 960;
const GIF_MAX_BYTES = 300 * 1024 * 1024; // raw pixels held while encoding

const positive = (text, what) => {
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) throw new EyesError(`${what} must be a positive number, got "${text}"`, 2);
  return value;
};

function parse(args) {
  let parsed;
  try {
    parsed = parseArgs({ args, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    throw new EyesError(`${err.message}\n${USAGE}`, 2);
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1) throw new EyesError(`eyes film needs exactly one URL, file or scenario.\n${USAGE}`, 2);

  const seconds = values.seconds === undefined ? DEFAULT_SECONDS : positive(values.seconds, '--seconds (seconds to record)');
  const fps = values.fps === undefined ? DEFAULT_FPS : positive(values.fps, '--fps (frames per second)');
  if (fps > MAX_FPS) throw new EyesError(`--fps can be at most ${MAX_FPS}: a GIF frame lasts at least 20 ms, got "${values.fps}"`, 2);
  const frameCount = Math.round(seconds * fps);
  if (frameCount < 1) throw new EyesError(`--seconds ${values.seconds ?? DEFAULT_SECONDS} at --fps ${values.fps ?? DEFAULT_FPS} is less than one frame`, 2);

  let after;
  if (values.after !== undefined) {
    after = Number(values.after);
    if (!Number.isInteger(after) || after < 0) throw new EyesError(`--after must be a whole number of steps, got "${values.after}"`, 2);
  }
  let timeoutMs;
  if (values.timeout !== undefined) timeoutMs = positive(values.timeout, '--timeout (milliseconds)');
  const views = values.views === undefined ? undefined : values.views.split(',').map((v) => v.trim()).filter(Boolean);
  if (views && views.length === 0) throw new EyesError(`--views needs at least one view name.\n${USAGE}`, 2);

  const stepTimeoutMs = parseStepTimeout(values['step-timeout']);
  return { target: positionals[0], seconds, fps, frameCount, after, views, out: values.out, timeoutMs, stepTimeoutMs };
}

// The GIF is encoded from raw pixels held in memory, so a long film gets a narrower GIF.
function gifWidth(frameCount, { width, height }) {
  const pixels = GIF_MAX_BYTES / 4 / frameCount;
  const fit = Math.floor(Math.sqrt((pixels * width) / height));
  return Math.max(64, Math.min(GIF_MAX_WIDTH, fit));
}

// Which of `count` frames (1-based) go on the contact sheet: every ceil(count/12)-th, starting with the first.
export function sampledFrames(count) {
  const every = Math.ceil(count / SHEET_FRAMES);
  return Array.from({ length: count }, (_, i) => i + 1).filter((n) => (n - 1) % every === 0);
}

// The GIF, the flicker score and their report lines, from one profile's frames in order. A GIF frame
// lasts at least 20 ms and is held in memory while encoding, so a fast or long film puts every
// n-th frame in the GIF; the flicker score always looks at every frame.
async function filmOutputs({ framePaths, fps, profileName, runDir, report, profileCount }) {
  const meter = new FlickerMeter();
  for (const file of framePaths) meter.push(await readRgba(file));

  const every = Math.max(1, Math.ceil(fps / MAX_FPS), Math.ceil(framePaths.length / MAX_FRAMES));
  const gifFrames = framePaths.filter((_, i) => i % every === 0);
  const first = await readRgba(framePaths[0]);
  const gif = path.join(runDir, `${slug(profileName)}.gif`);
  await toGif(gifFrames, gif, fps / every, gifWidth(gifFrames.length, first));
  report.addShot({ name: 'gif', profile: profileName, path: gif });

  // Judged on the worst tile, so a small strobing element on a big page is not averaged away.
  const result = meter.result();
  const { text, high, threshold } = judgeFlicker(result.score);
  const where = result.tile ? `: worst ${TILE}x${TILE} px tile at ${result.tile.x},${result.tile.y}; whole frame ${result.frame.toFixed(3)}` : '';
  const prefix = profileCount > 1 ? `[${profileName}] ` : '';
  const sampling = every > 1 ? ` (1 frame in ${every})` : '';
  report.addNote(`${prefix}flicker ${text} (${high ? 'high' : 'steady'})${where}`);
  report.addNote(`${prefix}${framePaths.length} frames at ${fps} fps -> GIF${sampling} ${gif}`);
  report.addCheck({
    profile: profileName,
    step: report.checks.filter((c) => c.profile === profileName).length + 1,
    label: 'flicker',
    passed: !high,
    detail: `score ${text}${high ? ` is above ${threshold}: pixels change and change back between frames, worst at ${result.tile.x},${result.tile.y} px` : ''}`,
  });
}

// Records the frames of one profile; returns the sampled frames for the contact sheet.
// Each frame (moving the clock, then the screenshot) has stepTimeoutMs: a page stuck in a loop
// throws StepTimeout, which the run records as a timeout.
async function recordFilm({ page, profile, runDir, report, stepTimeoutMs }, { fps, frameCount, profileCount }) {
  const folder = path.join(runDir, slug(profile.name));
  fs.mkdirSync(folder, { recursive: true });
  const framePaths = [];
  const sampled = [];
  const onSheet = new Set(sampledFrames(frameCount));
  const base = profileLabel(profile);

  let elapsed = 0;
  for (let n = 1; n <= frameCount; n++) {
    // Whole milliseconds, from the running total, so a rate like 30 fps does not drift.
    const next = Math.round((n * 1000) / fps);
    const file = path.join(folder, `frame-${String(n).padStart(4, '0')}.png`);
    const step = next - elapsed;
    await withDeadline(
      (async () => {
        await advanceTime(page, step);
        await page.screenshot({ path: file });
      })(),
      stepTimeoutMs,
      `frame ${n}`,
    );
    elapsed = next;
    framePaths.push(file);
    if (onSheet.has(n)) sampled.push({ name: `frame-${n}`, path: file, label: `${base} frame ${n} (${(elapsed / 1000).toFixed(2)} s)`, profile: profile.name });
  }

  await filmOutputs({ framePaths, fps, profileName: profile.name, runDir, report, profileCount });
  return sampled;
}

// A Godot scenario films its own frames (godot.frames at godot.fps): the sheet samples them like a web film.
// Godot frame numbers start at 0, so sampled frame n is Godot frame n - 1. Once the GIF, the score and
// the sheet are made, only the sampled frames and the scenario's own shots stay on disk.
async function finishGodotFilm({ report, runDir, shotsByProfile, godot }) {
  const { framePaths, fps, profile } = godot;
  const sampled = sampledFrames(framePaths.length).map((n) => ({
    name: `frame-${n - 1}`,
    path: framePaths[n - 1],
    label: `frame ${n - 1} (${((n - 1) / fps).toFixed(2)} s)`,
    profile,
  }));
  try {
    if (framePaths.length === 0) return await finishRun({ report, runDir, shotsByProfile });
    await filmOutputs({ framePaths, fps, profileName: profile, runDir, report, profileCount: 1 });
    return await finishRun({ report, runDir, shotsByProfile: [sampled] });
  } finally {
    pruneFrames(framePaths, [...sampled, ...godot.shots].map((frame) => frame.path));
  }
}

// eyes film <godot scenario.yaml>: the scenario says how long and how fast, so the web-only flags are refused.
function filmGodot(loaded, opts, args) {
  const given = ['--seconds', '--fps', '--after', '--views', '--step-timeout'].filter((flag) => args.some((a) => a === flag || a.startsWith(`${flag}=`)));
  if (given.length > 0) {
    throw new EyesError(
      `${given.join(', ')} ${given.length > 1 ? 'are' : 'is'} for web pages: a Godot scenario films godot.frames frames at godot.fps (${loaded.file})`,
      2,
    );
  }
  const projectRoot = findProjectRoot(loaded.dir) ?? process.cwd();
  return runScenario(
    { ...loaded, name: `${loaded.name}-film` },
    { profiles: [], projectRoot, outRoot: path.resolve(opts.out ?? projectRoot), timeoutMs: opts.timeoutMs, finish: finishGodotFilm, play: { film: true } },
  );
}

export default async function command(args) {
  const opts = parse(args);
  const isScenario = !WEB_URL.test(opts.target) && SCENARIO_FILE.test(opts.target);

  let scenario;
  let projectRoot;
  if (isScenario) {
    const loaded = await loadScenario(opts.target);
    if (loaded.kind === 'godot') return filmGodot(loaded, opts, args);
    if (opts.after !== undefined) {
      if (loaded.script) throw new EyesError('--after counts steps, and a .mjs scenario has none: it always runs whole', 2);
      if (opts.after > loaded.steps.length) {
        throw new EyesError(`--after ${opts.after}, but ${loaded.file} has only ${loaded.steps.length} steps`, 2);
      }
    }
    scenario = { ...loaded, name: `${loaded.name}-film`, clock: 'fixed' };
    projectRoot = findProjectRoot(loaded.dir) ?? process.cwd();
  } else {
    if (opts.after !== undefined) throw new EyesError(`--after needs a scenario to take steps from, and "${opts.target}" is a page.\n${USAGE}`, 2);
    const { url, stem } = resolveTarget(opts.target);
    scenario = { name: `${slug(stem)}-film`, kind: 'web', url, steps: [], mask: [], clock: 'fixed', file: opts.target, dir: process.cwd() };
    projectRoot = projectRootFrom(process.cwd()); // the nearest .eyes project, as for look and diff
  }

  const profiles = resolveProfiles(opts.views ?? ['desktop']);
  checkViews(scenario, profiles);
  if (opts.frameCount * profiles.length > MAX_FRAMES) {
    throw new EyesError(
      `${opts.frameCount} frames at ${profiles.length} view(s) is ${opts.frameCount * profiles.length} frames; the most is ${MAX_FRAMES}. Lower --seconds or --fps, or use fewer --views.`,
      2,
    );
  }

  const sampledBy = new Map();
  const finale = async (context) => {
    sampledBy.set(context.profile.name, await recordFilm(context, { fps: opts.fps, frameCount: opts.frameCount, profileCount: profiles.length }));
  };
  // The sheet shows the sampled frames; a view that never got to film shows what it did capture.
  const finish = ({ report, runDir, shotsByProfile }) =>
    finishRun({ report, runDir, shotsByProfile: shotsByProfile.map((shots, i) => sampledBy.get(profiles[i].name) ?? shots) });

  return runScenario(scenario, {
    profiles,
    projectRoot,
    outRoot: path.resolve(opts.out ?? projectRoot),
    timeoutMs: opts.timeoutMs,
    stepTimeoutMs: opts.stepTimeoutMs,
    finish,
    play: { maxSteps: opts.after, finale },
  });
}
