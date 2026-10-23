// The per-profile flow shared by `look` and `run`: open a page, navigate, wait until it is ready,
// hand it to the command's own body, and make sure one profile's failure never loses the report.
// Also the shared ending: contact sheet, report.json, and the text report.

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { contactSheet } from '../images.mjs';
import { openPage } from './browser.mjs';
import { waitReady, ReadyTimeout } from './ready.mjs';
import { findLayoutProblems } from './layout.mjs';
import { DEFAULT_STEP_TIMEOUT_MS, DIAGNOSTIC_SHOT_TIMEOUT_MS, StepTimeout, withDeadline } from './deadline.mjs';

const CONTEXT_CLOSE_TIMEOUT_MS = 10000;

// Safe as a folder or file name and as one word in the report's first line.
export function slug(text) {
  return String(text).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'page';
}

export function profileLabel(profile) {
  const scale = profile.deviceScaleFactor === 1 ? '' : ` @${profile.deviceScaleFactor}x`;
  return `${profile.name} ${profile.width}x${profile.height}${scale}`;
}

const firstLine = (err) => String(err?.message ?? err).split('\n')[0];

// Where the selectors' elements are on the screenshot about to be taken, as {x, y, width, height}
// in device pixels. A full-page shot is relative to the document, any other to the viewport.
async function maskBoxesOf(page, selectors, { full, scale }) {
  const boxes = [];
  for (const selector of selectors) {
    const rects = await page.locator(selector).evaluateAll(
      (elements, fullPage) =>
        elements.map((element) => {
          const r = element.getBoundingClientRect();
          return { x: r.left + (fullPage ? window.scrollX : 0), y: r.top + (fullPage ? window.scrollY : 0), width: r.width, height: r.height };
        }),
      full,
    );
    for (const r of rects) {
      if (r.width <= 0 || r.height <= 0) continue;
      const left = Math.floor(r.x * scale);
      const top = Math.floor(r.y * scale);
      boxes.push({ x: left, y: top, width: Math.ceil((r.x + r.width) * scale) - left, height: Math.ceil((r.y + r.height) * scale) - top });
    }
  }
  return boxes;
}

// Chromium renders at most 16,384 device px in one capture; below that a full-page shot starts the
// page over from the top. A taller shot is taken as fixed regions of the page, never by scrolling (so
// a sticky header is drawn once), and stitched. One image holds at most MAX_SHOT_ROWS rows and
// MAX_SHOT_PIXELS pixels (sharp's default input limit is 268 million, and a diff holds the whole
// image); a taller page is cut there, with a note in the report.
const MAX_CAPTURE_PX = 16384;
const TILE_PX = 8192;
const MAX_SHOT_ROWS = 65536;
const MAX_SHOT_PIXELS = 100_000_000;

// CSS px per tile: as near TILE_PX device px as possible while a whole number of device px, so
// tiles at a fractional scale (4k is 1.75) meet without a gap or overlap.
function tileHeight(scale) {
  for (let css = Math.floor(TILE_PX / scale); css > 1; css--) {
    if (Number.isInteger(css * scale)) return css;
  }
  return Math.floor(TILE_PX / scale);
}

// The page's full size in CSS px, as Playwright's own full-page shot measures it.
async function contentSize(page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { cssContentSize } = await cdp.send('Page.getLayoutMetrics');
    return { width: Math.ceil(cssContentSize.width), height: Math.ceil(cssContentSize.height) };
  } finally {
    await cdp.detach().catch(() => {});
  }
}

