import './setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const fwd = (p) => p.split(path.sep).join('/');
const INSTALL = path.resolve(import.meta.dirname, '..', 'install.mjs');
const SKILL_SOURCE = path.resolve(import.meta.dirname, '..', 'skill', 'SKILL.md');

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eyes install '));
  return { root, target: path.join(root, 'tool dir', 'eyes'), skills: path.join(root, 'skills dir') };
}

function install(box, extra = [], env = process.env) {
  return spawnSync(
    process.execPath,
    [INSTALL, '--target', box.target, '--skills-dir', box.skills, '--skip-browsers', ...extra],
    { encoding: 'utf8', timeout: 300000, env },
  );
}

// Loads every runtime dependency the way the installed tool does, from the install folder.
function dependenciesLoad(target) {
  const code = "await import('playwright'); await import('sharp'); await import('yaml'); await import('pixelmatch');";
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: target, encoding: 'utf8' });
}

// Scratch folders and the lock the installer keeps inside the target while it works.
const leftovers = (target) => fs.readdirSync(target).filter((name) => /^\.eyes-(staging|old)-|^\.eyes-install\.lock$/.test(name));

test('installs the files, both wrappers and the skill, and a second run succeeds', () => {
  const box = sandbox();
  const first = install(box);
  assert.equal(first.status, 0, first.stderr + first.stdout);

  for (const f of ['bin/eyes.mjs', 'src/report.mjs', 'src/commands/look.mjs', 'godot/eyes_driver.gd', 'package.json', 'package-lock.json']) {
    assert.ok(fs.existsSync(path.join(box.target, f)), `missing ${f}`);
  }
  assert.ok(fs.existsSync(path.join(box.target, 'node_modules', 'playwright')), 'dependencies not installed');
  assert.equal(fs.existsSync(path.join(box.target, 'test')), false, 'tests must not be copied');

  const forward = fwd(box.target);
  const cmd = fs.readFileSync(path.join(box.target, 'eyes.cmd'), 'utf8');
  assert.match(cmd, /\r\n/);
  assert.ok(cmd.includes(`PLAYWRIGHT_BROWSERS_PATH=${box.target}\\browsers`), cmd);
  assert.ok(cmd.includes(`node "${box.target}\\bin\\eyes.mjs" %*`), cmd);

  const sh = fs.readFileSync(path.join(box.target, 'eyes'), 'utf8');
  assert.equal(sh.includes('\r'), false, 'bash wrapper must use LF');
  assert.ok(sh.startsWith('#!/usr/bin/env bash\n'));
  assert.ok(sh.includes(`export PLAYWRIGHT_BROWSERS_PATH="${forward}/browsers"`), sh);
  assert.ok(sh.includes(`exec node "${forward}/bin/eyes.mjs" "$@"`), sh);

  const skill = fs.readFileSync(path.join(box.skills, 'eyes', 'SKILL.md'), 'utf8');
  assert.ok(skill.includes(forward), 'skill should carry the install path');
  assert.equal(skill.includes('{{EYES_DIR}}'), false);

  fs.writeFileSync(path.join(box.target, 'profiles.json'), '{"4k":{"width":1,"height":1,"deviceScaleFactor":1}}\n');
  const second = install(box);
  assert.equal(second.status, 0, second.stderr + second.stdout);
  assert.ok(fs.existsSync(path.join(box.target, 'profiles.json')), 're-install must keep calibration');
  assert.deepEqual(leftovers(box.target), [], 'no staging folder, old copy or lock left behind');
});

// A stand-in npm that behaves like `npm ci` failing partway: it deletes node_modules in the folder it
// runs in, then exits with an error. Running it in a live install is exactly what broke one on 2026-10-22.
function failingNpm() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eyes failing npm '));
  const ran = path.join(dir, 'ran-in.txt');
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(dir, 'npm.cmd'), ['@echo off', `echo %CD%> "${ran}"`, 'if exist node_modules rmdir /s /q node_modules', 'exit /b 1', ''].join('\r\n'));
  } else {
    fs.writeFileSync(path.join(dir, 'npm'), ['#!/bin/sh', `pwd > "${ran}"`, 'rm -rf node_modules', 'exit 1', ''].join('\n'), { mode: 0o755 });
  }
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  return { ran, env: { ...process.env, [pathKey]: `${dir}${path.delimiter}${process.env[pathKey]}` } };
}

