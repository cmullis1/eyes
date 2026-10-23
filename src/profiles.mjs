// Display profiles: the user's real monitor sizes, with measured calibration overrides.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EyesError } from './report.mjs';

// Height of a maximised Chrome's toolbar, removed from the screen height until
// `eyes calibrate` stores a measured viewport.
const TOOLBAR_HEIGHT = 129;

const SCREENS = [
  { name: 'desktop', width: 2560, height: 1440, deviceScaleFactor: 1 },
  { name: '4k', width: 2194, height: 1234, deviceScaleFactor: 1.75 },
  { name: 'laptop', width: 1366, height: 768, deviceScaleFactor: 1 },
];

// Phones and iPads: viewport sizes (no toolbar to remove), with touch and mobile emulation on,
// so pages see pointer: coarse and hover: none.
const TOUCH_SCREENS = [
  { name: 'phone', width: 360, height: 780, deviceScaleFactor: 3 },
  { name: 'phone-l', width: 430, height: 932, deviceScaleFactor: 3 },
  { name: 'ipad-mini', width: 744, height: 1133, deviceScaleFactor: 2 },
  { name: 'ipad-mini-side', width: 1133, height: 744, deviceScaleFactor: 2 },
  { name: 'ipad-13', width: 1024, height: 1366, deviceScaleFactor: 2 },
  { name: 'ipad-13-side', width: 1366, height: 1024, deviceScaleFactor: 2 },
];

export const DEFAULT_VIEWS = ['desktop', '4k'];
export const TOUCH_VIEWS = TOUCH_SCREENS.map((screen) => screen.name);

// EYES_CALIBRATION overrides the calibration file location (the test suite points it at a
// path that does not exist, so tests never see the machine's real measurements).
export function defaultCalibrationPath() {
  const override = process.env.EYES_CALIBRATION;
  if (override) return path.resolve(override);
  return path.join(os.homedir(), '.claude', 'tools', 'eyes', 'profiles.json');
}

function builtIns() {
  return [
    ...SCREENS.map((screen) => ({ ...screen, height: screen.height - TOOLBAR_HEIGHT })),
    ...TOUCH_SCREENS.map((screen) => ({ ...screen, touch: true })),
  ];
}

function isPositive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isValidEntry(entry) {
  return (
    entry !== null &&
    typeof entry === 'object' &&
    isPositive(entry.width) &&
    isPositive(entry.height) &&
    isPositive(entry.deviceScaleFactor) &&
    (entry.touch === undefined || typeof entry.touch === 'boolean')
  );
}

// The raw stored object, or {} when the file is missing, unreadable, or not a JSON object.
function readCalibration(calibrationPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(calibrationPath, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function allProfiles(calibrationPath) {
  const byName = new Map(builtIns().map((profile) => [profile.name, profile]));
  for (const [name, entry] of Object.entries(readCalibration(calibrationPath))) {
    if (isValidEntry(entry)) {
      // An entry without a touch flag keeps the built-in's: a stored size for phone is still a phone.
      const touch = entry.touch ?? byName.get(name)?.touch === true;
      byName.set(name, {
        name,
        width: entry.width,
        height: entry.height,
        deviceScaleFactor: entry.deviceScaleFactor,
        ...(touch ? { touch: true } : {}),
      });
    }
  }
  return byName;
}

export function resolveProfiles(names, calibrationPath = defaultCalibrationPath()) {
  const available = allProfiles(calibrationPath);
  return (names ?? DEFAULT_VIEWS).map((name) => {
    const profile = available.get(name);
    if (!profile) {
      throw new EyesError(
        `Unknown view "${name}". Valid views: ${[...available.keys()].join(', ')}`,
        2,
      );
    }
    return { ...profile };
  });
}

export function saveCalibration(entry, calibrationPath = defaultCalibrationPath()) {
  const stored = readCalibration(calibrationPath);
  const { touch } = stored[entry.name] ?? {};
  stored[entry.name] = {
    width: entry.width,
    height: entry.height,
    deviceScaleFactor: entry.deviceScaleFactor,
    // A hand-written touch flag survives a new measurement.
    ...(typeof touch === 'boolean' ? { touch } : {}),
  };
  fs.mkdirSync(path.dirname(calibrationPath), { recursive: true });
  fs.writeFileSync(calibrationPath, `${JSON.stringify(stored, null, 2)}\n`);
}
