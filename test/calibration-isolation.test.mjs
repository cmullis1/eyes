import './setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { defaultCalibrationPath } from '../src/profiles.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const eyes = path.join(here, '..', 'bin', 'eyes.mjs');
const okPage = path.join(here, 'fixtures', 'ok.html');
const realPath = path.join(os.homedir(), '.claude', 'tools', 'eyes', 'profiles.json');

let root;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'eyes-calibration-'));
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// Runs `eyes look ok.html --views 4k` and returns the size of the 4k screenshot.
async function lookAt4k(env) {
  const projectRoot = fs.mkdtempSync(path.join(root, 'proj-'));
  const result = spawnSync(process.execPath, [eyes, 'look', okPage, '--views', '4k', '--out', projectRoot], {
    encoding: 'utf8',
    timeout: 180000,
    env: { ...process.env, ...env },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const runs = path.join(projectRoot, '.eyes', 'runs');
  const runDir = path.join(runs, fs.readdirSync(runs)[0]);
  const report = JSON.parse(fs.readFileSync(path.join(runDir, 'report.json'), 'utf8'));
  const { width, height } = await sharp(report.shots[0].path).metadata();
  return { width, height };
}

function near(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) <= 1, `${label}: ${actual} not within 1 of ${expected}`);
}

test('the test run points the calibration path away from the real file', () => {
  const configured = process.env.EYES_CALIBRATION;
  assert.ok(configured, 'EYES_CALIBRATION must be set by test/setup.mjs (run the suite with npm test)');
  assert.notEqual(path.resolve(configured), path.resolve(realPath));
  assert.equal(path.resolve(defaultCalibrationPath()), path.resolve(configured));
  assert.equal(fs.existsSync(configured), false, 'the suite default must be "no calibration"');
});

test('without calibration the 4k view has the built-in size', async () => {
  const { width, height } = await lookAt4k({});
  near(width, 3840, '4k width');
  near(height, 1934, '4k height');
});

test('EYES_CALIBRATION makes a CLI run follow the calibration file', async () => {
  const file = path.join(root, 'calibration', 'profiles.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ '4k': { width: 1000, height: 600, deviceScaleFactor: 2 } }));

  const { width, height } = await lookAt4k({ EYES_CALIBRATION: file });
  near(width, 2000, 'calibrated width');
  near(height, 1200, 'calibrated height');
});

test('an empty EYES_CALIBRATION falls back to the real location', () => {
  const saved = process.env.EYES_CALIBRATION;
  try {
    process.env.EYES_CALIBRATION = '';
    assert.equal(path.resolve(defaultCalibrationPath()), path.resolve(realPath));
  } finally {
    process.env.EYES_CALIBRATION = saved;
  }
});

test('every test file imports setup.mjs first, so plain `node --test <file>` is isolated too', () => {
  const files = fs.readdirSync(here).filter((name) => name.endsWith('.test.mjs'));
  assert.ok(files.length > 10);
  for (const name of files) {
    const text = fs.readFileSync(path.join(here, name), 'utf8');
    const firstImport = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line.startsWith('import '));
    assert.equal(firstImport, "import './setup.mjs';", `${name} must start its imports with setup.mjs`);
  }
});
