// Scenario files: YAML (a list of steps) or an .mjs module (a function driving the page).
// loadScenario validates everything up front, so a typo is exit 2 before any browser starts.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';
import { EyesError } from './report.mjs';
import { TOUCH_VIEWS } from './profiles.mjs';

export const STEP_TYPES = ['click', 'tap', 'drag', 'key', 'type', 'wait', 'advance', 'shot', 'check'];
const TOP_KEYS = ['name', 'kind', 'before', 'serve', 'url', 'views', 'clock', 'wait', 'mask', 'stepTimeout', 'seed', 'steps', 'godot'];
const KINDS = ['web', 'godot'];
const CLOCKS = ['real', 'fixed'];

export const GODOT_STEP_TYPES = ['press', 'release', 'mouse', 'shot', 'check'];
const GODOT_KEYS = ['exe', 'project', 'scene', 'fps', 'resolution', 'frames'];
const WEB_ONLY_KEYS = ['serve', 'url', 'views', 'clock', 'wait', 'mask', 'stepTimeout', 'seed'];
const GODOT_DEFAULT_FPS = 30;
const GODOT_MAX_FPS = 240;
const GODOT_DEFAULT_RESOLUTION = '1920x1080';
const GODOT_MAX_FRAMES = 9000; // 5 minutes at 30 fps; every frame is a PNG on disk until the run is done
const MOUSE_BUTTONS = ['left', 'right', 'middle'];

export function parseDuration(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m)$/.exec(value.trim());
  if (!m) return null;
  return Math.round(Number(m[1]) * { ms: 1, s: 1000, m: 60000 }[m[2]]);
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';

// Errors are exit 2 and always name the scenario file.
function validate(raw, file, { isScript }) {
  const bad = (message) => new EyesError(`${file}: ${message}`, 2);

  for (const key of Object.keys(raw)) {
    if (!TOP_KEYS.includes(key)) {
      throw bad(`unknown key "${key}". Valid keys: ${TOP_KEYS.join(', ')}`);
    }
  }
  const text = (key) => {
    if (raw[key] === undefined) return undefined;
    if (!isText(raw[key])) throw bad(`"${key}" must be a non-empty string`);
    return raw[key];
  };

  const kind = raw.kind ?? 'web';
  if (!KINDS.includes(kind)) throw bad(`"kind" must be "web" or "godot", got ${JSON.stringify(kind)}`);
  if (raw.godot !== undefined && kind !== 'godot') throw bad('"godot" settings are only valid with kind: godot');
  if (kind === 'godot') return validateGodot(raw, { isScript, bad, text });
  const clock = raw.clock ?? 'real';
  if (!CLOCKS.includes(clock)) throw bad(`"clock" must be "real" or "fixed", got ${JSON.stringify(clock)}`);

  let views;
  if (raw.views !== undefined) {
    const list = typeof raw.views === 'string' ? raw.views.split(',').map((v) => v.trim()) : raw.views;
    if (!Array.isArray(list) || list.length === 0 || !list.every(isText)) {
      throw bad('"views" must be a list of view names, e.g. [desktop, 4k]');
    }
    views = list;
  }
  let mask = [];
  if (raw.mask !== undefined) {
    if (!Array.isArray(raw.mask) || !raw.mask.every(isText)) throw bad('"mask" must be a list of selectors');
    mask = raw.mask;
  }

  let stepTimeoutMs;
  if (raw.stepTimeout !== undefined) {
    const v = raw.stepTimeout;
    stepTimeoutMs = typeof v === 'number' ? v : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : parseDuration(v);
    if (!(stepTimeoutMs > 0) || !Number.isFinite(stepTimeoutMs)) {
      throw bad(`"stepTimeout" must be a duration like 30s or 2m, or a number of milliseconds, got ${JSON.stringify(v)}`);
    }
  }

  let seed;
  if (raw.seed !== undefined) {
    if (!Number.isInteger(raw.seed)) throw bad(`"seed" must be a whole number, got ${JSON.stringify(raw.seed)}`);
    if (clock !== 'fixed') throw bad('"seed" only works with clock: fixed (Math.random is seeded under the fixed clock)');
    seed = raw.seed;
  }

  let steps = [];
  if (!isScript) {
    if (raw.steps === undefined) throw bad('"steps" is required: a list of steps to run');
    if (!Array.isArray(raw.steps)) throw bad('"steps" must be a list');
    if (raw.steps.length === 0) throw bad('"steps" needs at least one step');
    steps = raw.steps.map((step, i) => validateStep(step, i + 1, clock, bad));
  } else if (raw.steps !== undefined) {
    throw bad('a .mjs scenario drives the page from its default function; "config" must not have steps');
  }

  return {
    name: text('name'),
    kind,
    before: text('before'),
    serve: text('serve'),
    url: text('url'),
    views,
    clock,
    wait: text('wait'),
    mask,
    stepTimeoutMs,
    seed,
    steps,
  };
}