test('a dependency install that fails partway leaves the previous install working', () => {
  const box = sandbox();
  assert.equal(install(box).status, 0);
  const npm = failingNpm();

  const res = install(box, [], npm.env);
  assert.equal(res.status, 3, res.stderr + res.stdout);
  assert.ok(fs.existsSync(npm.ran), 'the failing npm was the one that ran');
  assert.match(res.stderr, /previous install in .* is unchanged/);

  const deps = dependenciesLoad(box.target);
  assert.equal(deps.status, 0, `old install lost its dependencies: ${deps.stderr}`);
  const help = spawnSync(process.execPath, [path.join(box.target, 'bin', 'eyes.mjs'), '--help'], { encoding: 'utf8' });
  assert.match(help.stderr, /Usage: eyes <command>/);
  assert.deepEqual(leftovers(box.target), []);
});

// Starts a process that keeps sharp (and on Windows its libvips DLL) loaded from the install, like a run in progress.
async function runInProgress(target) {
  const code = [
    "const sharp = (await import('sharp')).default;",
    "const work = async () => (await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } }).png().toBuffer()).length;",
    "console.log('ready', await work());",
    "process.stdin.on('data', async () => console.log('still works', await work()));",
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: target, stdio: ['pipe', 'pipe', 'inherit'] });
  child.stdout.setEncoding('utf8');
  const nextLine = () => new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('exit', (status) => reject(new Error(`run exited early (${status})`)));
  });
  assert.match(await nextLine(), /^ready \d+/);
  return {
    async poke() {
      child.stdin.write('\n');
      return nextLine();
    },
    stop() {
      child.kill();
      return new Promise((resolve) => (child.exitCode === null ? child.once('exit', resolve) : resolve()));
    },
  };
}

test('reinstalling while a run has the dependencies loaded succeeds, and the run keeps working', async () => {
  const box = sandbox();
  assert.equal(install(box).status, 0);
  const running = await runInProgress(box.target);
  try {
    const again = install(box);
    assert.equal(again.status, 0, again.stderr + again.stdout);
    const deps = dependenciesLoad(box.target);
    assert.equal(deps.status, 0, deps.stderr);
    assert.match(await running.poke(), /^still works \d+/);
    if (process.platform === 'win32') {
      assert.ok(leftovers(box.target).some((name) => name.startsWith('.eyes-old-')), 'the loaded DLL kept the old copy');
    }
  } finally {
    await running.stop();
  }
  // Files a run still held could not be deleted then; the next install clears them.
  const third = install(box);
  assert.equal(third.status, 0, third.stderr + third.stdout);
  assert.deepEqual(leftovers(box.target), []);
});

// Windows will not rename a folder that a process has as its current folder, so the swap fails after
// bin has already been moved, and has to put bin back.
test('a swap that fails halfway is undone and the previous install still runs', { skip: process.platform !== 'win32' && 'only Windows refuses to rename a folder in use' }, async () => {
  const box = sandbox();
  assert.equal(install(box).status, 0);
  const marker = path.join(box.target, 'bin', 'old-install.txt');
  fs.writeFileSync(marker, 'from the previous install');
  const shell = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: path.join(box.target, 'src'), stdio: 'ignore' });
  try {
    const res = install(box);
    assert.equal(res.status, 3, res.stderr + res.stdout);
    assert.match(res.stderr, /Could not move src into place .* previous install in .* is unchanged/);
  } finally {
    shell.kill();
    await new Promise((resolve) => (shell.exitCode === null ? shell.once('exit', resolve) : resolve()));
  }
  assert.ok(fs.existsSync(marker), 'bin was put back');
  assert.equal(dependenciesLoad(box.target).status, 0);
  const help = spawnSync(process.execPath, [path.join(box.target, 'bin', 'eyes.mjs'), '--help'], { encoding: 'utf8' });
  assert.match(help.stderr, /Usage: eyes <command>/);
  assert.deepEqual(leftovers(box.target), []);
});

test('a second installer refuses while one is running, and takes over a lock its dead owner left', () => {
  const box = sandbox();
  assert.equal(install(box).status, 0);
  const lock = path.join(box.target, '.eyes-install.lock');

  fs.writeFileSync(lock, String(process.pid)); // this test process is alive
  const busy = install(box);
  assert.equal(busy.status, 3, busy.stderr + busy.stdout);
  assert.match(busy.stderr, /Another Eyes install/);
  assert.equal(dependenciesLoad(box.target).status, 0);

  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  fs.writeFileSync(lock, String(dead));
  const stale = install(box);
  assert.equal(stale.status, 0, stale.stderr + stale.stdout);
  assert.equal(fs.existsSync(lock), false);
});

