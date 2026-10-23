import './setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const eyes = path.join(here, '..', 'bin', 'eyes.mjs');
const fixtures = path.join(here, 'fixtures');

let root;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'eyes-look-'));
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// Runs `eyes look` against its own temp project root and reads back the run folder.
function look(args, { cwd } = {}) {
  const projectRoot = fs.mkdtempSync(path.join(root, 'proj-'));
  const result = spawnSync(process.execPath, [eyes, 'look', ...args, '--out', projectRoot], {
    cwd,
    encoding: 'utf8',
    timeout: 180000,
  });
  const runs = path.join(projectRoot, '.eyes', 'runs');
  const dirs = fs.existsSync(runs) ? fs.readdirSync(runs) : [];
  const runDir = dirs.length ? path.join(runs, dirs[0]) : null;
  const reportFile = runDir && path.join(runDir, 'report.json');
  const report = reportFile && fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : null;
  return { ...result, projectRoot, runDir, report, dirs };
}

async function size(file) {
  const { width, height } = await sharp(file).metadata();
  return { width, height };
}

function near(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) <= 1, `${label}: ${actual} not within 1 of ${expected}`);
}

test('ok.html passes with a desktop shot and a 4k shot at the right pixel sizes', async () => {
  const r = look([path.join(fixtures, 'ok.html')]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.report.passed, true);
  assert.deepEqual(r.report.shots.map((s) => s.profile), ['desktop', '4k']);

  const [desktop, fourK] = r.report.shots;
  const d = await size(desktop.path);
  assert.deepEqual(d, { width: 2560, height: 1311 });
  const k = await size(fourK.path);
  near(k.width, 3840, '4k width');
  near(k.height, 1934, '4k height');

  assert.ok(r.report.sheet && fs.existsSync(r.report.sheet));
  assert.ok(path.resolve(r.report.sheet).startsWith(path.resolve(r.runDir)));
  assert.ok((await size(r.report.sheet)).width <= 2400);

  const lines = r.stdout.trim().split('\n');
  assert.equal(lines[0], 'PASS ok (desktop, 4k)');
  assert.match(lines[1], /^GPU: /);
  assert.equal(lines.at(-1), `Read: ${r.report.sheet}`);
});

test('the run folder is named after the page unless --name is given', () => {
  const a = look([path.join(fixtures, 'ok.html'), '--views', 'desktop']);
  assert.equal(a.status, 0, a.stdout + a.stderr);
  assert.match(a.dirs[0], /^\d{8}-\d{6}-ok$/);
  assert.equal(a.report.name, 'ok');

  const b = look([path.join(fixtures, 'ok.html'), '--views', 'desktop', '--name', 'landing']);
  assert.equal(b.status, 0, b.stdout + b.stderr);
  assert.match(b.dirs[0], /^\d{8}-\d{6}-landing$/);
  assert.equal(b.report.name, 'landing');
});

test('--out defaults to the current working directory', () => {
  const cwd = fs.mkdtempSync(path.join(root, 'cwd-'));
  const result = spawnSync(
    process.execPath,
    [eyes, 'look', path.join(fixtures, 'ok.html'), '--views', 'desktop'],
    { cwd, encoding: 'utf8', timeout: 180000 },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readdirSync(path.join(cwd, '.eyes', 'runs')).length, 1);
});

