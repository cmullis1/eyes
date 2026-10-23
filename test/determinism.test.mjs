// clock: fixed also makes Math.random repeatable: a seeded generator (scenario seed:, else the
// page's window.__eyes.seed, else a fixed default), so the same scenario gives the same pictures.
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
const RANDOM = `file:///${path.join(here, 'fixtures', 'random.html').replaceAll('\\', '/')}`;

let root;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'eyes-determinism-'));
});
after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function scenarioFile(text) {
  const proj = fs.mkdtempSync(path.join(root, 'proj-'));
  const file = path.join(proj, '.eyes', 'random.yaml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

// Runs the scenario; returns the report, and the bytes of its `dots` shot.
function play(text) {
  const file = scenarioFile(text);
  const r = spawnSync(process.execPath, [eyes, 'run', file], { encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const runs = path.join(path.dirname(file), 'runs');
  const runDir = path.join(runs, fs.readdirSync(runs)[0]);
  const report = JSON.parse(fs.readFileSync(path.join(runDir, 'report.json'), 'utf8'));
  const shot = report.shots.find((s) => s.name === 'dots');
  return { report, png: fs.readFileSync(shot.path), first: JSON.parse(report.checks[0].detail) };
}

const scenario = (url, extra = '') => `url: "${url}"\nviews: [laptop]\nclock: fixed\n${extra}steps:\n  - check: "window.firstRandom"\n  - shot: dots\n`;

test('with clock: fixed a page drawing random dots gives byte-identical shots run after run', () => {
  const a = play(scenario(RANDOM));
  const b = play(scenario(RANDOM));
  assert.equal(a.first, b.first);
  assert.ok(a.png.equals(b.png), 'the two shots differ');
});

test('the page\'s window.__eyes.seed is honoured, and a scenario seed: overrides it', () => {
  const page42 = play(scenario(`${RANDOM}?seed=42`));
  const page7 = play(scenario(`${RANDOM}?seed=7`));
  const default_ = play(scenario(RANDOM));
  assert.notEqual(page42.first, page7.first);
  assert.notEqual(page42.first, default_.first);
  const forced = play(scenario(`${RANDOM}?seed=42`, 'seed: 7\n'));
  assert.equal(forced.first, page7.first);
  assert.ok(forced.png.equals(page7.png));
});

test('seed: must be a whole number and needs clock: fixed', async () => {
  await assert.rejects(() => loadScenario(scenarioFile('url: x.html\nseed: 7\nsteps:\n  - check: "1"\n')), (e) => e.exitCode === 2 && /seed.*clock: fixed/.test(e.message));
  await assert.rejects(() => loadScenario(scenarioFile('url: x.html\nclock: fixed\nseed: lots\nsteps:\n  - check: "1"\n')), (e) => e.exitCode === 2 && /"seed"/.test(e.message));
  assert.equal((await loadScenario(scenarioFile('url: x.html\nclock: fixed\nseed: 7\nsteps:\n  - check: "1"\n'))).seed, 7);
});
