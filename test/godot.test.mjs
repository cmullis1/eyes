import './setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { loadScenario } from '../src/scenario.mjs';
import { parseGodotOutput, godotArgs } from '../src/godot/runGodot.mjs';
import { acceptPending } from '../src/baseline.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const eyes = path.join(here, '..', 'bin', 'eyes.mjs');
const MINI = path.join(here, 'fixtures', 'godot-mini');
const TOPSIDE_GODOT = 'D:/Claude Projects/Game Project/Godot_v4.7.2-stable_win64.exe/Godot_v4.7.2-stable_win64_console.exe';
const GODOT = process.env.EYES_GODOT || TOPSIDE_GODOT;
const HAVE_GODOT = fs.existsSync(GODOT);
const NO_GODOT = HAVE_GODOT ? false : `Godot is not installed at ${GODOT} (set EYES_GODOT to run these tests)`;
const fwd = (p) => p.replaceAll('\\', '/');

let root;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'eyes godot-'));
});
after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// A fresh project folder with the scenario at <proj>/.eyes/<name>.
function scenarioFile(name, text) {
  const proj = fs.mkdtempSync(path.join(root, 'proj-'));
  const file = path.join(proj, '.eyes', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

// A copy of the fixture project in a folder whose name has spaces.
function spacedProject() {
  const dir = fs.mkdtempSync(path.join(root, 'game project '));
  const copy = path.join(dir, 'mini game');
  fs.cpSync(MINI, copy, { recursive: true, filter: (src) => !src.includes(`${path.sep}.godot`) });
  return copy;
}

function godotYaml({ exe = GODOT, project = MINI, scene = 'res://main.tscn', frames = 60, extra = '', steps = [] } = {}) {
  const lines = ['kind: godot', 'godot:'];
  if (exe !== null) lines.push(`  exe: "${fwd(exe)}"`);
  if (project !== null) lines.push(`  project: "${fwd(project)}"`);
  lines.push(`  scene: "${scene}"`, '  fps: 30', '  resolution: 320x180', `  frames: ${frames}`);
  if (extra) lines.push(extra);
  if (steps.length) lines.push('steps:', ...steps.map((s) => `  - ${s}`));
  return `${lines.join('\n')}\n`;
}

function eyesCli(command, file, args = [], env = {}) {
  const result = spawnSync(process.execPath, [eyes, command, file, ...args], {
    encoding: 'utf8',
    timeout: 240000,
    env: { ...process.env, ...env },
  });
  const proj = path.resolve(path.dirname(file), '..');
  const runs = path.join(proj, '.eyes', 'runs');
  const dirs = fs.existsSync(runs) ? fs.readdirSync(runs) : [];
  const runDir = dirs.length ? path.join(runs, dirs[0]) : null;
  const reportFile = runDir && path.join(runDir, 'report.json');
  const report = reportFile && fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : null;
  return { ...result, runDir, report };
}

const HOLD_RIGHT = [
  '{at: 5, press: ui_right}',
  '{at: 35, release: ui_right}',
  '{at: 10, press: Space}',
  '{at: 11, release: Space}',
  '{at: 12, mouse: {x: 200, y: 150}}',
  '{at: 40, check: "$Square.position.x > 100"}',
  '{at: 40, check: "clicks == 1 and last_click == Vector2(200, 150) and space_presses == 1 and Score.hits == 1"}',
  '{at: 40, shot: moved}',
];

// ---- scenario validation (no Godot needed) ----

test('a Godot scenario loads with its settings, defaults and steps', async () => {
  const file = scenarioFile('ok.yaml', godotYaml({ steps: HOLD_RIGHT }));
  const s = await loadScenario(file);
  assert.equal(s.kind, 'godot');
  assert.deepEqual(
    { ...s.godot, exe: fwd(s.godot.exe), project: fwd(s.godot.project) },
    { exe: fwd(GODOT), project: fwd(MINI), scene: 'res://main.tscn', fps: 30, resolution: '320x180', frames: 60 },
  );
  assert.equal(s.steps.length, 8);
  assert.deepEqual(s.steps[0], { n: 1, at: 5, type: 'press', value: 'ui_right' });
  assert.deepEqual(s.steps[4], { n: 5, at: 12, type: 'mouse', value: { x: 200, y: 150, button: 'left' } });
  assert.deepEqual(s.steps[7], { n: 8, at: 40, type: 'shot', value: 'moved' });

  const bare = await loadScenario(scenarioFile('bare.yaml', 'kind: godot\ngodot:\n  frames: 10\n'));
  assert.deepEqual(bare.godot, { exe: undefined, project: undefined, scene: undefined, fps: 30, resolution: '1920x1080', frames: 10 });
  assert.deepEqual(bare.steps, []);
});

async function rejects(text, ...patterns) {
  const file = scenarioFile('bad.yaml', text);
  await assert.rejects(loadScenario(file), (err) => {
    assert.equal(err.exitCode, 2, err.message);
    assert.ok(err.message.includes(file), err.message);
    for (const p of patterns) assert.match(err.message, p);
    return true;
  });
}

test('Godot scenarios reject bad settings and steps with exit 2, naming the file, the step and the valid keys', async () => {
  await rejects(godotYaml({ extra: '  speed: 2' }), /unknown key "speed"/, /exe, project, scene, fps, resolution, frames/);
  await rejects('kind: godot\ngodot:\n  fps: 30\n', /"godot\.frames" is required/);
  await rejects(godotYaml({ frames: 0 }), /frames/);
  await rejects(godotYaml({ scene: 'main.tscn' }), /res:\/\//);
  await rejects(godotYaml().replace('320x180', '320 by 180'), /resolution/);
  await rejects(godotYaml().replace('fps: 30', 'fps: 0'), /fps/);
  await rejects(godotYaml({ steps: ['{at: 1, press: ui_right, hold: 3}'] }), /step 1/, /unknown key "hold"/, /at, press, release, mouse, shot, check/);
  await rejects(godotYaml({ steps: ['{at: 1, click: "#a"}'] }), /step 1/, /press, release, mouse, shot, check/);
  await rejects(godotYaml({ steps: ['{press: ui_right}'] }), /step 1/, /"at"/);
  await rejects(godotYaml({ steps: ['{at: 2, shot: a}', '{at: 60, shot: b}'] }), /step 2/, /0 to 59/);
  await rejects(godotYaml({ steps: ['{at: 1.5, shot: a}'] }), /step 1/, /whole number/);
  await rejects(godotYaml({ steps: ['{at: 1, shot: a, check: "true"}'] }), /step 1/, /exactly one of/);
  await rejects(godotYaml({ steps: ['{at: 1, mouse: {x: 1, y: 2, button: thumb}}'] }), /step 1/, /left, right, middle/);
  await rejects(godotYaml({ steps: ['{at: 1, mouse: {x: 1, z: 2}}'] }), /step 1/, /unknown key "z"/, /x, y, button/);
  await rejects(godotYaml({ steps: ['{at: 1, shot: a}', '{at: 2, shot: a}'] }), /step 2/, /shot name "a" is already used/);
  await rejects(godotYaml({ extra: 'url: "x.html"' }), /"url" is only for web scenarios/);
  await rejects(godotYaml({ extra: 'views: [desktop]' }), /"views" is only for web scenarios/);
});

test('parseGodotOutput turns SCRIPT ERROR and ERROR lines into errors with their location, once each with a count', () => {
  const output = [
    'Godot Engine v4.7.2.stable.official.ed1daf0bf - https://godotengine.org',
    'OpenGL API 3.3.0 Core Profile Context 26.7.1 - Compatibility - Using Device: ATI Technologies Inc. - AMD Radeon RX 6800 XT',
    "\x1b[1;31mSCRIPT ERROR:\x1b[0m Invalid call. Nonexistent function 'explode' in base 'Nil'.",
    '   at: _process (res://broken.gd:10)',
    '   GDScript backtrace (most recent call first):',
    '       [0] _process (res://broken.gd:10)',
    "SCRIPT ERROR: Invalid call. Nonexistent function 'explode' in base 'Nil'.",
    '   at: _process (res://broken.gd:10)',
    'ERROR: Failed to load resource "res://missing.png".',
    '   at: load (core/io/resource_loader.cpp:300)',
    'WARNING: something minor',
    '   at: foo (bar.cpp:1)',
    'SHADER ERROR: Expected expression, found: \'SEMICOLON\'.',
    '          at: (null) (res://glow.gdshader:7)',
    'UNKNOWN ERROR: Something went wrong in a module.',
  ].join('\r\n');
  const parsed = parseGodotOutput(output);
  assert.equal(parsed.version, '4.7.2.stable.official.ed1daf0bf');
  assert.equal(parsed.renderer, 'Compatibility: AMD Radeon RX 6800 XT');
  assert.deepEqual(parsed.errors, [
    { text: "Invalid call. Nonexistent function 'explode' in base 'Nil'. (2 times)", location: 'res://broken.gd:10 in _process' },
    { text: 'Failed to load resource "res://missing.png".', location: 'core/io/resource_loader.cpp:300 in load' },
    { text: "Expected expression, found: 'SEMICOLON'.", location: 'res://glow.gdshader:7 in (null)' },
    { text: 'Something went wrong in a module.' },
  ]);
});

test('godotArgs runs the hidden GUI exe beside a _console wrapper, with the movie writer, off-screen and the plan', () => {
  const dir = fs.mkdtempSync(path.join(root, 'godot exe '));
  const consoleExe = path.join(dir, 'Godot_v9_console.exe');
  fs.writeFileSync(consoleExe, '');
  const plain = godotArgs({ exe: consoleExe, project: 'P', driver: 'D.gd', movie: 'M/f.png', fps: 30, resolution: '1920x1080', frames: 60, plan: 'plan.json' });
  assert.equal(plain.command, consoleExe);
  fs.writeFileSync(path.join(dir, 'Godot_v9.exe'), '');
  const { command, args } = godotArgs({ exe: consoleExe, project: 'P', driver: 'D.gd', movie: 'M/f.png', fps: 30, resolution: '1920x1080', frames: 60, plan: 'plan.json' });
  assert.equal(command, path.join(dir, 'Godot_v9.exe'));
  assert.deepEqual(args, [
    '--path', 'P', '--script', 'D.gd', '--write-movie', 'M/f.png', '--fixed-fps', '30', '--resolution', '1920x1080',
    '--position', '-32000,-32000', '--windowed', '--disable-vsync', '--quit-after', '60', '--', '--eyes-plan', 'plan.json',
  ]);
});

// ---- running Godot ----

test('the fixture holds ui_right from frame 5 to 35, clicks and presses Space, passes its checks and shoots frame 40', { skip: NO_GODOT }, async () => {
  const file = scenarioFile('mini.yaml', godotYaml({ steps: HOLD_RIGHT }));
  const r = eyesCli('run', file);
  assert.equal(r.status, 0, r.stdout + r.stderr);

  // All 60 frames ran; once the shots are mapped, only the shot's frame is kept on disk.
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.runDir, 'results.json'), 'utf8')).frames_run, 60);
  assert.deepEqual(fs.readdirSync(path.join(r.runDir, 'frames')), ['f00000040.png']);

  assert.deepEqual(r.report.profiles, ['godot 320x180']);
  assert.deepEqual(r.report.errors, []);
  assert.equal(r.report.checks.length, 2);
  assert.ok(r.report.checks.every((c) => c.passed), JSON.stringify(r.report.checks));
  assert.match(r.report.checks[0].detail, /frame 40/);
  const moved = r.report.shots.find((s) => s.name === 'moved');
  assert.equal(moved.path, path.join(r.runDir, 'frames', 'f00000040.png'));

  const meta = await sharp(moved.path).metadata();
  assert.deepEqual([meta.width, meta.height], [320, 180]);
  assert.ok(fs.existsSync(r.report.sheet));
  const lines = r.stdout.trim().split('\n');
  assert.ok(lines.length < 40);
  assert.match(lines[0], /^PASS mini \(godot 320x180\)/);
  assert.match(lines[1], /^GPU: Godot 4\.7/);
  assert.equal(lines.at(-1), `Read: ${r.report.sheet}`);
});

