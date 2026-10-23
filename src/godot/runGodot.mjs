// Godot adapter: runs one scene of a Godot project with scripted input at a fixed frame rate.
// Godot's movie writer saves every frame as a PNG and locks the game's timestep to 1/fps, so a run
// is deterministic: the same scenario gives the same frames. godot/eyes_driver.gd fires the inputs,
// evaluates the checks against the live scene and writes results.json; this module starts Godot,
// reads its output for errors, and turns the results into report checks, shots and errors.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import sharp from 'sharp';
import { EyesError } from '../report.mjs';
import { registerCleanup, killTree, killTreeSync } from '../serve.mjs';

export const DRIVER = path.resolve(import.meta.dirname, '..', '..', 'godot', 'eyes_driver.gd');

const IS_WIN = process.platform === 'win32';
const OFF_SCREEN = '-32000,-32000';
const FRAME_FILE = /^f(\d{8})\.png$/;
const TAIL_LINES = 20;
const MAX_ERRORS = 200; // distinct errors kept; repeats of one error are counted, not kept
const CLOSE_GRACE_MS = 1000;
const SOFTWARE_RENDERER = /llvmpipe|swiftshader|softpipe|basic render|warp/i;

export const godotProfile = (scenario) => `godot ${scenario.godot.resolution}`;
// A sheet tile's label. A Godot run has one profile (named in the report's first line), so the label
// spends its few characters on the shot and the frame.
export const frameLabel = (name, frame, fps) => `${name}: frame ${frame} (${(frame / fps).toFixed(2)} s)`;
export const frameFile = (framesDir, frame) => path.join(framesDir, `f${String(frame).padStart(8, '0')}.png`);

// The project's main scene, from project.godot, or null.
function mainSceneOf(projectFile) {
  const match = /^\s*run\/main_scene\s*=\s*"([^"]*)"/m.exec(fs.readFileSync(projectFile, 'utf8'));
  return match?.[1] || null;
}

// Where Godot, the project and the scene are. Exit 2 for a scenario that points at nothing, exit 3
// when the Godot exe is missing. Runs before any run folder exists.
export function resolveGodot(scenario, { projectRoot, env = process.env }) {
  const g = scenario.godot;
  const fromEnv = g.exe === undefined;
  const exeSetting = fromEnv ? env.EYES_GODOT?.trim() : g.exe;
  if (!exeSetting) {
    throw new EyesError(
      `${scenario.file}: Godot scenarios need the Godot console exe: set godot.exe in the scenario, or the EYES_GODOT environment variable`,
      2,
    );
  }
  const exe = path.resolve(scenario.dir, exeSetting);
  if (!fs.existsSync(exe) || !fs.statSync(exe).isFile()) {
    throw new EyesError(`Godot was not found at ${exe} (from ${fromEnv ? 'EYES_GODOT' : `godot.exe in ${scenario.file}`})`, 3);
  }

  const project = g.project === undefined ? projectRoot : path.resolve(scenario.dir, g.project);
  const projectFile = path.join(project, 'project.godot');
  if (!fs.existsSync(projectFile)) {
    throw new EyesError(
      `${scenario.file}: ${project} has no project.godot. Set godot.project to the Godot project folder (it defaults to the folder holding .eyes)`,
      2,
    );
  }

  const scene = g.scene ?? mainSceneOf(projectFile);
  if (!scene) throw new EyesError(`${scenario.file}: the project has no main scene; set godot.scene, like res://main.tscn`, 2);
  if (scene.startsWith('res://')) {
    const sceneFile = path.join(project, ...scene.slice('res://'.length).split('/'));
    if (!fs.existsSync(sceneFile)) throw new EyesError(`${scenario.file}: the scene ${scene} does not exist (${sceneFile})`, 2);
  }
  return { exe, project, scene };
}

// The console exe on Windows is a small wrapper that starts the real (GUI) exe beside it. Starting the
// GUI exe directly with a hidden window keeps Godot's window off the screen and out of focus: Godot
// clamps --position onto a screen, and a wrapper does not pass "start hidden" on. Frames are the same.
function guiExeFor(exe) {
  const match = /^(.*)_console(\.exe)$/i.exec(exe);
  if (!match) return exe;
  const gui = `${match[1]}${match[2]}`;
  return fs.existsSync(gui) ? gui : exe;
}