async function stitch(tiles, file) {
  const layers = [];
  let top = 0;
  let width = 0;
  for (const input of tiles) {
    const meta = await sharp(input).metadata();
    layers.push({ input, top, left: 0 });
    top += meta.height;
    width = Math.max(width, meta.width);
  }
  await sharp({ create: { width, height: top, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(layers)
    .png()
    .toFile(file);
}

// A full-page shot. capture(clip) shoots one region of the page, in page CSS px.
async function shootRegions(capture, { width, height, scale }, file) {
  if (height * scale <= MAX_CAPTURE_PX) return capture({ x: 0, y: 0, width, height }, file);
  const tile = tileHeight(scale);
  const tiles = [];
  for (let top = 0; top < height; top += tile) {
    tiles.push(await capture({ x: 0, y: top, width, height: Math.min(tile, height - top) }));
  }
  return stitch(tiles, file);
}

// How many CSS px of a page `width` CSS px wide one image can hold at `scale`.
function maxShotHeight(width, scale) {
  return Math.floor(Math.min(MAX_SHOT_ROWS, MAX_SHOT_PIXELS / Math.ceil(width * scale)) / scale);
}

// A full-page shot. At a monitor view this is Playwright's full-page capture. At a touch view it is
// not: Chromium's full-page capture turns touch emulation off while it renders, so the shot would show
// the page laid out for a mouse, and the page's pointer: coarse listeners would fire twice. There the
// viewport grows to the page's height for ordinary shots, then the viewport and scroll position are
// put back; the width stays the view's (a phone does not widen to show overflow).
// Returns a note for the report when the page was too tall for one image.
async function fullShot(page, profile, { path: file, ...options }) {
  const scale = profile.deviceScaleFactor;
  const content = await contentSize(page);
  const width = profile.touch ? profile.width : content.width;
  const height = Math.min(content.height, maxShotHeight(width, scale));
  const note = height < content.height
    ? `The page is ${content.height}px tall at ${profile.name}; its full-page shot shows the top ${height}px, the most one image holds at this view.`
    : undefined;

  if (!profile.touch) {
    if (content.height * scale <= MAX_CAPTURE_PX) {
      await page.screenshot({ ...options, path: file, fullPage: true });
    } else {
      await shootRegions((clip, to) => page.screenshot({ ...options, ...(to ? { path: to } : {}), fullPage: true, clip }), { width, height, scale }, file);
    }
    return note;
  }

  const { x, y } = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
  await page.setViewportSize({ width: profile.width, height: Math.max(content.height, profile.height) });
  try {
    await shootRegions((clip, to) => page.screenshot({ ...options, ...(to ? { path: to } : {}), clip }), { width, height, scale }, file);
  } finally {
    await page.setViewportSize({ width: profile.width, height: profile.height });
    await page.evaluate(([sx, sy]) => window.scrollTo(sx, sy), [x, y]);
  }
  return note;
}

// Runs `body(page, tools)` against a fresh page at `profile`. Returns the shots taken, as
// [{name, path, label, profile, maskBoxes, diagnostic}], in order. Never throws for a problem with the page or the body: it is
// recorded as an error for this profile and an 'error' shot is attempted.
//
// tools.shot(name, {full, file, diagnostic}) screenshots, records the shot and adds it to the contact sheet.
// A diagnostic shot (of a page that may be stuck) skips the mask and gives up after a few seconds.
// tools.layout() records layout problems for the current page.
// stopOnProblem: when navigation or readiness fails, shoot 'error' and skip the body.
// beforeNavigate(page): runs before the page is opened (for example to install a fake clock).
// mask: selectors whose boxes at the moment of each shot are recorded as shot.maskBoxes (device pixels).
// frames: false when the page clock is paused, so readiness does not wait for animation frames.
// stepTimeoutMs: the deadline for each shot and for the layout scan; a body that runs out of time
// throws StepTimeout, recorded as a `timeout` error.
export async function captureProfile(
  {
    browser,
    profile,
    report,
    runDir,
    url,
    wait,
    timeoutMs,
    stopOnProblem = false,
    nameShots = false,
    beforeNavigate,
    frames = true,
    mask = [],
    stepTimeoutMs = DEFAULT_STEP_TIMEOUT_MS,
  },
  body,
) {
  const shots = [];
  const used = new Set();
  const fail = (kind, text) => report.addError({ profile: profile.name, kind, text });
  let page = null;

  const take = async (name, { full, file, diagnostic }) => {
    const stem = file ?? `${slug(profile.name)}-${slug(name)}`;
    let unique = stem;
    for (let n = 2; used.has(unique); n++) unique = `${stem}-${n}`;
    used.add(unique);
    const target = path.join(runDir, `${unique}.png`);
    let maskBoxes = [];
    if (mask.length > 0 && !diagnostic) {
      try {
        maskBoxes = await maskBoxesOf(page, mask, { full, scale: profile.deviceScaleFactor });
      } catch (err) {
        fail('mask', `Could not measure the mask selectors: ${firstLine(err)}`);
      }
    }
    const options = { path: target, ...(diagnostic ? { timeout: DIAGNOSTIC_SHOT_TIMEOUT_MS } : {}) };
    if (full) {
      const note = await fullShot(page, profile, options);
      if (note) report.addNote(note);
    } else {
      await page.screenshot(options);
    }
    report.addShot({ name, profile: profile.name, path: target });
    const base = profileLabel(profile);
    shots.push({ name, path: target, label: nameShots ? `${base} ${name}` : base, profile: profile.name, maskBoxes, diagnostic });
    return target;
  };
  const tools = {
    shot(name, { full = false, file, diagnostic = false } = {}) {
      return withDeadline(take(name, { full, file, diagnostic }), stepTimeoutMs, `the shot "${name}"`);
    },
    async layout() {
      const problems = await withDeadline(findLayoutProblems(page), stepTimeoutMs, 'the layout scan');
      for (const problem of problems) {
        report.addLayout({ profile: profile.name, ...problem });
      }
    },
  };

  try {
    page = await openPage(browser, profile, report);
    if (beforeNavigate) await beforeNavigate(page);

    let problem = false;
    try {
      await page.goto(url, { waitUntil: 'commit' });
    } catch (err) {
      problem = true;
      fail('navigation', `Could not open ${url}: ${firstLine(err)}`);
    }
    try {
      await waitReady(page, { selector: wait, timeoutMs, frames });
    } catch (err) {
      if (!(err instanceof ReadyTimeout)) throw err;
      problem = true;
      fail('timeout', err.message);
    }

    if (problem && stopOnProblem) {
      await tools.shot('error', { diagnostic: true });
    } else {
      await body(page, tools);
    }
  } catch (err) {
    // A timeout means the page stopped answering (a pending promise, an endless loop): the page's fault.
    if (err instanceof StepTimeout) fail('timeout', `${err.message}; the page may be stuck in a loop or waiting forever`);
    else fail('exception', firstLine(err));
    if (page) await tools.shot('error', { diagnostic: true }).catch(() => {});
  } finally {
    // Closing the context also ends any evaluate the page never answered.
    if (page) await withDeadline(page.context().close(), CONTEXT_CLOSE_TIMEOUT_MS, 'closing the page').catch(() => {});
  }
  return shots;
}

// One tile per shot, ordered so each row shows the same moment at every profile.
function interleave(shotsByProfile) {
  const out = [];
  const longest = Math.max(0, ...shotsByProfile.map((s) => s.length));
  for (let i = 0; i < longest; i++) {
    for (const shots of shotsByProfile) if (shots[i]) out.push(shots[i]);
  }
  return out;
}

// Writes sheet.png and report.json into runDir, prints the text report, returns the exit code.
// sheet: {items, columns} replaces the default tiles (one per shot), for example with side-by-sides.
export async function finishRun({ report, runDir, shotsByProfile, sheet }) {
  const items = sheet?.items ?? interleave(shotsByProfile);
  if (items.length > 0) {
    try {
      const columns = sheet ? sheet.columns : shotsByProfile.length > 1 ? Math.min(shotsByProfile.length, 3) : undefined;
      report.setSheet(await contactSheet(items, path.join(runDir, 'sheet.png'), { columns }));
    } catch (err) {
      report.addError({ kind: 'exception', text: `Could not build the contact sheet: ${firstLine(err)}` });
    }
  }
  fs.writeFileSync(path.join(runDir, 'report.json'), `${JSON.stringify(report.toJSON(), null, 2)}\n`);
  console.log(report.toText());
  return report.exitCode();
}