test('two runs of the fixture produce the same frame 40', { skip: NO_GODOT }, async () => {
  const steps = [...HOLD_RIGHT, '{at: 0, shot: start}'];
  const one = eyesCli('run', scenarioFile('det.yaml', godotYaml({ steps })));
  const two = eyesCli('run', scenarioFile('det.yaml', godotYaml({ steps })));
  assert.equal(one.status, 0, one.stdout + one.stderr);
  assert.equal(two.status, 0, two.stdout + two.stderr);
  const pixels = (r) => sharp(path.join(r.runDir, 'frames', 'f00000040.png')).raw().toBuffer();
  const [a, b] = await Promise.all([pixels(one), pixels(two)]);
  assert.ok(a.equals(b), 'frame 40 differs between two runs');
  // And the square really moved: frame 40 differs from frame 0.
  const first = await sharp(path.join(one.runDir, 'frames', 'f00000000.png')).raw().toBuffer();
  assert.ok(!first.equals(a));
});

test('a project path with spaces works', { skip: NO_GODOT }, () => {
  const project = spacedProject();
  const r = eyesCli('run', scenarioFile('spaces.yaml', godotYaml({ project, frames: 45, steps: HOLD_RIGHT })));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.report.checks.every((c) => c.passed));
});

test('a failing check is exit 1 with the frame and value', { skip: NO_GODOT }, () => {
  const r = eyesCli('run', scenarioFile('fail.yaml', godotYaml({ frames: 20, steps: ['{at: 15, check: "$Square.position.x > 100"}'] })));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /check failed \[godot 320x180\] step 1 \$Square\.position\.x > 100: frame 15: value false/);
  assert.equal(r.report.checks[0].passed, false);
});

