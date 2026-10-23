// Every step, script, layout scan and film frame has a deadline, so a page that never answers
// cannot hang a run (stepTimeout: default 30 s, set per scenario or with --step-timeout).
import './setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadScenario } from '../src/scenario.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const eyes = path.join(here, '..', 'bin', 'eyes.mjs');
const APP = path.join(here, 'fixtures', 'app.html').replaceAll('\\', '/');
const BUSY = path.join(here, 'fixtures', 'busy.html').replaceAll('\\', '/');
// Far below a hang, far above a healthy run of these scenarios.
const BUDGET_MS = 90000;

let root;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'eyes-deadline-'));
});
after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function project(name, text) {
  const proj = fs.mkdtempSync(path.join(root, 'proj-'));
  const file = path.join(proj, '.eyes', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return { proj, file };
}

function eyesCli(args, proj) {
  const t0 = Date.now();
  const result = spawnSync(process.execPath, [eyes, ...args], { cwd: proj, encoding: 'utf8', timeout: BUDGET_MS });
  const took = Date.now() - t0;
  const runs = path.join(proj, '.eyes', 'runs');
  const dirs = fs.existsSync(runs) ? fs.readdirSync(runs) : [];
  const runDir = dirs.length ? path.join(runs, dirs[0]) : null;
  const reportFile = runDir && path.join(runDir, 'report.json');
  const report = reportFile && fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : null;
  return { ...result, took, runDir, report };
}

const failed = (report) => report.checks.filter((c) => !c.passed);

test('a check that never resolves fails at stepTimeout with a diagnostic shot, and the next view still runs', () => {
  const { proj, file } = project(
    'never.yaml',
    `url: "${APP}"\nviews: [laptop, desktop]\nstepTimeout: 2s\nsteps:\n  - check: "new Promise(() => {})"\n  - shot: unreached\n`,
  );
  const r = eyesCli(['run', file], proj);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.deepEqual(failed(r.report).map((c) => [c.profile, c.step]), [['laptop', 1], ['desktop', 1]]);
  for (const c of failed(r.report)) assert.match(c.detail, /did not finish within 2 s/);
  assert.ok(r.report.shots.some((s) => s.name === 'failed-step-1'), JSON.stringify(r.report.shots));
  assert.ok(!r.report.shots.some((s) => s.name === 'unreached'));
});

test('under clock: fixed a timer-based check fails at the deadline and says timers wait for advance', () => {
  const { proj, file } = project(
    'fixed.yaml',
    `url: "${APP}"\nviews: [laptop]\nclock: fixed\nstepTimeout: 2s\nsteps:\n  - check: "new Promise(r => setTimeout(() => r(true), 100))"\n`,
  );
  const r = eyesCli(['run', file], proj);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(failed(r.report)[0].detail, /did not finish within 2 s.*advance/);
});

test('an endless loop in the page fails the step at the deadline and the run still ends', () => {
  const { proj, file } = project(
    'loop.yaml',
    `url: "${APP}"\nviews: [laptop, desktop]\nstepTimeout: 2s\nsteps:\n  - check: "(() => { for (;;) {} })()"\n`,
  );
  const r = eyesCli(['run', file], proj);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.deepEqual(failed(r.report).map((c) => c.profile), ['laptop', 'desktop']);
  for (const c of failed(r.report)) assert.match(c.detail, /did not finish within 2 s/);
});

test('--step-timeout overrides the scenario', () => {
  const { proj, file } = project('cli.yaml', `url: "${APP}"\nviews: [laptop]\nstepTimeout: 5m\nsteps:\n  - check: "new Promise(() => {})"\n`);
  const r = eyesCli(['run', file, '--step-timeout', '1500'], proj);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(failed(r.report)[0].detail, /did not finish within 1\.5 s/);
});

test('a .mjs scenario that never finishes fails at its deadline', () => {
  const { proj, file } = project(
    'stuck.mjs',
    `export const config = { url: ${JSON.stringify(`file:///${APP}`)}, views: ['laptop'], stepTimeout: '2s' };\nexport default async (page, eyes) => { eyes.check('first', true); await new Promise(() => {}); };\n`,
  );
  const r = eyesCli(['run', file], proj);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const bad = failed(r.report);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].label, 'scenario script');
  assert.equal(bad[0].step, 2);
  assert.match(bad[0].detail, /did not finish within 2 s/);
});

test('a page that loops after the steps fails the layout scan at the deadline', () => {
  const { proj, file } = project('scan.yaml', `url: "${BUSY}"\nviews: [laptop]\nstepTimeout: 2s\nsteps:\n  - check: "window.__hang = true"\n`);
  const r = eyesCli(['run', file], proj);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.deepEqual(r.report.errors.map((e) => e.kind), ['timeout']);
  assert.match(r.report.errors[0].text, /layout scan did not finish within 2 s/);
});

test('eyes film: a frame that never finishes fails at the deadline', () => {
  const proj = fs.mkdtempSync(path.join(root, 'film-'));
  const r = eyesCli(['film', `file:///${BUSY}?later`, '--seconds', '1', '--views', 'laptop', '--step-timeout', '2000', '--out', proj], proj);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.deepEqual(r.report.errors.map((e) => e.kind), ['timeout']);
  assert.match(r.report.errors[0].text, /frame 10 did not finish within 2 s/);
});

test('stepTimeout accepts a duration or milliseconds and rejects anything else', async () => {
  const load = async (value) => loadScenario(project('t.yaml', `url: x.html\nstepTimeout: ${value}\nsteps:\n  - check: "1"\n`).file);
  assert.equal((await load('45s')).stepTimeoutMs, 45000);
  assert.equal((await load('1500')).stepTimeoutMs, 1500);
  assert.equal((await loadScenario(project('d.yaml', 'url: x.html\nsteps:\n  - check: "1"\n').file)).stepTimeoutMs, undefined);
  for (const bad of ['0', 'soon', '-5s']) {
    await assert.rejects(() => load(bad), (err) => err.exitCode === 2 && /stepTimeout/.test(err.message), bad);
  }
});