// kind: godot. A run of `godot.frames` frames at `godot.fps`; each step fires on a frame (`at`).
function validateGodot(raw, { isScript, bad, text }) {
  if (isScript) throw bad('a Godot scenario must be a YAML file (.yaml or .yml)');
  for (const key of WEB_ONLY_KEYS) {
    if (raw[key] !== undefined) throw bad(`"${key}" is only for web scenarios; a Godot scenario has ${GODOT_KEYS.map((k) => `godot.${k}`).join(', ')}`);
  }
  if (raw.godot === undefined) throw bad('a Godot scenario needs "godot" settings, at least godot.frames (how many frames to run)');
  if (!isObject(raw.godot)) throw bad(`"godot" must be a mapping with keys ${GODOT_KEYS.join(', ')}`);
  const g = raw.godot;
  for (const key of Object.keys(g)) {
    if (!GODOT_KEYS.includes(key)) throw bad(`"godot" has unknown key "${key}". Valid keys: ${GODOT_KEYS.join(', ')}`);
  }
  const godotText = (key) => {
    if (g[key] === undefined) return undefined;
    if (!isText(g[key])) throw bad(`"godot.${key}" must be a non-empty string`);
    return g[key];
  };
  const wholeNumber = (key, min, max) => {
    const v = g[key];
    if (!Number.isInteger(v) || v < min || v > max) throw bad(`"godot.${key}" must be a whole number from ${min} to ${max}, got ${JSON.stringify(v)}`);
    return v;
  };

  const scene = godotText('scene');
  if (scene !== undefined && !/^(res|uid):\/\//.test(scene)) {
    throw bad(`"godot.scene" must be a res:// path inside the project, like res://main.tscn, got ${JSON.stringify(scene)}`);
  }
  const fps = g.fps === undefined ? GODOT_DEFAULT_FPS : wholeNumber('fps', 1, GODOT_MAX_FPS);
  const resolution = g.resolution === undefined ? GODOT_DEFAULT_RESOLUTION : g.resolution;
  const size = typeof resolution === 'string' ? /^(\d+)x(\d+)$/.exec(resolution.trim()) : null;
  if (!size || [size[1], size[2]].some((d) => Number(d) < 16 || Number(d) > 16384)) {
    throw bad(`"godot.resolution" must be a size like 1920x1080, got ${JSON.stringify(resolution)}`);
  }
  if (g.frames === undefined) throw bad('"godot.frames" is required: how many frames to run');
  const frames = wholeNumber('frames', 1, GODOT_MAX_FRAMES);

  let steps = [];
  if (raw.steps !== undefined) {
    if (!Array.isArray(raw.steps)) throw bad('"steps" must be a list');
    const shotNames = new Set();
    const shotFrames = new Map();
    steps = raw.steps.map((step, i) => validateGodotStep(step, i + 1, { frames, shotNames, shotFrames, bad }));
  }

  return {
    name: text('name'),
    kind: 'godot',
    before: text('before'),
    steps,
    mask: [],
    godot: { exe: godotText('exe'), project: godotText('project'), scene, fps, resolution: `${size[1]}x${size[2]}`, frames },
  };
}

