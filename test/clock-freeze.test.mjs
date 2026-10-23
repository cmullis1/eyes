// The fixed clock must read exactly its start time at page load however slow the machine is
// between setting it up and the page loading (a loaded PC made pauseAt throw "Cannot fast-forward
// to the past"), and the frames drawn from it must not depend on that delay.
import './setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { launch, openPage } from '../src/web/browser.mjs';
import { freezeTime } from '../src/web/determinism.mjs';
import { Report } from '../src/report.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLOCK_PAGE = pathToFileURL(path.join(here, 'fixtures', 'clock.html')).href;
const START = Date.parse('2026-01-01T12:00:00Z');
const profile = { name: 'laptop', width: 800, height: 400, deviceScaleFactor: 1 };

let browser;
before(async () => {
  ({ browser } = await launch());
});
after(async () => {
  await browser?.close();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Freezes the clock, wastes `delayMs` of real time on each side of the freeze, loads the clock
// page and reports Date.now() at load plus a screenshot taken after a few frames and ticks.
async function freezeAndShoot(delayMs) {
  const page = await openPage(browser, profile, new Report('clock-freeze', [profile]));
  try {
    await sleep(delayMs);
    await freezeTime(page);
    await sleep(delayMs);
    await page.goto(CLOCK_PAGE);
    const atLoad = await page.evaluate(() => Date.now());
    await page.clock.runFor(350);
    const shot = await page.screenshot();
    return { atLoad, shot };
  } finally {
    await page.context().close();
  }
}

test('the fixed clock reads exactly its start time at load, however much real time passes first', async () => {
  for (const delayMs of [0, 150, 1500]) {
    const { atLoad } = await freezeAndShoot(delayMs);
    assert.equal(atLoad, START, `Date.now() after a ${delayMs} ms gap`);
  }
});

test('frames are byte-identical whatever real time passed first', async () => {
  const fast = await freezeAndShoot(0);
  const slow = await freezeAndShoot(400);
  assert.equal(fast.atLoad, slow.atLoad);
  assert.ok(fast.shot.equals(slow.shot), 'the two screenshots differ');
});
