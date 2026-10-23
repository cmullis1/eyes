import './setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Report, EyesError } from '../src/report.mjs';
import { makeRunDir } from '../src/runDir.mjs';

const profiles = ['desktop', '4k'];

test('passed is true with only shots', () => {
  const r = new Report('demo', profiles);
  r.addShot({ name: 'home', profile: 'desktop', path: 'a.png' });
  assert.equal(r.passed, true);
  assert.equal(r.exitCode(), 0);
});

test('passed is false after a failed check', () => {
  const r = new Report('demo', profiles);
  r.addCheck({ profile: 'desktop', step: 1, label: 'units engaged', passed: false, detail: '0 units' });
  assert.equal(r.passed, false);
  assert.equal(r.exitCode(), 1);
});

test('a passing check does not fail the report', () => {
  const r = new Report('demo', profiles);
  r.addCheck({ profile: 'desktop', step: 1, label: 'ok', passed: true, detail: '' });
  assert.equal(r.passed, true);
});

test('passed is false after one error', () => {
  const r = new Report('demo', profiles);
  r.addError({ profile: 'desktop', kind: 'pageerror', text: 'boom', location: 'a.js:1' });
  assert.equal(r.passed, false);
  assert.equal(r.exitCode(), 1);
});

test('passed is false after one layout problem', () => {
  const r = new Report('demo', profiles);
  r.addLayout({ profile: '4k', kind: 'hscroll', selector: 'body', detail: 'page 2240px wide' });
  assert.equal(r.passed, false);
});

test('passed is false after a changed diff, but not same or new', () => {
  const r = new Report('demo', profiles);
  r.addDiff({ name: 'home', profile: 'desktop', ratio: 0, status: 'same', sideBySide: null });
  r.addDiff({ name: 'menu', profile: 'desktop', ratio: 0, status: 'new', sideBySide: null });
  assert.equal(r.passed, true);
  r.addDiff({ name: 'hud', profile: 'desktop', ratio: 0.2, status: 'changed', sideBySide: 'x.png' });
  assert.equal(r.passed, false);
  assert.equal(r.exitCode(), 1);
});

test('toText first line is FAIL with profiles, errors listed before checks', () => {
  const r = new Report('demo', profiles);
  r.addCheck({ profile: 'desktop', step: 2, label: 'units engaged', passed: false, detail: '0' });
  r.addError({ profile: 'desktop', kind: 'pageerror', text: 'TypeError', location: 'hangar.js:212' });
  r.setSheet('D:/x/sheet.png');
  const lines = r.toText().split('\n');
  assert.equal(lines[0], 'FAIL demo (desktop, 4k)');
  const errIdx = lines.findIndex((l) => l.includes('TypeError'));
  const checkIdx = lines.findIndex((l) => l.includes('units engaged'));
  assert.ok(errIdx > 0 && checkIdx > errIdx);
  assert.equal(lines.at(-1), 'Read: D:/x/sheet.png');
});

test('toText first line is PASS when passing', () => {
  const r = new Report('demo', ['desktop']);
  assert.equal(r.toText().split('\n')[0], 'PASS demo (desktop)');
});

test('toText stays under 40 lines with 100 errors and truncates to 10', () => {
  const r = new Report('demo', profiles);
  for (let i = 0; i < 100; i++) {
    r.addError({ profile: 'desktop', kind: 'console', text: `err ${i}`, location: 'a.js:1' });
  }
  r.setSheet('sheet.png');
  const text = r.toText();
  const lines = text.split('\n');
  assert.ok(lines.length < 40, `got ${lines.length} lines`);
  assert.ok(text.includes('err 9'));
  assert.ok(!text.includes('err 10 '));
  assert.ok(text.includes('…and 90 more'));
});

test('toText includes gpu renderer, layout problems and diffs', () => {
  const r = new Report('demo', profiles);
  r.setGpu({ renderer: 'ANGLE (NVIDIA)', software: false });
  r.addLayout({ profile: '4k', kind: 'hscroll', selector: 'body', detail: 'page 2240px wide' });
  r.addDiff({ name: 'hud', profile: 'desktop', ratio: 0.1234, status: 'changed', sideBySide: 'hud-diff.png' });
  const text = r.toText();
  assert.ok(text.includes('ANGLE (NVIDIA)'));
  assert.ok(text.includes('page 2240px wide'));
  assert.ok(text.includes('hud-diff.png'));
});

test('toJSON carries every record', () => {
  const r = new Report('demo', profiles);
  r.addShot({ name: 'home', profile: 'desktop', path: 'a.png' });
  r.addError({ profile: 'desktop', kind: 'console', text: 't', location: 'l' });
  r.setSheet('s.png');
  const j = r.toJSON();
  assert.equal(j.name, 'demo');
  assert.deepEqual(j.profiles, profiles);
  assert.equal(j.passed, false);
  assert.equal(j.shots.length, 1);
  assert.equal(j.errors.length, 1);
  assert.equal(j.sheet, 's.png');
});

test('EyesError carries an exit code', () => {
  const e = new EyesError('bad', 3);
  assert.equal(e.exitCode, 3);
  assert.equal(e.message, 'bad');
  assert.ok(e instanceof Error);
});

