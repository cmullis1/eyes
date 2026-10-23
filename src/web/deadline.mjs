// Deadlines for work that waits on the page. A page can keep a promise pending forever or spin in
// an endless loop, and Playwright's evaluate() has no timeout of its own, so every step, script,
// layout scan and film frame is raced against stepTimeout. The work left behind ends when its
// browser context is closed, which the per-profile flow always does.

import { EyesError } from '../report.mjs';

export const DEFAULT_STEP_TIMEOUT_MS = 30000;
// A diagnostic screenshot of a page that may be stuck: short, so a busy page cannot hold up the run.
export const DIAGNOSTIC_SHOT_TIMEOUT_MS = 5000;

const seconds = (ms) => `${Number((ms / 1000).toFixed(3))} s`;

export class StepTimeout extends Error {
  constructor(what, ms) {
    super(`${what} did not finish within ${seconds(ms)}`);
    this.name = 'StepTimeout';
  }
}

// Resolves or rejects like `promise`, or rejects with StepTimeout after `ms`. The promise is still
// running after a timeout; its eventual rejection (when the context closes) is swallowed.
export function withDeadline(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new StepTimeout(what, ms)), ms);
  });
  Promise.resolve(promise).catch(() => {});
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// --step-timeout <ms>: how long one step, script, shot, layout scan or film frame may take.
export function parseStepTimeout(text) {
  if (text === undefined) return undefined;
  const ms = Number(text);
  if (!Number.isFinite(ms) || ms <= 0) throw new EyesError(`--step-timeout must be a positive number of milliseconds, got "${text}"`, 2);
  return ms;
}