test('a check that cannot run fails with the reason', { skip: NO_GODOT }, () => {
  const r = eyesCli('run', scenarioFile('err.yaml', godotYaml({ frames: 10, steps: ['{at: 3, check: "$Nope.position.x > 1"}'] })));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(r.report.checks[0].passed, false);
  assert.match(r.report.checks[0].detail, /frame 3: .+/);
});

test('a scene with a script error reports an error of kind godot with its location, exit 1', { skip: NO_GODOT }, () => {
  const r = eyesCli('run', scenarioFile('broken.yaml', godotYaml({ scene: 'res://broken.tscn', frames: 10 })));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const error = r.report.errors.find((e) => e.kind === 'godot');
  assert.ok(error, JSON.stringify(r.report.errors));
  assert.match(error.text, /explode/);
  assert.equal(error.location, 'res://broken.gd:10 in _process');
  assert.equal(error.profile, 'godot 320x180');
  assert.match(r.stdout, /error \[godot 320x180\] godot: .*explode/);
  assert.ok(fs.existsSync(r.report.sheet));
});

test('an input name that is neither an action nor a key is exit 2 naming the step', { skip: NO_GODOT }, () => {
  const r = eyesCli('run', scenarioFile('key.yaml', godotYaml({ frames: 10, steps: ['{at: 1, press: ui_right}', '{at: 2, press: jmup}'] })));
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /step 2/);
  assert.match(r.stderr, /"jmup" is neither an input action/);
});