test('the installed wrapper runs the tool', () => {
  const box = sandbox();
  assert.equal(install(box).status, 0);
  const help = spawnSync(process.execPath, [path.join(box.target, 'bin', 'eyes.mjs'), '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 2);
  assert.match(help.stderr, /Usage: eyes <command>/);
});

test('--uninstall removes the tool and the skill', () => {
  const box = sandbox();
  assert.equal(install(box).status, 0);
  const gone = install(box, ['--uninstall']);
  assert.equal(gone.status, 0, gone.stderr + gone.stdout);
  assert.equal(fs.existsSync(box.target), false);
  assert.equal(fs.existsSync(path.join(box.skills, 'eyes')), false);
  assert.equal(install(box, ['--uninstall']).status, 0, 'uninstalling twice is fine');
});

test('--uninstall refuses a folder that is not an Eyes install', () => {
  const box = sandbox();
  fs.mkdirSync(box.target, { recursive: true });
  fs.writeFileSync(path.join(box.target, 'precious.txt'), 'keep');
  const res = install(box, ['--uninstall']);
  assert.equal(res.status, 2);
  assert.ok(fs.existsSync(path.join(box.target, 'precious.txt')));
});

test('unknown options are a usage error', () => {
  const box = sandbox();
  const res = install(box, ['--bogus']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /Usage: node install\.mjs/);
});

test('the skill source fits in 80 lines and names the install folder placeholder', () => {
  const text = fs.readFileSync(SKILL_SOURCE, 'utf8').replaceAll('\r\n', '\n'); // a Windows checkout may have CRLF
  assert.ok(text.trimEnd().split('\n').length <= 80);
  assert.match(text, /^---\nname: eyes\n/);
  assert.ok(text.includes('{{EYES_DIR}}'));
});

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const SOURCE = path.resolve(import.meta.dirname, '..');

function snapshot(dir) {
  return fs.readdirSync(dir, { recursive: true }).sort();
}

test('a non-empty folder that is not an Eyes install is refused and left untouched', () => {
  const box = sandbox();
  for (const f of ['precious.txt', 'src/app.js', 'bin/tool.exe', 'godot/game.gd']) {
    fs.mkdirSync(path.dirname(path.join(box.target, f)), { recursive: true });
    fs.writeFileSync(path.join(box.target, f), 'keep');
  }
  const before = snapshot(box.target);
  const res = install(box);
  assert.equal(res.status, 2, res.stderr + res.stdout);
  assert.match(res.stderr, /not an Eyes install/);
  assert.deepEqual(snapshot(box.target), before);
  assert.equal(fs.readFileSync(path.join(box.target, 'src', 'app.js'), 'utf8'), 'keep');
});

test('the repo root (which holds the source) is refused as a target', () => {
  const before = snapshot(path.join(REPO_ROOT, 'eyes', 'src'));
  const res = spawnSync(process.execPath, [INSTALL, '--target', REPO_ROOT, '--skills-dir', sandbox().skills, '--skip-browsers'], { encoding: 'utf8', timeout: 60000 });
  assert.equal(res.status, 2, res.stderr + res.stdout);
  assert.match(res.stderr, /contains the Eyes source/);
  assert.deepEqual(snapshot(path.join(REPO_ROOT, 'eyes', 'src')), before);
});

test('a target inside the source folder is refused and not created', () => {
  const inside = path.join(SOURCE, 'nested-install-target');
  const res = spawnSync(process.execPath, [INSTALL, '--target', inside, '--skills-dir', sandbox().skills, '--skip-browsers'], { encoding: 'utf8', timeout: 60000 });
  assert.equal(res.status, 2, res.stderr + res.stdout);
  assert.match(res.stderr, /inside the Eyes source/);
  assert.equal(fs.existsSync(inside), false);
});

test('--uninstall needs the installer\'s marker, even when the folder looks like Eyes', () => {
  const box = sandbox();
  for (const f of ['bin/eyes.mjs', 'eyes.cmd', 'notes.txt']) {
    fs.mkdirSync(path.dirname(path.join(box.target, f)), { recursive: true });
    fs.writeFileSync(path.join(box.target, f), 'x');
  }
  const res = install(box, ['--uninstall']);
  assert.equal(res.status, 2, res.stderr + res.stdout);
  assert.ok(fs.existsSync(path.join(box.target, 'notes.txt')));
});

test('an install from before the marker existed is upgraded in place and gets the marker', () => {
  const box = sandbox();
  assert.equal(install(box).status, 0);
  fs.rmSync(path.join(box.target, '.eyes-install.json'));
  const again = install(box);
  assert.equal(again.status, 0, again.stderr + again.stdout);
  assert.equal(JSON.parse(fs.readFileSync(path.join(box.target, '.eyes-install.json'), 'utf8')).tool, 'eyes');
});

test('every YAML example in the skill loads as a valid scenario', async () => {
  const { loadScenario } = await import('../src/scenario.mjs');
  const text = fs.readFileSync(SKILL_SOURCE, 'utf8').replaceAll('\r\n', '\n');
  const examples = [...text.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.ok(examples.length >= 2, 'the skill has a web and a Godot example');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eyes skill examples '));
  const kinds = [];
  for (const [i, example] of examples.entries()) {
    const file = path.join(dir, `example-${i}.yaml`);
    fs.writeFileSync(file, example);
    const scenario = await loadScenario(file);
    kinds.push(scenario.kind);
  }
  assert.deepEqual(kinds.sort(), ['godot', 'web']);
  const web = await loadScenario(path.join(dir, `example-${examples.findIndex((e) => !e.includes('kind: godot'))}.yaml`));
  assert.ok(web.mask.length > 0 && web.before && web.seed !== undefined && web.stepTimeoutMs > 0);
  assert.ok(web.steps.some((s) => s.type === 'shot' && s.value.full));
  assert.match(web.serve, /--host 127\.0\.0\.1/);
  const godot = await loadScenario(path.join(dir, `example-${examples.findIndex((e) => e.includes('kind: godot'))}.yaml`));
  assert.ok(godot.godot.exe, 'the Godot example names godot.exe');
  assert.doesNotMatch(text, /`godot\.exe` in the scenario/);
});

// Runs a copy of the installed wrapper whose last line prints the calibration path instead of
// starting the tool, so only the wrapper's own environment set-up is exercised.
function calibrationSeenBy(wrapperPath, runner, env) {
  const text = fs.readFileSync(wrapperPath, 'utf8');
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((line) => line.includes('eyes.mjs'));
  assert.ok(at > 0, text);
  const probe = runner === 'cmd' ? 'node -e "console.log(process.env.EYES_CALIBRATION)"' : 'node -e "console.log(process.env.EYES_CALIBRATION)"';
  lines[at] = probe;
  const probeFile = path.join(path.dirname(wrapperPath), runner === 'cmd' ? 'probe.cmd' : 'probe.sh');
  fs.writeFileSync(probeFile, lines.join(runner === 'cmd' ? '\r\n' : '\n'));
  const run = runner === 'cmd' ? spawnSync('cmd', ['/c', probeFile], { encoding: 'utf8', env }) : spawnSync('bash', [probeFile], { encoding: 'utf8', env });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}

test('the wrappers point calibration at <target>/profiles.json unless EYES_CALIBRATION is already set', () => {
  const box = sandbox();
  assert.equal(install(box).status, 0);
  const own = path.join(box.target, 'profiles.json');
  const clean = { ...process.env };
  delete clean.EYES_CALIBRATION;

  const cmd = fs.readFileSync(path.join(box.target, 'eyes.cmd'), 'utf8');
  assert.ok(cmd.includes(`EYES_CALIBRATION=${own}`), cmd);
  const sh = fs.readFileSync(path.join(box.target, 'eyes'), 'utf8');
  assert.ok(sh.includes(`${fwd(box.target)}/profiles.json`), sh);

  if (process.platform === 'win32') {
    assert.equal(calibrationSeenBy(path.join(box.target, 'eyes.cmd'), 'cmd', clean), own);
    assert.equal(calibrationSeenBy(path.join(box.target, 'eyes.cmd'), 'cmd', { ...clean, EYES_CALIBRATION: 'C:/somewhere/else.json' }), 'C:/somewhere/else.json');
  }
  const bash = spawnSync('bash', ['--version'], { encoding: 'utf8' });
  if (bash.status === 0) {
    assert.equal(calibrationSeenBy(path.join(box.target, 'eyes'), 'bash', clean), process.platform === 'win32' ? fwd(box.target) + '/profiles.json' : own);
    assert.equal(calibrationSeenBy(path.join(box.target, 'eyes'), 'bash', { ...clean, EYES_CALIBRATION: 'custom-calibration.json' }), 'custom-calibration.json');
  }
});