function validateGodotStep(step, n, { frames, shotNames, shotFrames, bad }) {
  const where = `step ${n}`;
  const validKeys = ['at', ...GODOT_STEP_TYPES];
  if (!isObject(step)) throw bad(`${where} must be a mapping like {at: 30, press: ui_accept}`);
  for (const key of Object.keys(step)) {
    if (!validKeys.includes(key)) throw bad(`${where} has unknown key "${key}". Valid keys: ${validKeys.join(', ')}`);
  }
  if (step.at === undefined) throw bad(`${where} needs "at", the frame it happens on (0 to ${frames - 1})`);
  if (!Number.isInteger(step.at)) throw bad(`${where}: "at" must be a whole number of frames, got ${JSON.stringify(step.at)}`);
  if (step.at < 0 || step.at >= frames) throw bad(`${where}: "at" is ${step.at}, but the frames run from 0 to ${frames - 1}`);
  const types = GODOT_STEP_TYPES.filter((t) => t in step);
  if (types.length !== 1) {
    throw bad(`${where} must have "at" and exactly one of ${GODOT_STEP_TYPES.join(', ')} (found ${types.length ? types.join(', ') : 'none'})`);
  }
  const type = types[0];
  const value = step[type];
  switch (type) {
    case 'press':
    case 'release':
      if (!(isText(value) || typeof value === 'number')) throw bad(`${where}: ${type} needs an input action (like ui_accept) or a key name (like Space)`);
      return { n, at: step.at, type, value: String(value) };
    case 'mouse': {
      const keys = ['x', 'y', 'button'];
      if (!isObject(value)) throw bad(`${where}: mouse must be a mapping with keys ${keys.join(', ')}`);
      for (const k of Object.keys(value)) {
        if (!keys.includes(k)) throw bad(`${where}: mouse has unknown key "${k}". Valid keys: ${keys.join(', ')}`);
      }
      for (const axis of ['x', 'y']) {
        if (typeof value[axis] !== 'number' || !(value[axis] >= 0)) throw bad(`${where}: mouse.${axis} must be a number of window pixels, 0 or more`);
      }
      const button = value.button ?? 'left';
      if (!MOUSE_BUTTONS.includes(button)) throw bad(`${where}: mouse.button must be one of ${MOUSE_BUTTONS.join(', ')}, got ${JSON.stringify(button)}`);
      return { n, at: step.at, type, value: { x: value.x, y: value.y, button } };
    }
    case 'shot': {
      if (!(isText(value) || typeof value === 'number')) throw bad(`${where}: shot needs a name`);
      const name = String(value);
      if (shotNames.has(name)) throw bad(`${where}: the shot name "${name}" is already used by an earlier step`);
      shotNames.add(name);
      // A shot is its frame's file, so two shots on one frame would be one image under two names.
      if (shotFrames.has(step.at)) throw bad(`${where}: frame ${step.at} already has the shot "${shotFrames.get(step.at)}"; take one shot per frame`);
      shotFrames.set(step.at, name);
      return { n, at: step.at, type, value: name };
    }
    case 'check':
      if (!isText(value)) throw bad(`${where}: check needs a GDScript expression, evaluated on the scene root, like "$Player.position.x > 100"`);
      return { n, at: step.at, type, value };
    default:
      throw bad(`${where}: unknown step type "${type}"`);
  }
}

function validateStep(step, n, clock, bad) {
  const where = `step ${n}`;
  if (!isObject(step)) throw bad(`${where} must be a mapping like "click: #button"`);
  const keys = Object.keys(step);
  if (keys.length !== 1) {
    throw bad(
      `${where} must have exactly one key (found ${keys.length ? keys.join(', ') : 'none'}). Valid: ${STEP_TYPES.join(', ')}`,
    );
  }
  const type = keys[0];
  const value = step[type];
  if (!STEP_TYPES.includes(type)) {
    throw bad(`${where}: unknown step type "${type}". Valid: ${STEP_TYPES.join(', ')}`);
  }
  const selector = (v, what) => {
    if (!isText(v)) throw bad(`${where}: ${what} must be a non-empty selector string`);
    return v;
  };
  const onlyKeys = (obj, allowed, what) => {
    if (!isObject(obj)) throw bad(`${where}: ${what} must be a mapping with keys ${allowed.join(', ')}`);
    for (const k of Object.keys(obj)) {
      if (!allowed.includes(k)) throw bad(`${where}: ${what} has unknown key "${k}". Valid keys: ${allowed.join(', ')}`);
    }
  };

  switch (type) {
    case 'click':
    case 'tap':
    case 'wait':
      return { type, value: selector(value, type) };
    case 'key':
      if (!(isText(value) || typeof value === 'number')) throw bad(`${where}: key must be a key or chord like Enter or Control+k`);
      return { type, value: String(value) };
    case 'type': {
      onlyKeys(value, ['into', 'text'], 'type');
      if (!('text' in value) || !(typeof value.text === 'string' || typeof value.text === 'number')) {
        throw bad(`${where}: type needs "text", the text to type`);
      }
      return { type, value: { into: selector(value.into, 'type.into'), text: String(value.text) } };
    }
    case 'drag': {
      onlyKeys(value, ['from', 'to'], 'drag');
      const from = selector(value.from, 'drag.from');
      if (value.to === undefined) throw bad(`${where}: drag needs "to", a selector or {canvas, x, y}`);
      if (isObject(value.to)) {
        onlyKeys(value.to, ['canvas', 'x', 'y'], 'drag.to');
        const canvas = selector(value.to.canvas, 'drag.to.canvas');
        for (const axis of ['x', 'y']) {
          const v = value.to[axis];
          if (typeof v !== 'number' || !(v >= 0 && v <= 1)) {
            throw bad(`${where}: drag.to.${axis} must be a number between 0 and 1 (a fraction of the canvas)`);
          }
        }
        return { type, value: { from, to: { canvas, x: value.to.x, y: value.to.y } } };
      }
      return { type, value: { from, to: selector(value.to, 'drag.to') } };
    }
    case 'advance': {
      if (clock !== 'fixed') {
        throw bad(`${where}: advance only works with clock: fixed (add "clock: fixed" to the scenario)`);
      }
      const ms = parseDuration(value);
      if (ms === null) throw bad(`${where}: advance needs a duration like 500ms, 30s or 2m, got ${JSON.stringify(value)}`);
      return { type, value, ms };
    }
    case 'shot': {
      if (typeof value === 'string' || typeof value === 'number') {
        return { type, value: { name: selector(String(value), 'shot'), full: false } };
      }
      onlyKeys(value, ['name', 'full'], 'shot');
      if (!isText(value.name)) throw bad(`${where}: shot needs a "name"`);
      if (value.full !== undefined && typeof value.full !== 'boolean') throw bad(`${where}: shot.full must be true or false`);
      return { type, value: { name: value.name, full: value.full === true } };
    }
    case 'check': {
      if (isText(value)) return { type, value };
      onlyKeys(value, ['visible', 'hidden', 'text', 'contains'], 'check');
      const kinds = ['visible', 'hidden', 'text'].filter((k) => k in value);
      if (kinds.length !== 1) {
        throw bad(`${where}: check takes a JS expression string, or exactly one of {visible: <selector>}, {hidden: <selector>}, {text: <selector>, contains: <string>}`);
      }
      const kind = kinds[0];
      selector(value[kind], `check.${kind}`);
      if (kind === 'text') {
        if (typeof value.contains !== 'string') throw bad(`${where}: check.text needs "contains", the text to look for`);
      } else if ('contains' in value) {
        throw bad(`${where}: "contains" only goes with check.text`);
      }
      return { type, value: { ...value } };
    }
    default:
      throw bad(`${where}: unknown step type "${type}"`);
  }
}