test('a scene that does not exist is exit 2', () => {
  const r = eyesCli('run', scenarioFile('noscene.yaml', godotYaml({ scene: 'res://nope.tscn', frames: 10 })));
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /nope\.tscn/);
});

test('a project folder without project.godot is exit 2', () => {
  const r = eyesCli('run', scenarioFile('noproj.yaml', godotYaml({ project: root, frames: 10 })));
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /project\.godot/);
});

test('a missing Godot exe is exit 3', () => {
  const r = eyesCli('run', scenarioFile('noexe.yaml', godotYaml({ exe: path.join(root, 'no godot here.exe'), frames: 10 })));
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stderr, /Godot was not found/);
  assert.match(r.stderr, /no godot here\.exe/);
});

test('no exe in the scenario and no EYES_GODOT is exit 2 saying how to set one', () => {
  const r = eyesCli('run', scenarioFile('unset.yaml', godotYaml({ exe: null, frames: 10 })), [], { EYES_GODOT: '' });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /EYES_GODOT/);
});

test('EYES_GODOT is used when the scenario has no exe', { skip: NO_GODOT }, () => {
  const r = eyesCli('run', scenarioFile('env.yaml', godotYaml({ exe: null, frames: 5 })), [], { EYES_GODOT: GODOT });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

// Processes alive with this PID, or whose parent was this PID (children keep their parent's PID after it dies).
function processTree(pid) {
  const ps = `@(Get-CimInstance Win32_Process -Filter "ProcessId=${pid} OR ParentProcessId=${pid}").Count`;
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 60000 });
  return Number(r.stdout.trim());
}

