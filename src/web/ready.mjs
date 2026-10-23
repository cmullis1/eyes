// Page readiness: load, fonts, two animation frames, an optional selector, the page's own
// window.__eyes.ready flag when it has one, and (best effort) a quiet network. Every wait is
// bounded; a timeout is a ReadyTimeout.

export class ReadyTimeout extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReadyTimeout';
  }
}

const QUIET_MS = 500;
const READY_POLL_MS = 50;
const QUIET_CAP_MS = 5000;

const trackers = new WeakMap();

// Counts in-flight requests on a page. openPage calls this before any navigation so
// requests started during goto() are seen; waitReady falls back to calling it lazily.
export function trackNetwork(page) {
  const existing = trackers.get(page);
  if (existing) return existing;
  const inflight = new Set();
  const listeners = new Set();
  const changed = () => {
    for (const fn of listeners) fn();
  };
  page.on('request', (r) => {
    inflight.add(r);
    changed();
  });
  const done = (r) => {
    inflight.delete(r);
    changed();
  };
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  const tracker = {
    get inflight() {
      return inflight.size;
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  trackers.set(page, tracker);
  return tracker;
}

// Resolves once nothing has been in flight for QUIET_MS, or when capMs elapses.
function waitNetworkQuiet(tracker, capMs) {
  return new Promise((resolve) => {
    let quietTimer = null;
    let off;
    const finish = () => {
      clearTimeout(quietTimer);
      clearTimeout(capTimer);
      off();
      resolve();
    };
    const capTimer = setTimeout(finish, capMs);
    const check = () => {
      clearTimeout(quietTimer);
      quietTimer = tracker.inflight === 0 ? setTimeout(finish, QUIET_MS) : null;
    };
    off = tracker.onChange(check);
    check();
  });
}

// A page that defines window.__eyes with a `ready` property is ready only once ready is true.
async function waitReadyFlag(page) {
  for (;;) {
    const ready = await page.evaluate(() => window.__eyes?.ready === true);
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
}

// frames: false skips the animation-frame wait, for a page whose clock is paused (its frames never come).
export async function waitReady(page, { selector, timeoutMs = 20000, frames = true } = {}) {
  const tracker = trackNetwork(page);
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());

  // Race a step against the overall deadline, so a stuck page cannot hang us.
  const step = async (label, run) => {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new ReadyTimeout(`Page not ready after ${timeoutMs} ms: waiting for ${label}`)),
        remaining(),
      );
    });
    try {
      return await Promise.race([run(), timeout]);
    } catch (err) {
      if (err instanceof ReadyTimeout) throw err;
      if (err?.name === 'TimeoutError') {
        throw new ReadyTimeout(`Page not ready after ${timeoutMs} ms: waiting for ${label}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };

  await step('page load', () => page.waitForLoadState('load', { timeout: remaining() }));
  await step('fonts', () => page.evaluate(() => document.fonts.ready.then(() => true)));
  if (frames) {
    await step('animation frames', () =>
      page.evaluate(
        () =>
          new Promise((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
          }),
      ),
    );
  }
  if (selector) {
    await step(`selector ${selector}`, () =>
      page.waitForSelector(selector, { state: 'attached', timeout: remaining() }),
    );
  }
  const hasFlag = await step('window.__eyes', () =>
    page.evaluate(() => typeof window.__eyes === 'object' && window.__eyes !== null && 'ready' in window.__eyes),
  );
  if (hasFlag) {
    // Under a paused clock, a page that sets the flag from a timer needs an advance step first.
    const label = frames ? 'window.__eyes.ready' : 'window.__eyes.ready (the clock is fixed: its timers only run on advance steps)';
    await step(label, () => waitReadyFlag(page));
  }
  // Best effort: never fails, and never outlasts the overall deadline.
  await waitNetworkQuiet(tracker, Math.min(QUIET_CAP_MS, remaining()));
}