// A tap is a finger on a touch screen, so a scenario with tap steps runs only at touch views.
// Checked once the views are known (the scenario's own, or --views), before any browser starts.
export function checkViews(scenario, profiles) {
  const tap = scenario.steps?.findIndex((step) => step.type === 'tap') ?? -1;
  if (tap < 0) return;
  const notTouch = profiles.filter((profile) => !profile.touch).map((profile) => profile.name);
  if (notTouch.length === 0) return;
  throw new EyesError(
    `${scenario.file}: step ${tap + 1} is a tap, which needs a touch view (${TOUCH_VIEWS.join(', ')}), but ${notTouch.join(', ')} ${notTouch.length === 1 ? 'is' : 'are'} not touch. Use click there, or set views to touch views only.`,
    2,
  );
}

export async function loadScenario(file) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new EyesError(`Scenario file not found: ${abs}`, 2);
  const ext = path.extname(abs).toLowerCase();
  const stem = path.parse(abs).name;

  let raw;
  let script;
  if (ext === '.yaml' || ext === '.yml') {
    try {
      raw = YAML.parse(fs.readFileSync(abs, 'utf8'));
    } catch (err) {
      throw new EyesError(`${abs}: not valid YAML: ${String(err.message).split('\n')[0]}`, 2);
    }
    if (!isObject(raw)) throw new EyesError(`${abs}: a scenario must be a YAML mapping with a "steps" list`, 2);
  } else if (ext === '.mjs') {
    let mod;
    try {
      mod = await import(pathToFileURL(abs).href);
    } catch (err) {
      throw new EyesError(`${abs}: could not be loaded: ${String(err.message).split('\n')[0]}`, 2);
    }
    if (typeof mod.default !== 'function') {
      throw new EyesError(`${abs}: a .mjs scenario must export a default function (page, eyes) => void`, 2);
    }
    if (mod.config !== undefined && !isObject(mod.config)) {
      throw new EyesError(`${abs}: "config" must be an object such as { url, views, clock }`, 2);
    }
    script = mod.default;
    raw = mod.config ?? {};
  } else {
    throw new EyesError(`${abs}: a scenario file must end in .yaml, .yml or .mjs`, 2);
  }

  const scenario = validate(raw, abs, { isScript: Boolean(script) });
  return { ...scenario, name: scenario.name ?? stem, script, file: abs, dir: path.dirname(abs) };
}