test('makeRunDir makes unique folders in a spaced path within one second', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'with space '));
  try {
    const now = new Date(2026, 9, 18, 14, 5, 9);
    const a = makeRunDir(root, 'demo', now);
    const b = makeRunDir(root, 'demo', now);
    const c = makeRunDir(root, 'demo', now);
    assert.equal(path.basename(a), '20261018-140509-demo');
    assert.equal(path.basename(b), '20261018-140509-demo-2');
    assert.equal(path.basename(c), '20261018-140509-demo-3');
    for (const d of [a, b, c]) assert.ok(fs.statSync(d).isDirectory());
    assert.equal(path.dirname(a), path.join(root, '.eyes', 'runs'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('multi-line text is collapsed so each item is one line and output stays under 40 lines', () => {
  const stack = Array.from({ length: 30 }, (_, i) => `    at frame${i} (file.js:${i})`).join('\n');
  const r = new Report('demo', profiles);
  r.addError({ profile: 'desktop', kind: 'pageerror', text: `TypeError: boom\n${stack}`, location: 'a.js:1\nb.js:2' });
  r.addCheck({ profile: 'desktop', step: 1, label: 'multi\nline label', passed: false, detail: stack });
  r.addLayout({ profile: '4k', kind: 'hscroll', selector: 'body', detail: stack });
  r.setSheet('sheet.png');
  const lines = r.toText().split('\n');
  assert.ok(lines.length < 40, `got ${lines.length} lines`);
  // header + error + check + layout + Read = 5 lines, one per item
  assert.equal(lines.length, 5);
  assert.ok(lines[1].startsWith('error '));
  assert.ok(lines[2].startsWith('check failed '));
  assert.ok(lines[3].startsWith('layout '));
  assert.ok(lines.every((l) => l.length <= 260), 'each line is bounded');
  assert.ok(lines[1].includes('TypeError: boom at frame0'));
  assert.ok(lines[1].includes('…'));
});

test('100 items in every section still stays under 40 lines', () => {
  const r = new Report('demo', profiles);
  r.setGpu({ renderer: 'ANGLE', software: true });
  for (let i = 0; i < 100; i++) {
    r.addError({ profile: 'desktop', kind: 'console', text: `err ${i}`, location: 'a.js:1' });
    r.addCheck({ profile: 'desktop', step: i, label: `check ${i}`, passed: false, detail: 'd' });
    r.addLayout({ profile: '4k', kind: 'hscroll', selector: `el${i}`, detail: 'wide' });
    r.addDiff({ name: `shot${i}`, profile: 'desktop', ratio: 0.5, status: 'changed', sideBySide: `s${i}.png` });
  }
  r.setSheet('sheet.png');
  const lines = r.toText().split('\n');
  assert.ok(lines.length < 40, `got ${lines.length} lines`);
  assert.equal(lines[0], 'FAIL demo (desktop, 4k)');
  assert.equal(lines.at(-1), 'Read: sheet.png');
  assert.ok(lines.some((l) => l.includes('…and 95 more') || l.includes('…and 90 more') || l.includes('…and 97 more') || l.includes('…and 99 more')));
});

test('a browser or server error is an environment failure: exit 3, and the text says the page is not to blame', () => {
  for (const kind of ['browser', 'server']) {
    const r = new Report('demo', profiles);
    r.addCheck({ profile: 'desktop', step: 1, label: 'x', passed: false });
    r.addError({ profile: 'desktop', kind, text: 'died' });
    assert.equal(r.passed, false);
    assert.equal(r.exitCode(), 3, kind);
    assert.equal(r.toJSON().environmentFailure, true);
    assert.match(r.toText(), /Environment failure \(exit 3\)/);
  }
  const page = new Report('demo', profiles);
  page.addError({ profile: 'desktop', kind: 'exception', text: 'boom' });
  assert.equal(page.exitCode(), 1);
  assert.doesNotMatch(page.toText(), /Environment failure/);
});

test('rollback removes everything recorded since mark', () => {
  const r = new Report('demo', profiles);
  r.addShot({ name: 'a', profile: 'desktop', path: 'a.png' });
  const mark = r.mark();
  r.addShot({ name: 'b', profile: '4k', path: 'b.png' });
  r.addError({ profile: '4k', kind: 'exception', text: 'closed' });
  r.addCheck({ profile: '4k', step: 1, label: 'x', passed: false });
  r.addLayout({ profile: '4k', kind: 'hscroll', selector: 'body' });
  r.addNote('n');
  assert.equal(r.since(mark).problems, true);
  r.rollback(mark);
  assert.deepEqual(r.shots.map((s) => s.name), ['a']);
  assert.equal(r.errors.length + r.checks.length + r.layout.length + r.notes.length, 0);
  assert.equal(r.since(r.mark()).problems, false);
});

test('the GPU line says when the headed off-screen fallback is in use', () => {
  const r = new Report('demo', profiles);
  r.setGpu({ renderer: 'ANGLE (AMD)', software: false, headed: true });
  assert.match(r.toText(), /^GPU: ANGLE \(AMD\) \(headed off-screen fallback\)$/m);
  r.setGpu({ renderer: 'ANGLE (AMD)', software: false, headed: false });
  assert.doesNotMatch(r.toText(), /fallback/);
});
