import './setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveProfiles, saveCalibration, TOUCH_VIEWS } from '../src/profiles.mjs';
import { EyesError } from '../src/report.mjs';

function tempCalibrationPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eyes profiles '));
  return path.join(dir, 'nested', 'profiles.json');
}

const missing = () => path.join(os.tmpdir(), 'eyes-no-such-dir', 'profiles.json');

test('defaults are desktop and 4k with toolbar height removed', () => {
  assert.deepEqual(resolveProfiles(undefined, missing()), [
    { name: 'desktop', width: 2560, height: 1311, deviceScaleFactor: 1 },
    { name: '4k', width: 2194, height: 1105, deviceScaleFactor: 1.75 },
  ]);
});

test('laptop is 1366x639 at scale 1', () => {
  assert.deepEqual(resolveProfiles(['laptop'], missing()), [
    { name: 'laptop', width: 1366, height: 639, deviceScaleFactor: 1 },
  ]);
});

test('a calibration file overrides a built-in profile', () => {
  const file = tempCalibrationPath();
  saveCalibration({ name: '4k', width: 2194, height: 1120, deviceScaleFactor: 1.75 }, file);
  assert.deepEqual(resolveProfiles(['4k'], file), [
    { name: '4k', width: 2194, height: 1120, deviceScaleFactor: 1.75 },
  ]);
});

test('a calibration file may add a new profile', () => {
  const file = tempCalibrationPath();
  saveCalibration({ name: 'tv', width: 1920, height: 1000, deviceScaleFactor: 2 }, file);
  assert.deepEqual(resolveProfiles(['tv'], file), [
    { name: 'tv', width: 1920, height: 1000, deviceScaleFactor: 2 },
  ]);
});

test('an unknown profile name throws a usage error naming the valid ones', () => {
  assert.throws(
    () => resolveProfiles(['nope'], missing()),
    (err) => {
      assert.ok(err instanceof EyesError);
      assert.equal(err.exitCode, 2);
      assert.match(err.message, /nope/);
      assert.match(err.message, /desktop, 4k, laptop/);
      return true;
    },
  );
});

test('saveCalibration merges without dropping other entries', () => {
  const file = tempCalibrationPath();
  saveCalibration({ name: 'desktop', width: 2560, height: 1300, deviceScaleFactor: 1 }, file);
  saveCalibration({ name: '4k', width: 2194, height: 1120, deviceScaleFactor: 1.75 }, file);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(stored, {
    desktop: { width: 2560, height: 1300, deviceScaleFactor: 1 },
    '4k': { width: 2194, height: 1120, deviceScaleFactor: 1.75 },
  });
});

test('a corrupt calibration file falls back to defaults', () => {
  const file = tempCalibrationPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json');
  assert.deepEqual(resolveProfiles(['desktop'], file), [
    { name: 'desktop', width: 2560, height: 1311, deviceScaleFactor: 1 },
  ]);
});

test('saveCalibration recovers from a corrupt file', () => {
  const file = tempCalibrationPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '[1,2');
  saveCalibration({ name: 'desktop', width: 2560, height: 1300, deviceScaleFactor: 1 }, file);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    desktop: { width: 2560, height: 1300, deviceScaleFactor: 1 },
  });
});

test('malformed calibration entries are ignored', () => {
  const file = tempCalibrationPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ desktop: { width: 'wide' }, laptop: null }));
  assert.deepEqual(resolveProfiles(['desktop', 'laptop'], file), [
    { name: 'desktop', width: 2560, height: 1311, deviceScaleFactor: 1 },
    { name: 'laptop', width: 1366, height: 639, deviceScaleFactor: 1 },
  ]);
});

test('touch views are viewport sizes with no toolbar removed, touch on, scale 3 for phones and 2 for iPads', () => {
  assert.deepEqual(TOUCH_VIEWS, ['phone', 'phone-l', 'ipad-mini', 'ipad-mini-side', 'ipad-13', 'ipad-13-side']);
  assert.deepEqual(resolveProfiles(TOUCH_VIEWS, missing()), [
    { name: 'phone', width: 360, height: 780, deviceScaleFactor: 3, touch: true },
    { name: 'phone-l', width: 430, height: 932, deviceScaleFactor: 3, touch: true },
    { name: 'ipad-mini', width: 744, height: 1133, deviceScaleFactor: 2, touch: true },
    { name: 'ipad-mini-side', width: 1133, height: 744, deviceScaleFactor: 2, touch: true },
    { name: 'ipad-13', width: 1024, height: 1366, deviceScaleFactor: 2, touch: true },
    { name: 'ipad-13-side', width: 1366, height: 1024, deviceScaleFactor: 2, touch: true },
  ]);
});

test('the monitor views carry no touch flag', () => {
  for (const profile of resolveProfiles(['desktop', '4k', 'laptop'], missing())) {
    assert.equal('touch' in profile, false, profile.name);
  }
});

test('an unknown view error lists the touch views too', () => {
  assert.throws(() => resolveProfiles(['nope'], missing()), /desktop, 4k, laptop, phone, phone-l, ipad-mini, ipad-mini-side, ipad-13, ipad-13-side/);
});

test("a calibration entry may carry touch: true, and one without a flag keeps the built-in view's", () => {
  const file = tempCalibrationPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      tablet: { width: 800, height: 1280, deviceScaleFactor: 2, touch: true },
      kiosk: { width: 1080, height: 1920, deviceScaleFactor: 1, touch: false },
      phone: { width: 390, height: 844, deviceScaleFactor: 3 },
      'phone-l': { width: 430, height: 932, deviceScaleFactor: 3, touch: false },
    }),
  );
  assert.deepEqual(resolveProfiles(['tablet', 'kiosk', 'phone', 'phone-l'], file), [
    { name: 'tablet', width: 800, height: 1280, deviceScaleFactor: 2, touch: true },
    { name: 'kiosk', width: 1080, height: 1920, deviceScaleFactor: 1 },
    { name: 'phone', width: 390, height: 844, deviceScaleFactor: 3, touch: true },
    { name: 'phone-l', width: 430, height: 932, deviceScaleFactor: 3 },
  ]);
});

test('a calibration entry whose touch flag is not true or false is ignored', () => {
  const file = tempCalibrationPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ desktop: { width: 800, height: 600, deviceScaleFactor: 1, touch: 'yes' } }));
  assert.deepEqual(resolveProfiles(['desktop'], file), [
    { name: 'desktop', width: 2560, height: 1311, deviceScaleFactor: 1 },
  ]);
});

test('saveCalibration keeps a stored touch flag', () => {
  const file = tempCalibrationPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ tablet: { width: 800, height: 1280, deviceScaleFactor: 2, touch: true } }));
  saveCalibration({ name: 'tablet', width: 810, height: 1080, deviceScaleFactor: 2 }, file);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    tablet: { width: 810, height: 1080, deviceScaleFactor: 2, touch: true },
  });
});