test('overflow.html: 4k shows one problem of each kind, desktop only the covered button', () => {
  const r = look([path.join(fixtures, 'overflow.html')]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(r.report.passed, false);

  const at = (profile) => r.report.layout.filter((l) => l.profile === profile);
  const desktop = at('desktop');
  assert.deepEqual(desktop.map((l) => [l.kind, l.selector]), [['offscreen', '#covered']]);

  const fourK = at('4k');
  assert.deepEqual(fourK.map((l) => l.kind).sort(), ['hscroll', 'offscreen', 'textOverflow']);
  const byKind = Object.fromEntries(fourK.map((l) => [l.kind, l]));
  assert.equal(byKind.hscroll.detail, 'page 2300px wide in a 2194px window');
  assert.equal(byKind.offscreen.selector, '#covered');
  assert.match(byKind.offscreen.detail, /covered/i);
  assert.equal(byKind.textOverflow.selector, '#label');

  const lines = r.stdout.trim().split('\n');
  assert.match(lines[0], /^FAIL overflow \(desktop, 4k\)$/);
  assert.ok(lines.some((l) => /^layout \[4k\] hscroll /.test(l)));
  assert.equal(lines.at(-1), `Read: ${r.report.sheet}`);
});

test('tall.html is captured viewport-only by default and full-page with --full', async () => {
  const normal = look([path.join(fixtures, 'tall.html'), '--views', 'desktop']);
  assert.equal(normal.status, 0, normal.stdout + normal.stderr);
  assert.deepEqual(await size(normal.report.shots[0].path), { width: 2560, height: 1311 });

  const full = look([path.join(fixtures, 'tall.html'), '--views', 'desktop,4k', '--full']);
  assert.equal(full.status, 0, full.stdout + full.stderr);
  const [desktop, fourK] = full.report.shots;
  assert.deepEqual(await size(desktop.path), { width: 2560, height: 4000 });
  near((await size(fourK.path)).height, 7000, '4k full-page height');
  assert.ok((await size(full.report.sheet)).width <= 2400);
});

test('a file path containing spaces works', () => {
  const dir = path.join(fs.mkdtempSync(path.join(root, 'sp-')), 'my pages');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'ok page.html');
  fs.copyFileSync(path.join(fixtures, 'ok.html'), file);
  const r = look([file, '--views', 'desktop']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.report.shots.length, 1);
  assert.ok(fs.existsSync(r.report.shots[0].path));
  assert.equal(r.report.name, 'ok-page');
});

test('--wait on a selector that never appears records a timeout error, still shoots, and continues', () => {
  const r = look([path.join(fixtures, 'never.html'), '--wait', '#never', '--timeout', '1500']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const timeouts = r.report.errors.filter((e) => e.kind === 'timeout');
  assert.deepEqual(timeouts.map((e) => e.profile), ['desktop', '4k']);
  assert.match(timeouts[0].text, /#never/);
  assert.equal(r.report.shots.length, 2);
  for (const s of r.report.shots) assert.ok(fs.existsSync(s.path));
});

test('a --wait selector that is present passes', () => {
  const r = look([path.join(fixtures, 'ok.html'), '--wait', '#late', '--views', 'desktop']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('bad usage exits 2 without launching a run', () => {
  const unknownView = look([path.join(fixtures, 'ok.html'), '--views', 'nope']);
  assert.equal(unknownView.status, 2);
  assert.match(unknownView.stderr, /Unknown view "nope"/);
  assert.equal(unknownView.runDir, null);

  const noTarget = look([]);
  assert.equal(noTarget.status, 2);
  assert.match(noTarget.stderr, /look/);

  const badFlag = look([path.join(fixtures, 'ok.html'), '--bogus']);
  assert.equal(badFlag.status, 2);

  const missing = look([path.join(fixtures, 'does-not-exist.html')]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /not found/i);
  assert.equal(missing.runDir, null);
});

test('look and film run from a subfolder put their runs in the nearest .eyes project', () => {
  const proj = fs.mkdtempSync(path.join(root, 'nested-'));
  fs.mkdirSync(path.join(proj, '.eyes'));
  const sub = path.join(proj, 'site', 'pages');
  fs.mkdirSync(sub, { recursive: true });
  const page = path.join(fixtures, 'ok.html');
  const lookRun = spawnSync(process.execPath, [eyes, 'look', page, '--views', 'laptop'], { cwd: sub, encoding: 'utf8', timeout: 180000 });
  assert.equal(lookRun.status, 0, lookRun.stdout + lookRun.stderr);
  const filmRun = spawnSync(process.execPath, [eyes, 'film', page, '--views', 'laptop', '--seconds', '0.2', '--fps', '10'], { cwd: sub, encoding: 'utf8', timeout: 180000 });
  assert.equal(filmRun.status, 0, filmRun.stdout + filmRun.stderr);
  assert.equal(fs.existsSync(path.join(sub, '.eyes')), false, 'no stray .eyes folder in the subfolder');
  const runs = fs.readdirSync(path.join(proj, '.eyes', 'runs'));
  assert.ok(runs.some((d) => d.endsWith('-ok')), runs.join(', '));
  assert.ok(runs.some((d) => d.endsWith('-ok-film')), runs.join(', '));
});
