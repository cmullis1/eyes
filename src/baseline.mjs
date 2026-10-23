// Baselines: approved reference images, and the comparison of each run's shots against them.
//
//   <project>/.eyes/baselines/<scenario>/<shot>@<profile>.png          accepted, committed
//   <project>/.eyes/baselines/.pending/<scenario>/<shot>@<profile>.png  proposed, waiting for a person
//
// Claude may propose pending images (`eyes diff --update`). Only `eyes accept`, run by a person,
// moves them into place.

import fs from 'node:fs';
import path from 'node:path';
import pixelmatch from 'pixelmatch';
import sharp from 'sharp';
import { readRgba, sideBySide } from './images.mjs';
import { slug } from './web/capture.mjs';

const DEFAULT_THRESHOLD = 0.1;
const DEFAULT_MAX_RATIO = 0.002;
const MASK_COLOR = [255, 0, 255, 255];
const PENDING_DIR = '.pending';

const stemOf = (file) => path.basename(file, path.extname(file));

// Paints each box (device pixels) the same flat colour, so it cannot differ between two images.
function paintMasks({ data, width, height }, boxes) {
  for (const box of boxes) {
    const left = Math.max(0, Math.floor(box.x));
    const top = Math.max(0, Math.floor(box.y));
    const right = Math.min(width, Math.ceil(box.x + box.width));
    const bottom = Math.min(height, Math.ceil(box.y + box.height));
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) data.set(MASK_COLOR, (y * width + x) * 4);
    }
  }
}

// Both images on a transparent canvas big enough for either, so a size change can still be drawn.
function padTo(image, width, height) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < image.height; y++) {
    image.data.copy(data, y * width * 4, y * image.width * 4, (y + 1) * image.width * 4);
  }
  return { data, width, height };
}

async function writeRaw({ data, width, height }, file) {
  await sharp(data, { raw: { width, height, channels: 4 } }).png().toFile(file);
}

// Compares two images with pixelmatch. `ratio` is the share of differing pixels. More than
// `maxRatio` of them is `changed`, and then diffPath is a before | after | difference image written
// next to currentPath (with the raw difference as <name>.delta.png). Different sizes are `changed`
// with ratio 1. maskBoxes ({x, y, width, height} in device pixels) are painted identical in both
// images first.
export async function compare(
  baselinePath,
  currentPath,
  { threshold = DEFAULT_THRESHOLD, maxRatio = DEFAULT_MAX_RATIO, maskBoxes = [] } = {},
) {
  const before = await readRgba(baselinePath);
  const after = await readRgba(currentPath);
  const sameSize = before.width === after.width && before.height === after.height;

  const width = Math.max(before.width, after.width);
  const height = Math.max(before.height, after.height);
  const a = sameSize ? before : padTo(before, width, height);
  const b = sameSize ? after : padTo(after, width, height);
  paintMasks(a, maskBoxes);
  paintMasks(b, maskBoxes);

  const delta = Buffer.alloc(width * height * 4);
  const differing = pixelmatch(a.data, b.data, delta, width, height, { threshold });
  const ratio = sameSize ? differing / (width * height) : 1;
  if (sameSize && ratio <= maxRatio) return { ratio, status: 'same' };

  const stem = path.join(path.dirname(currentPath), stemOf(currentPath));
  const deltaPath = `${stem}.delta.png`;
  const diffPath = `${stem}.changed.png`;
  await writeRaw({ data: delta, width, height }, deltaPath);
  await sideBySide(baselinePath, currentPath, deltaPath, diffPath);
  return { ratio, status: 'changed', diffPath };
}

export function baselinesDir(projectRoot) {
  return path.join(projectRoot, '.eyes', 'baselines');
}

export function pendingDir(projectRoot, scenario) {
  return path.join(baselinesDir(projectRoot), PENDING_DIR, scenario);
}

