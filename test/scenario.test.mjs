import './setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkViews, loadScenario, parseDuration } from '../src/scenario.mjs';
import { resolveProfiles } from '../src/profiles.mjs';
import { EyesError } from '../src/report.mjs';

let dir;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eyes-scenario-'));
});
after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

let counter = 0;
function write(text, ext = 'yaml', stem = `s${++counter}`) {
  const file = path.join(dir, `${stem}.${ext}`);
  fs.writeFileSync(file, text);
  return file;
}

async function rejects(file, pattern) {
  await assert.rejects(loadScenario(file), (err) => {
    assert.ok(err instanceof EyesError, `expected EyesError, got ${err}`);
    assert.equal(err.exitCode, 2);
    assert.match(err.message, pattern);
    assert.ok(err.message.includes(path.basename(file)), `message should name the file: ${err.message}`);
    return true;
  });
}

test('a full scenario loads with defaults filled in and the name from the file stem', async () => {
  const file = write(
    [
      'url: page.html',
      'views: [desktop]',
      'wait: "#ready"',
      'mask: ["#clock"]',
      'steps:',
      '  - click: "text=New campaign"',
      '  - drag: { from: "#card", to: "#zone" }',
      '  - drag: { from: "#card", to: { canvas: "#c", x: 0.5, y: 0.25 } }',
      '  - key: Control+k',
      '  - type: { into: "#name", text: hello }',
      '  - wait: "#done"',
      '  - shot: first',
      '  - shot: { name: second, full: true }',
      '  - check: "window.ok"',
      '  - check: { visible: "#a" }',
      '  - check: { hidden: "#b" }',
      '  - check: { text: "#c", contains: "hi" }',
    ].join('\n'),
    'yaml',
    'campaign-flow',
  );
  const s = await loadScenario(file);
  assert.equal(s.name, 'campaign-flow');
  assert.equal(s.kind, 'web');
  assert.equal(s.clock, 'real');
  assert.deepEqual(s.views, ['desktop']);
  assert.deepEqual(s.mask, ['#clock']);
  assert.equal(s.wait, '#ready');
  assert.equal(s.file, file);
  assert.equal(s.dir, dir);
  assert.equal(s.steps.length, 12);
  assert.deepEqual(s.steps[0], { type: 'click', value: 'text=New campaign' });
  assert.deepEqual(s.steps[2].value, { from: '#card', to: { canvas: '#c', x: 0.5, y: 0.25 } });
  assert.deepEqual(s.steps[7].value, { name: 'second', full: true });
});

test('an explicit name wins over the file stem', async () => {
  const s = await loadScenario(write('name: checkout\nurl: a.html\nsteps:\n  - key: a\n'));
  assert.equal(s.name, 'checkout');
});

test('unknown top-level keys are exit 2 and list the valid keys', async () => {
  await rejects(write('url: a.html\nbogus: 1\nsteps:\n  - key: a\n'), /unknown key "bogus".*steps/s);
});

test('an unknown step type is exit 2 with the step number and the valid types', async () => {
  const file = write('url: a.html\nsteps:\n  - key: a\n  - swipe: "#x"\n');
  await rejects(file, /step 2.*unknown step type "swipe".*click, tap, drag, key, type, wait, advance, shot, check/s);
});

test('a step with two keys is exit 2 with the step number', async () => {
  await rejects(write('url: a.html\nsteps:\n  - click: "#a"\n  - click: "#b"\n    key: x\n'), /step 2.*exactly one/s);
});

test('advance with clock real is exit 2; with clock fixed it loads', async () => {
  await rejects(write('url: a.html\nsteps:\n  - key: a\n  - advance: 500ms\n'), /step 2.*advance.*clock: fixed/s);
  const s = await loadScenario(write('url: a.html\nclock: fixed\nsteps:\n  - advance: 30s\n'));
  assert.equal(s.clock, 'fixed');
});

test('bad step values name the step', async () => {
  await rejects(write('url: a.html\nsteps:\n  - click: ""\n'), /step 1.*click/s);
  await rejects(write('url: a.html\nsteps:\n  - tap: 5\n'), /step 1.*tap.*selector/s);
  await rejects(write('url: a.html\nsteps:\n  - drag: { from: "#a" }\n'), /step 1.*drag.*to/s);
  await rejects(write('url: a.html\nsteps:\n  - drag: { from: "#a", to: { canvas: "#c", x: 2, y: 0 } }\n'), /step 1.*0.*1/s);
  await rejects(write('url: a.html\nsteps:\n  - type: { into: "#a" }\n'), /step 1.*type.*text/s);
  await rejects(write('url: a.html\nsteps:\n  - shot: { full: true }\n'), /step 1.*shot.*name/s);
  await rejects(write('url: a.html\nsteps:\n  - check: { visible: "#a", hidden: "#b" }\n'), /step 1.*check/s);
  await rejects(write('url: a.html\nsteps:\n  - check: { text: "#a" }\n'), /step 1.*contains/s);
  await rejects(write('url: a.html\nclock: fixed\nsteps:\n  - advance: soon\n'), /step 1.*advance.*500ms/s);
  await rejects(write('url: a.html\nsteps: nope\n'), /steps.*list/s);
  await rejects(write('url: a.html\n'), /steps/);
});

