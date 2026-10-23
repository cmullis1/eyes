#!/usr/bin/env node
// Installs Eyes for every Claude Code session on this machine.
//   node install.mjs [--target <dir>] [--skills-dir <dir>] [--skip-browsers] [--uninstall]
// Default target is ~/.claude/tools/eyes; the skill goes to ~/.claude/skills/eyes/SKILL.md.
// Re-running is safe: code is replaced, browsers and profiles.json (calibration) are kept.
// The installer only ever replaces or removes a folder it made itself (it leaves a marker file there),
// and never a folder inside, or holding, this source checkout.
// Re-running while other sessions are mid-run is safe too: the new code and dependencies are built in a
// staging folder and only swapped in once complete, so a failure leaves the previous install working.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';

const SOURCE = import.meta.dirname;
const USAGE =
  'Usage: node install.mjs [--target <dir>] [--skills-dir <dir>] [--skip-browsers] [--uninstall]';
const COPIED_DIRS = ['bin', 'src', 'godot'];
const COPIED_FILES = ['package.json', 'package-lock.json'];
const PLACEHOLDER = '{{EYES_DIR}}';
const MARKER = '.eyes-install.json';
const LOCK = '.eyes-install.lock';
const STAGING_PREFIX = '.eyes-staging-';
const OLD_PREFIX = '.eyes-old-';
// What a reinstall replaces. Everything else in the target (browsers, profiles.json, wrappers, marker) stays.
const SWAPPED = [...COPIED_DIRS, ...COPIED_FILES, 'node_modules'];
const IS_WIN = process.platform === 'win32';
const SLEEPER = new Int32Array(new SharedArrayBuffer(4));

class UsageError extends Error {}

const forward = (p) => p.replaceAll('\\', '/');

function parse(argv) {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: {
        target: { type: 'string' },
        'skills-dir': { type: 'string' },
        'skip-browsers': { type: 'boolean' },
        uninstall: { type: 'boolean' },
      },
      allowPositionals: true,
      strict: true,
    });
    if (positionals.length > 0) throw new Error(`unexpected argument "${positionals[0]}"`);
    return values;
  } catch (err) {
    throw new UsageError(`${err.message}\n${USAGE}`);
  }
}

// The real path, following links, even for a path that does not exist yet (its nearest existing parent is resolved).
function realPath(p) {
  const abs = path.resolve(p);
  if (fs.existsSync(abs)) return fs.realpathSync.native(abs);
  const parent = path.dirname(abs);
  return parent === abs ? abs : path.join(realPath(parent), path.basename(abs));
}

// True when `inner` is `outer` or somewhere below it.
function within(inner, outer) {
  const norm = (p) => (IS_WIN ? p.toLowerCase() : p);
  const rel = path.relative(norm(outer), norm(inner));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function hasMarker(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8')).tool === 'eyes';
  } catch {
    return false;
  }
}

// An install made before the marker existed: the wrappers and package this installer writes.
function isLegacyInstall(dir) {
  try {
    return (
      fs.existsSync(path.join(dir, 'bin', 'eyes.mjs')) &&
      fs.existsSync(path.join(dir, 'eyes.cmd')) &&
      JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name === 'eyes'
    );
  } catch {
    return false;
  }
}

// Refuses a target that is, holds or sits inside this checkout, or that already holds something else.
function checkTarget(target) {
  const real = realPath(target);
  const source = realPath(SOURCE);
  if (within(real, source)) {
    throw new UsageError(`${target} is inside the Eyes source (${SOURCE}); pick a folder outside it, such as the default.`);
  }
  if (within(source, real)) {
    throw new UsageError(`${target} contains the Eyes source (${SOURCE}); installing there would overwrite it. Pick another --target.`);
  }
  if (fs.existsSync(real) && fs.readdirSync(real).length > 0 && !hasMarker(real) && !isLegacyInstall(real)) {
    throw new UsageError(`${target} is not empty and is not an Eyes install (no ${MARKER}); leaving it alone. Pick an empty or new --target.`);
  }
}

function writeMarker(target) {
  const marker = { tool: 'eyes', note: 'Written by eyes/install.mjs. Its presence lets the installer replace or remove this folder.', source: forward(SOURCE) };
  fs.writeFileSync(path.join(target, MARKER), `${JSON.stringify(marker, null, 2)}\n`);
}

