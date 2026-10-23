// Executes scenario steps against a page using real input: Playwright's mouse, keyboard and
// touchscreen send trusted browser events, the same ones a person's mouse, keyboard and finger produce.

import { advanceTime } from './animations.mjs';
import { DEFAULT_STEP_TIMEOUT_MS, StepTimeout, withDeadline } from './deadline.mjs';

const ACTION_TIMEOUT_MS = 10000;
const CHECK_TIMEOUT_MS = 5000;
const POLL_MS = 50;
const DRAG_MOVES = 10;
const MAX_DETAIL_CHARS = 500;

const firstLine = (err) => String(err?.message ?? err).split('\n')[0];
const isTimeout = (err) => err?.name === 'TimeoutError';

function jsonDetail(value) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  text ??= 'undefined';
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}…` : text;
}

// Repeats `attempt` until it returns a truthy value or the deadline passes. Errors count as
// "not yet" (a reload can briefly destroy the page context); the last one is returned for the report.
async function pollUntil(attempt, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    try {
      const value = await attempt();
      if (value) return { ok: true };
      lastError = null;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() >= deadline) return { ok: false, lastError };
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

export function describeStep({ type, value }) {
  switch (type) {
    case 'click':
    case 'tap':
    case 'wait':
      return `${type} ${value}`;
    case 'key':
      return `key ${value}`;
    case 'type':
      return `type into ${value.into}`;
    case 'drag':
      return typeof value.to === 'string'
        ? `drag ${value.from} -> ${value.to}`
        : `drag ${value.from} -> ${value.to.canvas} (${value.to.x}, ${value.to.y})`;
    case 'advance':
      return `advance ${value}`;
    case 'shot':
      return `shot ${value.name}`;
    case 'check':
      if (typeof value === 'string') return value;
      if ('visible' in value) return `visible ${value.visible}`;
      if ('hidden' in value) return `hidden ${value.hidden}`;
      return `text ${value.text} contains ${JSON.stringify(value.contains)}`;
    default:
      return type;
  }
}

async function centerOf(page, selector) {
  const locator = page.locator(selector);
  await locator.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
  const box = await locator.boundingBox();
  if (!box || box.width === 0 || box.height === 0) throw new Error(`${selector} has no size on screen`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

// Real mouse: move to the source, press, 10 intermediate moves to the target, release.
async function drag(page, { from, to }) {
  const start = await centerOf(page, from);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  try {
    let end;
    if (typeof to === 'string') {
      end = await centerOf(page, to);
    } else {
      const canvas = await centerOf(page, to.canvas);
      end = { x: canvas.box.x + canvas.box.width * to.x, y: canvas.box.y + canvas.box.height * to.y };
    }
    await page.mouse.move(end.x, end.y, { steps: DRAG_MOVES });
  } finally {
    await page.mouse.up();
  }
}

async function runCheck(page, value) {
  const label = describeStep({ type: 'check', value });
  if (typeof value === 'string') {
    const result = await page.evaluate(value);
    return { label, passed: Boolean(result), detail: jsonDetail(result) };
  }
  const kind = 'visible' in value ? 'visible' : 'hidden' in value ? 'hidden' : 'text';
  if (kind === 'text') {
    const locator = page.locator(value.text).first();
    let seen = '';
    const { ok, lastError } = await pollUntil(async () => {
      seen = await locator.innerText({ timeout: 200 });
      return seen.includes(value.contains);
    }, CHECK_TIMEOUT_MS);
    const detail = ok ? undefined : lastError ? firstLine(lastError) : `text was ${jsonDetail(seen)}`;
    return { label, passed: ok, detail };
  }
  try {
    await page.locator(value[kind]).first().waitFor({ state: kind, timeout: CHECK_TIMEOUT_MS });
    return { label, passed: true };
  } catch (err) {
    if (!isTimeout(err)) throw err;
    return { label, passed: false, detail: `not ${kind} after ${CHECK_TIMEOUT_MS / 1000} s` };
  }
}

async function execute(page, step, tools, profile) {
  const { type, value } = step;
  switch (type) {
    case 'click':
      await page.locator(value).click({ timeout: ACTION_TIMEOUT_MS });
      return null;
    case 'tap':
      if (!profile.touch) throw new Error(`tap needs a touch view, and ${profile.name} is not one`);
      await page.locator(value).tap({ timeout: ACTION_TIMEOUT_MS });
      return null;
    case 'drag':
      await drag(page, value);
      return null;
    case 'key':
      await page.keyboard.press(value);
      return null;
    case 'type':
      await page.locator(value.into).pressSequentially(value.text, { timeout: ACTION_TIMEOUT_MS });
      return null;
    case 'wait':
      await page.locator(value).first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
      return null;
    case 'advance':
      await advanceTime(page, step.ms);
      return null;
    case 'shot':
      await tools.shot(value.name, { full: value.full });
      return null;
    case 'check':
      return runCheck(page, value);
    default:
      throw new Error(`Unknown step type ${type}`);
  }
}

// Why a step that ran out of time may have been waiting, under a paused clock.
const FIXED_CLOCK_HINT = '; with clock: fixed, timers and animation frames only run on advance steps';

// Runs the steps in order. A failing step (a check that is false, or any error while doing it)
// is recorded as a failed check with a failed-step-<n> shot, and the remaining steps are skipped.
// Each step has stepTimeoutMs to finish (a page can leave an evaluate pending forever).
// Returns true when every step passed.
export async function runSteps(page, steps, { profile, report, tools, stepTimeoutMs = DEFAULT_STEP_TIMEOUT_MS, clockFixed = false }) {
  for (let i = 0; i < steps.length; i++) {
    const n = i + 1;
    const step = steps[i];
    const record = (outcome) =>
      report.addCheck({ profile: profile.name, step: n, label: outcome.label, passed: outcome.passed, detail: outcome.detail });

    let outcome = null;
    try {
      outcome = await withDeadline(execute(page, step, tools, profile), stepTimeoutMs, `step ${n}`);
    } catch (err) {
      const hint = err instanceof StepTimeout && clockFixed ? FIXED_CLOCK_HINT : '';
      outcome = { label: describeStep(step), passed: false, detail: `${firstLine(err)}${hint}` };
    }
    if (outcome) record(outcome);
    if (outcome && !outcome.passed) {
      await tools.shot(`failed-step-${n}`, { diagnostic: true }).catch(() => {});
      return false;
    }
  }
  return true;
}

// The .mjs scenario's `eyes` object. check() records synchronously (so numbering follows call
// order even when the script forgets to await) and shoots failed-step-<n> for a false check.
export function scriptTools({ profile, report, tools }) {
  let n = 0;
  const pending = new Set();
  const eyes = {
    profile,
    shot: (name, options = {}) => tools.shot(String(name), { full: Boolean(options.full) }),
    check(label, passed, detail) {
      n += 1;
      const step = n;
      const ok = Boolean(passed);
      report.addCheck({
        profile: profile.name,
        step,
        label: String(label),
        passed: ok,
        detail: detail === undefined ? undefined : String(detail),
      });
      if (ok) return Promise.resolve(true);
      const shot = tools.shot(`failed-step-${step}`, { diagnostic: true }).catch(() => {}).then(() => false);
      pending.add(shot);
      shot.finally(() => pending.delete(shot));
      return shot;
    },
  };
  // The script ran out of time: one more failed check, after the script's own, with a diagnostic shot.
  const timedOut = async (err) => {
    n += 1;
    report.addCheck({ profile: profile.name, step: n, label: 'scenario script', passed: false, detail: firstLine(err) });
    await tools.shot(`failed-step-${n}`, { diagnostic: true }).catch(() => {});
  };
  return {
    eyes,
    settle: () => Promise.all([...pending]),
    timedOut,
    failed: () => report.checks.some((c) => c.profile === profile.name && !c.passed),
  };
}