test('bad top-level values are exit 2', async () => {
  await rejects(write('kind: tv\nsteps:\n  - key: a\n'), /kind.*web.*godot/s);
  await rejects(write('url: a.html\nclock: wobbly\nsteps:\n  - key: a\n'), /clock.*real.*fixed/s);
  await rejects(write('url: a.html\nviews: 5\nsteps:\n  - key: a\n'), /views/);
  await rejects(write('url: a.html\nmask: "#a"\nsteps:\n  - key: a\n'), /mask/);
  await rejects(write('url: a.html\nbefore: 7\nsteps:\n  - key: a\n'), /before/);
  await rejects(write('url: a.html\ngodot: {}\nsteps:\n  - key: a\n'), /godot.*kind: godot/s);
});

test('broken YAML, a missing file and an unknown extension are exit 2', async () => {
  await rejects(write('url: [unclosed\n'), /YAML/i);
  await assert.rejects(loadScenario(path.join(dir, 'missing.yaml')), (err) => err.exitCode === 2 && /not found/i.test(err.message));
  await rejects(write('x', 'txt'), /\.yaml.*\.mjs/s);
});

test('kind godot keeps its settings and takes frame steps, not web steps', async () => {
  const s = await loadScenario(write('kind: godot\ngodot:\n  project: .\n  frames: 10\nsteps:\n  - {at: 2, press: ui_accept}\n'));
  assert.equal(s.kind, 'godot');
  assert.deepEqual(s.godot, { exe: undefined, project: '.', scene: undefined, fps: 30, resolution: '1920x1080', frames: 10 });
  assert.deepEqual(s.steps, [{ n: 1, at: 2, type: 'press', value: 'ui_accept' }]);
  await assert.rejects(loadScenario(write('kind: godot\ngodot:\n  frames: 10\nsteps:\n  - key: a\n')), /step 1 has unknown key "key"/);
});

test('a .mjs scenario exports a default function and may export config', async () => {
  const file = write(
    "export const config = { url: 'x.html', views: ['desktop'], clock: 'fixed' };\n" +
      'export default async (page, eyes) => { await eyes.shot("a"); };\n',
    'mjs',
    'script-flow',
  );
  const s = await loadScenario(file);
  assert.equal(s.name, 'script-flow');
  assert.equal(s.url, 'x.html');
  assert.equal(s.clock, 'fixed');
  assert.equal(typeof s.script, 'function');
  assert.deepEqual(s.steps, []);
});

test('a .mjs scenario without a default function, or with steps in config, is exit 2', async () => {
  await rejects(write('export const config = {};\n', 'mjs'), /default.*function/s);
  await rejects(write('export default () => {};\nexport const config = { steps: [] };\n', 'mjs'), /config.*steps/s);
  await rejects(write('export default () => { ;\n', 'mjs'), /could not be loaded/i);
});

test('parseDuration reads ms, s and m', () => {
  assert.equal(parseDuration('500ms'), 500);
  assert.equal(parseDuration('30s'), 30000);
  assert.equal(parseDuration('1.5s'), 1500);
  assert.equal(parseDuration('2m'), 120000);
  assert.equal(parseDuration('soon'), null);
  assert.equal(parseDuration(500), null);
});

test('a tap step loads as a selector', async () => {
  const s = await loadScenario(write('url: a.html\nviews: [phone]\nsteps:\n  - tap: "#menu"\n'));
  assert.deepEqual(s.steps, [{ type: 'tap', value: '#menu' }]);
});

test('checkViews: tap runs only at touch views, and names the step and the views that are not touch', async () => {
  const s = await loadScenario(write('url: a.html\nsteps:\n  - click: "#a"\n  - tap: "#menu"\n'));
  const missing = path.join(dir, 'no-calibration', 'profiles.json');
  assert.doesNotThrow(() => checkViews(s, resolveProfiles(['phone', 'ipad-13-side'], missing)));
  assert.throws(
    () => checkViews(s, resolveProfiles(['phone', 'desktop', '4k'], missing)),
    (err) => {
      assert.ok(err instanceof EyesError);
      assert.equal(err.exitCode, 2);
      assert.ok(err.message.includes(path.basename(s.file)), err.message);
      assert.match(err.message, /step 2 is a tap.*touch view \(phone, phone-l, ipad-mini, ipad-mini-side, ipad-13, ipad-13-side\).*desktop, 4k are not touch/s);
      return true;
    },
  );
  const noTap = await loadScenario(write('url: a.html\nsteps:\n  - click: "#a"\n'));
  assert.doesNotThrow(() => checkViews(noTap, resolveProfiles(['desktop'], missing)));
});