export function godotArgs({ exe, project, driver, movie, fps, resolution, frames, plan }) {
  return {
    command: guiExeFor(exe),
    args: [
      '--path', project,
      '--script', driver,
      '--write-movie', movie,
      '--fixed-fps', String(fps),
      '--resolution', resolution,
      '--position', OFF_SCREEN,
      // A project set to fullscreen (window/size/mode) would ignore --resolution.
      '--windowed',
      // Frames are written as fast as they render instead of at the monitor's refresh rate.
      '--disable-vsync',
      '--quit-after', String(frames),
      '--', '--eyes-plan', plan,
    ],
  };
}

const ANSI = /\x1b\[[0-9;]*m/g;
const ERROR_LINE = /^(?:SCRIPT ERROR|SHADER ERROR|UNKNOWN ERROR|ERROR):\s*(.*)$/;
const AT_LINE = /^\s+at:\s*(.*?)\s*$/;

// Reads Godot's output line by line: the engine version, the renderer, and every SCRIPT ERROR or
// ERROR with the location from the "at:" line under it. A repeated error is kept once, with a count.
// stdout and stderr arrive as separate chunks, so each stream keeps its own partial line and its own
// error waiting for an "at:" line.
export class GodotOutput {
  #streams = new Map(); // stream name -> {partial, pending}
  #errors = new Map();
  #tail = [];
  version = null;
  renderer = null;

  #stream(name) {
    if (!this.#streams.has(name)) this.#streams.set(name, { partial: '', pending: null });
    return this.#streams.get(name);
  }

  push(chunk, streamName = 'stdout') {
    const stream = this.#stream(streamName);
    const parts = (stream.partial + chunk).split(/\r?\n/);
    stream.partial = parts.pop();
    for (const line of parts) this.#line(stream, line.replace(ANSI, ''));
  }

  #line(stream, line) {
    if (line.trim()) {
      this.#tail.push(line);
      if (this.#tail.length > TAIL_LINES) this.#tail.shift();
    }
    const at = stream.pending && AT_LINE.exec(line);
    if (at) {
      const call = /^(.+?)\s*\((.+)\)$/.exec(at[1]);
      stream.pending.location = call ? `${call[2]} in ${call[1]}` : at[1];
      this.#commit(stream);
      return;
    }
    if (!/^\s/.test(line)) this.#commit(stream);

    const error = ERROR_LINE.exec(line);
    if (error) {
      stream.pending = { text: error[1].trim(), location: undefined };
      return;
    }
    const version = /^Godot Engine v(\S+)/.exec(line);
    if (version) this.version = version[1];
    const device = /^(?:OpenGL|Vulkan|Direct3D|D3D|Metal)\b.* - (.+?) - Using Device(?: #\d+)?: (.+)$/.exec(line);
    if (device) this.renderer = `${device[1]}: ${device[2].split(' - ').at(-1).trim()}`;
  }

  #commit(stream) {
    if (!stream.pending) return;
    const { text, location } = stream.pending;
    stream.pending = null;
    const key = `${text}\n${location ?? ''}`;
    const seen = this.#errors.get(key);
    if (seen) seen.count += 1;
    else if (this.#errors.size < MAX_ERRORS) this.#errors.set(key, { text, location, count: 1 });
  }

  finish() {
    for (const stream of this.#streams.values()) {
      if (stream.partial) this.#line(stream, stream.partial.replace(ANSI, ''));
      stream.partial = '';
      this.#commit(stream);
    }
    const errors = [...this.#errors.values()].map(({ text, location, count }) => {
      const error = { text: count > 1 ? `${text} (${count} times)` : text };
      if (location) error.location = location;
      return error;
    });
    return { version: this.version, renderer: this.renderer, errors, tail: [...this.#tail] };
  }
}

export function parseGodotOutput(text) {
  const output = new GodotOutput();
  output.push(text);
  const { version, renderer, errors } = output.finish();
  return { version, renderer, errors };
}

// The environment Godot runs in: its user data (user://, logs, caches) goes under dataDir instead of
// the person's real app data, so a run neither reads nor changes their saves and settings, and two
// runs start from the same (empty) user data. Godot takes user:// from APPDATA on Windows,
// XDG_DATA_HOME on Linux and the home folder on macOS.
export function isolatedEnv(dataDir, env = process.env, platform = process.platform) {
  const key = { win32: 'APPDATA', darwin: 'HOME' }[platform] ?? 'XDG_DATA_HOME';
  // Windows environment names are case-insensitive: drop every spelling so only ours reaches Godot.
  const out = Object.fromEntries(Object.entries(env).filter(([name]) => name.toUpperCase() !== key));
  out[key] = dataDir;
  return out;
}

// Starts Godot and waits for it to quit. The whole process tree is killed on timeout, Ctrl-C or exit.
async function playGodot({ command, args, cwd, timeoutMs, logFile, dataDir }) {
  const output = new GodotOutput();
  fs.mkdirSync(dataDir, { recursive: true });
  const log = fs.createWriteStream(logFile);
  let logError = null;
  log.on('error', (err) => {
    logError = err;
  });
  let logOpen = true;
  const child = spawn(command, args, {
    cwd,
    env: isolatedEnv(dataDir),
    windowsHide: true,
    detached: !IS_WIN,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      if (logOpen) log.write(chunk);
      output.push(chunk, name);
    });
  }

  // Output can still be unread when 'exit' fires, so finish on 'close', but only wait briefly for it.
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
      grace = setTimeout(finish, CLOSE_GRACE_MS);
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
    timer = setTimeout(resolve, timeoutMs, 'timeout');
  });
  const result = await Promise.race([done, timedOut]);
  clearTimeout(timer);
  if (result === 'timeout' && !exited) await killTree(child.pid);
  unregister();
  // After a kill the pipes may still deliver a late chunk: stop reading before the log is closed.
  child.stdout.destroy();
  child.stderr.destroy();
  logOpen = false;
  await new Promise((resolve) => log.end(resolve));

  const parsed = output.finish();
  const tail = () => (parsed.tail.length ? `\nLast output:\n${parsed.tail.join('\n')}` : '\n(it printed nothing)');
  if (result === 'timeout') {
    throw new EyesError(`Godot (pid ${child.pid}) did not finish within ${Math.round(timeoutMs / 1000)} s and was stopped with its process tree.${tail()}`, 3);
  }
  if (result.error) throw new EyesError(`Godot could not start (${command}): ${result.error.message}`, 3);
  return { ...result, ...parsed, tail, logError };
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

// Runs the scenario's frames. Errors, checks and shots go into the report; returns
// {profile, shots, framePaths, fps} where shots are contact-sheet tiles and framePaths every frame in order.
// Every frame stays on disk: the caller prunes them (pruneFrames) once it has what it needs.
// resolved: from resolveGodot (it is resolved again when missing).
// finalShot: when the scenario takes no shots, the last frame becomes the 'final' shot (not for film).
export async function runGodot(scenario, { runDir, report, projectRoot, timeoutMs, resolved, finalShot = true }) {
  const { exe, project, scene } = resolved ?? resolveGodot(scenario, { projectRoot });
  const { fps, frames, resolution } = scenario.godot;
  const profile = godotProfile(scenario);
  const framesDir = path.join(runDir, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });

  const planFile = path.join(runDir, 'plan.json');
  const resultsFile = path.join(runDir, 'results.json');
  fs.writeFileSync(planFile, `${JSON.stringify({ scene, frames, results: resultsFile, steps: scenario.steps }, null, 2)}\n`);

  const { command, args } = godotArgs({ exe, project, driver: DRIVER, movie: path.join(framesDir, 'f.png'), fps, resolution, frames, plan: planFile });
  let played;
  try {
    played = await playGodot({
      command,
      args,
      cwd: project,
      timeoutMs: timeoutMs ?? ((frames / fps) * 10 + 60) * 1000,
      logFile: path.join(runDir, 'godot.log'),
      dataDir: path.join(runDir, 'appdata'),
    });
  } finally {
    // The movie writer also records the game's audio (f.wav, about 11 MB a minute); nothing here uses it.
    try {
      fs.rmSync(path.join(framesDir, 'f.wav'), { force: true });
    } catch {
      // still held by a Godot that was just killed; it is small next to the frames
    }
  }
  if (played.logError) report.addNote(`Could not write godot.log: ${played.logError.message}`);

  const results = readJson(resultsFile);
  const framePaths = listFrames(framesDir);
  const how = played.signal ? `signal ${played.signal}` : `exit code ${played.code}`;
  if (!results && framePaths.length === 0) throw new EyesError(`Godot stopped (${how}) before running the scene.${played.tail()}`, 3);

  // An input name Godot does not know is a scenario mistake: exit 2, naming the step.
  const stepProblems = (results?.problems ?? []).filter((p) => p.step > 0);
  if (stepProblems.length > 0) throw new EyesError(stepProblems.map((p) => `${scenario.file}: step ${p.step}: ${p.text}`).join('\n'), 2);

  if (played.version || played.renderer) {
    const version = played.version?.replace(/\.official\..*$/, '') ?? '';
    const renderer = played.renderer ?? 'unknown renderer';
    report.setGpu({ renderer: `Godot ${version} ${renderer}`.replace(/\s+/g, ' '), software: SOFTWARE_RENDERER.test(renderer) });
  }
  const fail = (text, location) => report.addError({ profile, kind: 'godot', text, location });
  // The window lost focus (another window took it): Godot releases held input then, which the driver puts back.
  const lostFrames = results?.focus_lost ?? [];
  const reappliedFrames = [...new Set((results?.reapplied ?? []).map((r) => r.frame))];
  for (const lostAt of lostFrames) {
    report.addNote(`window lost focus at frame ${lostAt}; ${reappliedFrames.includes(lostAt) ? 'held input re-applied' : 'no input was held'}`);
  }
  for (const at of reappliedFrames.filter((f) => !lostFrames.includes(f))) {
    report.addNote(`Godot released held input at frame ${at}; re-applied`);
  }
  for (const problem of results?.problems ?? []) fail(problem.text);
  for (const error of played.errors) fail(error.text, error.location);
  if (played.errors.length > 0) report.addNote(`Godot's full output: ${path.join(runDir, 'godot.log')}`);
  const ran = results?.frames_run ?? framePaths.length;
  if (!results) fail(`Godot stopped (${how}) after ${framePaths.length} of ${frames} frames without finishing the run`);
  else if (ran < frames && (results.problems ?? []).length === 0) fail(`The game quit by itself at frame ${ran - 1}, before the ${frames} frames ran`);

  // Godot's movie writer records at the project's viewport size, scaling the window to it.
  if (framePaths.length > 0) {
    const { width, height } = await sharp(framePaths[0]).metadata();
    if (`${width}x${height}` !== resolution) {
      report.addNote(`Frames are ${width}x${height}, the project's viewport size: Godot's movie writer scales the ${resolution} window to it`);
    }
  }

  const checks = new Map((results?.checks ?? []).map((c) => [c.step, c]));
  const shots = [];
  for (const step of scenario.steps) {
    if (step.type === 'check') {
      const c = checks.get(step.n);
      const detail = !c
        ? `frame ${step.at} was never reached (Godot stopped at frame ${ran - 1})`
        : c.error
          ? `frame ${c.frame}: ${c.error}`
          : `frame ${c.frame}: value ${c.value}`;
      report.addCheck({ profile, step: step.n, label: step.value, passed: Boolean(c?.passed), detail });
    } else if (step.type === 'shot') {
      const frame = results?.shots?.[step.value];
      const file = frame === undefined ? null : frameFile(framesDir, frame);
      if (!file || !fs.existsSync(file)) {
        fail(`Shot "${step.value}" (step ${step.n}) has no frame: frame ${step.at} was not recorded`);
        continue;
      }
      report.addShot({ name: step.value, profile, path: file });
      shots.push({ name: step.value, path: file, label: frameLabel(step.value, frame, fps), profile });
    }
  }
  // A run always leaves a picture for the sheet: the last frame when the scenario took no shots.
  if (finalShot && shots.length === 0 && framePaths.length > 0) {
    const last = framePaths.at(-1);
    const frame = Number(FRAME_FILE.exec(path.basename(last))[1]);
    report.addShot({ name: 'final', profile, path: last });
    shots.push({ name: 'final', path: last, label: frameLabel('final', frame, fps), profile });
  }
  return { profile, shots, framePaths, fps };
}

// The movie frames in framesDir, in frame order.
export function listFrames(framesDir) {
  if (!fs.existsSync(framesDir)) return [];
  return fs
    .readdirSync(framesDir)
    .filter((f) => FRAME_FILE.test(f))
    .sort()
    .map((f) => path.join(framesDir, f));
}

// Deletes every frame except those in keep (paths). A run keeps its shots; a film keeps its sampled frames.
// A run writes up to 9000 full-size PNGs, so they go once the report and sheet have what they need.
// Returns the frames that could not be deleted (a file Windows still holds open is left for later).
export function pruneFrames(framePaths, keep) {
  const kept = new Set([...keep].map((p) => path.resolve(p)));
  const left = [];
  for (const file of framePaths) {
    if (kept.has(path.resolve(file))) continue;
    try {
      fs.rmSync(file, { force: true });
    } catch {
      left.push(file);
    }
  }
  return left;
}