// The images waiting for a person: [{file, baseline, pending}] sorted by file name.
export function listPending(projectRoot, scenario) {
  const dir = pendingDir(projectRoot, scenario);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => file.toLowerCase().endsWith('.png'))
    .sort()
    .map((file) => ({
      file,
      pending: path.join(dir, file),
      baseline: path.join(baselinesDir(projectRoot), scenario, file),
    }));
}

// Moves every pending image of the scenario into place, replacing the accepted one. Returns the list moved.
export function acceptPending(projectRoot, scenario) {
  const items = listPending(projectRoot, scenario);
  for (const item of items) {
    fs.mkdirSync(path.dirname(item.baseline), { recursive: true });
    fs.copyFileSync(item.pending, item.baseline);
    fs.rmSync(item.pending);
  }
  const dir = pendingDir(projectRoot, scenario);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  return items;
}

// Compares every real shot of a run with its baseline and records the outcome in the report.
// Without `update`, nothing is written. With it, `new` and `changed` shots are proposed under
// .pending, and a pending image whose shot now matches is withdrawn. Never touches accepted images.
// A run that already failed (an error, a failed check, a layout problem) proposes nothing: its
// pictures show something broken, not a new look to approve.
//
// Returns {pending, items, changed, refused}: how many images are pending, the contact-sheet tiles
// that show what is not simply unchanged (side-by-sides of changed shots, then new and diagnostic
// shots), whether any shot changed, and whether `update` was refused because the run failed.
export async function diffShots({ projectRoot, scenario, shotsByProfile, report, update = false }) {
  const refused = update && !report.passed;
  if (refused) update = false;
  const changedItems = [];
  const otherItems = [];
  let pending = 0;

  for (const shots of shotsByProfile) {
    const used = new Set();
    for (const shot of shots) {
      if (shot.diagnostic) {
        otherItems.push({ path: shot.path, label: shot.label });
        continue;
      }
      let shotName = slug(shot.name);
      for (let n = 2; used.has(shotName); n++) shotName = `${slug(shot.name)}-${n}`;
      used.add(shotName);

      const file = `${shotName}@${slug(shot.profile)}.png`;
      const baseline = path.join(baselinesDir(projectRoot), scenario, file);
      const proposal = path.join(pendingDir(projectRoot, scenario), file);
      const record = { name: shot.name, profile: shot.profile };

      let result;
      if (!fs.existsSync(baseline)) {
        result = { status: 'new', ratio: 0 };
      } else {
        try {
          result = await compare(baseline, shot.path, { maskBoxes: shot.maskBoxes ?? [] });
        } catch (err) {
          report.addError({ profile: shot.profile, kind: 'baseline', text: `Could not compare ${shot.name} with ${baseline}: ${err.message}` });
          continue;
        }
      }
      report.addDiff({ ...record, ratio: result.ratio, status: result.status, sideBySide: result.diffPath });

      if (result.status === 'changed') {
        changedItems.push({ path: result.diffPath, label: `${shot.profile} ${shot.name}: changed ${(result.ratio * 100).toFixed(2)}%` });
      } else if (result.status === 'new') {
        otherItems.push({ path: shot.path, label: `${shot.profile} ${shot.name}: new (no baseline)` });
      }

      if (update && result.status !== 'same') {
        fs.mkdirSync(path.dirname(proposal), { recursive: true });
        fs.copyFileSync(shot.path, proposal);
        pending += 1;
      } else if (update && fs.existsSync(proposal)) {
        fs.rmSync(proposal);
      }
    }
  }
  return { pending, items: [...changedItems, ...otherItems], changed: changedItems.length > 0, refused };
}

// The project a command line works on: --out if given, else the nearest folder above `start`
// that holds a .eyes folder, else `start` itself.
export function projectRootFrom(start, out) {
  if (out) return path.resolve(out);
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.eyes'))) return dir;
    if (path.dirname(dir) === dir) return path.resolve(start);
  }
}