function run(command, args, options) {
  // shell: true so npm.cmd / npx.cmd resolve on Windows; every argument here is a fixed word.
  const result = spawnSync(command, args, { stdio: 'inherit', shell: true, ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed${result.error ? `: ${result.error.message}` : ` (exit ${result.status})`}`);
  }
}

function wrapperCmd(target) {
  const win = path.resolve(target);
  return [
    '@echo off',
    `set "PLAYWRIGHT_BROWSERS_PATH=${path.join(win, 'browsers')}"`,
    // Calibration lives beside the tool it was installed with, unless the caller chose a file.
    `if not defined EYES_CALIBRATION set "EYES_CALIBRATION=${path.join(win, 'profiles.json')}"`,
    `node "${path.join(win, 'bin', 'eyes.mjs')}" %*`,
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
}

function wrapperBash(target) {
  const base = forward(path.resolve(target));
  return [
    '#!/usr/bin/env bash',
    `export PLAYWRIGHT_BROWSERS_PATH="${base}/browsers"`,
    `export EYES_CALIBRATION="\${EYES_CALIBRATION:-${base}/profiles.json}"`,
    `exec node "${base}/bin/eyes.mjs" "$@"`,
    '',
  ].join('\n');
}

// cmd.exe re-reads a batch file between lines, so a wrapper a run is executing is only rewritten when it changes.
function writeIfChanged(file, text) {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return;
  fs.writeFileSync(file, text);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // alive, owned by someone else
  }
}

// One installer at a time per target, so two swaps never interleave. Returns the release function.
function lock(target) {
  const file = path.join(target, LOCK);
  for (;;) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      return () => fs.rmSync(file, { force: true });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    let owner;
    try {
      owner = Number.parseInt(fs.readFileSync(file, 'utf8'), 10);
    } catch (err) {
      if (err.code === 'ENOENT') continue; // released between the two calls
      throw err;
    }
    // No pid yet means its installer has only just created the file.
    if (Number.isNaN(owner) || isAlive(owner)) {
      const who = Number.isNaN(owner) ? '' : ` (process ${owner})`;
      throw new Error(`Another Eyes install${who} is running in ${target}; wait for it to finish. If none is, delete ${file}.`);
    }
    fs.rmSync(file, { force: true }); // its installer died without releasing it
  }
}

// Removes staging folders and old copies earlier installs left. An old copy can still hold files a run
// had open (Windows will not delete a loaded DLL); those are kept until a later install.
function sweep(target) {
  for (const name of fs.readdirSync(target)) {
    if (!name.startsWith(STAGING_PREFIX) && !name.startsWith(OLD_PREFIX)) continue;
    if (!removeIfPossible(path.join(target, name))) {
      console.log(`Left ${name}: a running Eyes still has files in it open. A later install removes it.`);
    }
  }
}

// Antivirus and the search indexer briefly hold freshly written files on Windows, so a rename that fails
// with a sharing error is retried for a few seconds before it counts.
function renameRetrying(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (attempt >= 8 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
      Atomics.wait(SLEEPER, 0, 0, 100 * attempt);
    }
  }
}

// Copies the code into a new folder; a staging folder starts empty, so files deleted from the source do not linger.
function copyTool(dir) {
  for (const sub of COPIED_DIRS) fs.cpSync(path.join(SOURCE, sub), path.join(dir, sub), { recursive: true });
  for (const file of COPIED_FILES) fs.copyFileSync(path.join(SOURCE, file), path.join(dir, file));
}

// Moves the staged code and dependencies into place. Live entries are renamed aside rather than deleted:
// Windows lets a folder be renamed while a running Eyes has a DLL in it loaded, but not emptied. If any
// move fails, the moves already made are undone so the previous install keeps working.
function swapIn(target, staging) {
  const old = path.join(target, `${OLD_PREFIX}${process.pid}-${Date.now()}`);
  fs.mkdirSync(old);
  const done = [];
  try {
    for (const name of SWAPPED) {
      const step = { name, asideDone: false, placed: false };
      done.push(step);
      const live = path.join(target, name);
      if (fs.existsSync(live)) {
        renameRetrying(live, path.join(old, name));
        step.asideDone = true;
      }
      renameRetrying(path.join(staging, name), live);
      step.placed = true;
    }
  } catch (err) {
    const failed = done.at(-1).name;
    const unrestored = [];
    for (const step of [...done].reverse()) {
      const live = path.join(target, step.name);
      try {
        if (step.placed) renameRetrying(live, path.join(staging, step.name));
        if (step.asideDone) renameRetrying(path.join(old, step.name), live);
      } catch {
        unrestored.push(step.name);
      }
    }
    if (unrestored.length > 0) {
      throw new Error(`Could not move ${failed} into place (${err.code ?? err.message}), and could not put back ${unrestored.join(', ')}. Run the installer again to repair ${target}.`);
    }
    removeIfPossible(old);
    throw new Error(`Could not move ${failed} into place (${err.code ?? err.message}); the previous install in ${target} is unchanged. A shell or program may have a folder inside it open; close it and run the installer again.`);
  }
  if (!removeIfPossible(old)) console.log('A running Eyes still has some of the previous files open; a later install removes them.');
}

function removeIfPossible(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function installBrowsers(target, staging) {
  const browsers = path.join(target, 'browsers');
  const devBrowsers = path.join(SOURCE, 'browsers');
  if (fs.existsSync(devBrowsers)) {
    console.log('Copying browsers from this checkout...');
    // force: false keeps anything already installed, so a re-run does not recopy hundreds of MB.
    fs.cpSync(devBrowsers, browsers, { recursive: true, force: false, errorOnExist: false });
    return;
  }
  console.log('Downloading Chromium (this can take a few minutes)...');
  // From the staging folder, so the browser the new Playwright needs is in place before the swap.
  run('npx', ['playwright', 'install', 'chromium'], {
    cwd: staging,
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers },
  });
}

function installSkill(target, skillsDir) {
  const template = fs.readFileSync(path.join(SOURCE, 'skill', 'SKILL.md'), 'utf8');
  const destination = path.join(skillsDir, 'eyes', 'SKILL.md');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, template.replaceAll(PLACEHOLDER, forward(path.resolve(target))));
  return destination;
}

function install({ target, skillsDir, skipBrowsers }) {
  checkTarget(target);
  console.log(`Installing Eyes into ${target}`);
  fs.mkdirSync(target, { recursive: true });
  writeMarker(target); // first, so a re-run after a failed install still recognises the folder
  const release = lock(target);
  try {
    sweep(target);
    const staging = path.join(target, `${STAGING_PREFIX}${process.pid}-${Date.now()}`);
    try {
      try {
        fs.mkdirSync(staging);
        copyTool(staging);
        console.log('Installing dependencies...');
        run('npm', ['ci', '--omit=dev'], { cwd: staging });
        if (skipBrowsers) console.log('Skipping browsers (--skip-browsers).');
        else installBrowsers(target, staging);
      } catch (err) {
        throw new Error(`${err.message}\nNothing was swapped in, so any previous install in ${target} is unchanged.`);
      }
      swapIn(target, staging);
    } finally {
      removeIfPossible(staging);
    }
    writeIfChanged(path.join(target, 'eyes.cmd'), wrapperCmd(target));
    writeIfChanged(path.join(target, 'eyes'), wrapperBash(target));
  } finally {
    release();
  }
  const skill = installSkill(target, skillsDir);
  console.log(`\nInstalled.\n  Command: ${forward(path.join(target, 'eyes'))}  (PowerShell/cmd: ${path.join(target, 'eyes.cmd')})\n  Skill:   ${skill}`);
}

function uninstall({ target, skillsDir }) {
  // Only remove a folder this installer made.
  if (fs.existsSync(target)) {
    if (!hasMarker(target)) {
      throw new UsageError(`${target} has no ${MARKER}, so it is not an install this installer made; leaving it alone.`);
    }
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`Removed ${target} (including any saved calibration).`);
  }
  const skillDir = path.join(skillsDir, 'eyes');
  if (fs.existsSync(skillDir)) {
    fs.rmSync(skillDir, { recursive: true, force: true });
    console.log(`Removed ${skillDir}`);
  }
}

try {
  const values = parse(process.argv.slice(2));
  const target = path.resolve(values.target ?? path.join(os.homedir(), '.claude', 'tools', 'eyes'));
  const skillsDir = path.resolve(values['skills-dir'] ?? path.join(os.homedir(), '.claude', 'skills'));
  if (values.uninstall) uninstall({ target, skillsDir });
  else install({ target, skillsDir, skipBrowsers: values['skip-browsers'] === true });
} catch (err) {
  if (err instanceof UsageError) {
    console.error(err.message);
    process.exitCode = 2;
  } else {
    console.error(err?.message ?? String(err));
    process.exitCode = 3;
  }
}