test('Godot that does not finish in time is killed with its whole tree, mid-run: exit 3 without crashing', { skip: NO_GODOT }, () => {
  // Long enough to still be writing frames (and output) when the timeout hits.
  const r = eyesCli('run', scenarioFile('slow.yaml', godotYaml({ frames: 6000 })), ['--timeout', '2500']);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stderr, /did not finish within/);
  assert.doesNotMatch(r.stderr, /ERR_STREAM|at .*\.mjs:\d+/);
  const pid = Number(/Godot \(pid (\d+)\)/.exec(r.stderr)?.[1]);
  assert.ok(pid > 0, r.stderr);
  if (process.platform === 'win32') assert.equal(processTree(pid), 0, `Godot pid ${pid} or a child is still running`);
});

test('a run keeps its user data (user://) in the run folder, not the real app data', { skip: NO_GODOT }, () => {
  const realProbe = path.join(process.env.APPDATA ?? os.homedir(), 'Godot', 'app_userdata', 'eyes-godot-mini', 'probe.txt');
  const stamp = () => (fs.existsSync(realProbe) ? fs.statSync(realProbe).mtimeMs : null);
  const before = stamp();
  const r = eyesCli('run', scenarioFile('probe.yaml', godotYaml({ scene: 'res://probe.tscn', frames: 3 })));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const probe = path.join(r.runDir, 'appdata', 'Godot', 'app_userdata', 'eyes-godot-mini', 'probe.txt');
  assert.equal(fs.readFileSync(probe, 'utf8'), 'eyes probe');
  assert.equal(stamp(), before, 'the real app_userdata was written to');
});

test('a Godot scenario has at most 9000 frames', async () => {
  await rejects(godotYaml({ frames: 9001 }), /"godot\.frames" must be a whole number from 1 to 9000/);
});

test('two shots on the same frame are refused (they would share one frame file)', async () => {
  await rejects(godotYaml({ steps: ['{at: 4, shot: a}', '{at: 4, shot: b}'] }), /step 2/, /frame 4 already has the shot "a"/);
});

test('eyes diff compares Godot shots with baselines: new, then accepted, then changed with a side-by-side', { skip: NO_GODOT }, () => {
  const project = spacedProject();
  const file = scenarioFile('looks.yaml', godotYaml({ project, frames: 45, steps: HOLD_RIGHT }));
  const proj = path.resolve(path.dirname(file), '..');

  const first = eyesCli('diff', file, ['--update']);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /diff \[godot 320x180\] moved: new \(no baseline\)/);
  const accepted = acceptPending(proj, 'looks');
  assert.deepEqual(accepted.map((a) => a.file), ['moved@godot-320x180.png']);

  // Same game: same picture.
  fs.rmSync(path.join(proj, '.eyes', 'runs'), { recursive: true });
  const same = eyesCli('diff', file);
  assert.equal(same.status, 0, same.stdout + same.stderr);
  assert.equal(same.report.diffs[0].status, 'same');

  // The square turns blue: changed, with a side-by-side on the sheet.
  const scene = path.join(project, 'main.tscn');
  fs.writeFileSync(scene, fs.readFileSync(scene, 'utf8').replace('color = Color(1, 0.55, 0.1, 1)', 'color = Color(0.1, 0.4, 1, 1)'));
  fs.rmSync(path.join(proj, '.eyes', 'runs'), { recursive: true });
  const changed = eyesCli('diff', file);
  assert.equal(changed.status, 1, changed.stdout + changed.stderr);
  const diff = changed.report.diffs[0];
  assert.equal(diff.status, 'changed');
  assert.equal(diff.profile, 'godot 320x180');
  assert.ok(fs.existsSync(diff.sideBySide));
  assert.match(changed.stdout, /diff \[godot 320x180\] moved: changed/);
});

