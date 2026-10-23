// clock: fixed makes a page repeatable: its clock is paused at a fixed time, its CSS and Web
// animations are frozen (see animations.mjs), and Math.random is a seeded generator.

import { freezeAnimations } from './animations.mjs';

const FIXED_CLOCK_START = new Date('2026-01-01T12:00:00Z');
export const DEFAULT_SEED = 20260101;

// Runs in every frame before the page's own scripts. The seed is chosen on the first call:
// the scenario's seed, else window.__eyes.seed if the page set a number there, else the default.
// The generator is mulberry32: small, fast, and the same sequence for the same seed everywhere.
function installSeededRandom({ forced, fallback }) {
  let state = null;
  const pageSeed = () => {
    const eyes = window.__eyes;
    return eyes && typeof eyes.seed === 'number' && Number.isFinite(eyes.seed) ? eyes.seed : null;
  };
  Object.defineProperty(Math, 'random', {
    configurable: true,
    writable: true,
    value: function random() {
      if (state === null) state = (forced ?? pageSeed() ?? fallback) >>> 0;
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  });
}

// Time starts at 2026-01-01T12:00:00.000Z and is paused there before the page runs, so it only
// moves on `advance` steps.
//
// A single pauseAt does it. Playwright records the call and replays it in every page load as
// "set the time to exactly this instant, paused" with the clock's tick counter (performance.now,
// requestAnimationFrame phase) at 0, so the page starts from the same state however long the
// real machine took. Do not add a clock.install before it: install + pauseAt are replayed with
// the real time that passed between the two calls added to the tick counter, and pauseAt throws
// "Cannot fast-forward to the past" when that gap overtakes the install time, so a loaded PC
// gave a crash or a page whose animation frames sit at a different phase.
async function freezeClock(page) {
  await page.clock.pauseAt(FIXED_CLOCK_START);
}

// Runs before navigation for clock: fixed. seed: the scenario's seed, if it has one.
export async function freezeTime(page, { seed } = {}) {
  await page.addInitScript(installSeededRandom, { forced: seed ?? null, fallback: DEFAULT_SEED });
  await freezeClock(page);
  await freezeAnimations(page);
}