test('eyes film on a Godot scenario makes a GIF, a sheet of sampled frames and a flicker score', { skip: NO_GODOT }, async () => {
  const r = eyesCli('film', scenarioFile('film.yaml', godotYaml({ frames: 24, steps: ['{at: 2, press: ui_right}'] })));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const gif = r.report.shots.find((s) => s.name === 'gif');
  assert.ok(gif && fs.existsSync(gif.path), JSON.stringify(r.report.shots));
  const meta = await sharp(gif.path).metadata();
  assert.equal(meta.pages, 24);
  // Once the GIF, the score and the sheet are made, only the sampled frames (every 2nd of 24) are kept.
  const kept = fs.readdirSync(path.join(r.runDir, 'frames'));
  assert.deepEqual(kept, [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22].map((n) => `f${String(n).padStart(8, '0')}.png`));
  assert.ok(r.report.notes.some((n) => /^flicker 0\.00\d \(steady\)/.test(n)), JSON.stringify(r.report.notes));
  assert.ok(r.report.checks.some((c) => c.label === 'flicker' && c.passed));
  assert.ok(fs.existsSync(r.report.sheet));
  assert.match(r.stdout.trim().split('\n')[0], /^PASS film-film \(godot 320x180\)/);
});

test('eyes film rejects web-only flags for a Godot scenario', () => {
  const r = eyesCli('film', scenarioFile('flags.yaml', godotYaml({ frames: 5 })), ['--seconds', '2']);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /godot\.frames/);
});

// ---- focus loss while input is held ----

const HOLD_AND_READ_X = ['{at: 5, press: ui_right}', '{at: 35, release: ui_right}', '{at: 40, check: "$Square.position.x"}'];

function squareX(run) {
  const check = run.report.checks.find((c) => c.label === '$Square.position.x');
  assert.ok(check, JSON.stringify(run.report.checks));
  return check.detail;
}

test('losing window focus mid-hold does not shorten the hold: same final position, and the report says so', { skip: NO_GODOT }, () => {
  const steady = eyesCli('run', scenarioFile('steady.yaml', godotYaml({ frames: 45, steps: HOLD_AND_READ_X })));
  assert.equal(steady.status, 0, steady.stdout + steady.stderr);
  // (No assertion on the steady run's notes: another window can really take focus while the suite runs,
  // and then the report rightly says so. Its position is the reference either way.)

  const jolted = eyesCli('run', scenarioFile('jolted.yaml', godotYaml({ frames: 45, steps: HOLD_AND_READ_X })), [], { EYES_TEST_FOCUS_LOSS_AT: '20' });
  assert.equal(jolted.status, 0, jolted.stdout + jolted.stderr);
  assert.equal(squareX(jolted), squareX(steady));
  assert.ok(
    jolted.report.notes.includes('window lost focus at frame 20; held input re-applied'),
    JSON.stringify(jolted.report.notes),
  );
});

test('a focus loss while nothing is held is noted, and nothing is re-applied', { skip: NO_GODOT }, () => {
  const run = eyesCli('run', scenarioFile('idle.yaml', godotYaml({ frames: 45, steps: HOLD_AND_READ_X })), [], { EYES_TEST_FOCUS_LOSS_AT: '38' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.ok(run.report.notes.includes('window lost focus at frame 38; no input was held'), JSON.stringify(run.report.notes));
});

test('a held key and a held action are each pressed once; the driver never re-presses what is still down', { skip: NO_GODOT }, () => {
  const steps = ['{at: 5, press: Space}', '{at: 5, press: ui_right}', '{at: 30, check: "space_presses == 1 and action_events == 1"}', '{at: 35, release: Space}', '{at: 35, release: ui_right}'];
  const run = eyesCli('run', scenarioFile('held.yaml', godotYaml({ frames: 40, steps })));
  assert.equal(run.status, 0, run.stdout + run.stderr);
  // A real focus loss during the hold (another window taking focus) legitimately re-presses; only then is the count allowed to differ.
  const lostWhileHeld = run.report.notes.some((n) => /re-applied/.test(n));
  if (lostWhileHeld) return;
  assert.ok(run.report.checks.every((c) => c.passed), JSON.stringify(run.report.checks));
});
