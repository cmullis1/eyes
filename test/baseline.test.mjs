import './setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { compare, diffShots } from '../src/baseline.mjs';
import { Report } from '../src/report.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const eyes = path.join(here, '..', 'bin', 'eyes.mjs');

let root;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'eyes baseline-'));
});
after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// A white image with blue rectangles, written as a PNG. rects: [x, y, w, h]
async function image(name, { width = 200, height = 100, rects = [] } = {}) {
  const data = Buffer.alloc(width * height * 4, 255);
  for (const [rx, ry, rw, rh] of rects) {
    for (let y = ry; y < ry + rh; y++) {
      for (let x = rx; x < rx + rw; x++) {
        const i = (y * width + x) * 4;
        data[i] = 20;
        data[i + 1] = 60;
        data[i + 2] = 200;
      }
    }
  }
  const file = path.join(root, name);
  await sharp(data, { raw: { width, height, channels: 4 } }).png().toFile(file);
  return file;
}

test('identical images are the same, with ratio 0 and no diff file', async () => {
  const a = await image('same-a.png', { rects: [[10, 10, 40, 20]] });
  const b = await image('same-b.png', { rects: [[10, 10, 40, 20]] });
  const result = await compare(a, b);
  assert.equal(result.status, 'same');
  assert.equal(result.ratio, 0);
  assert.equal(result.diffPath, undefined);
});

test('a one-pixel change under maxRatio is still the same', async () => {
  const a = await image('px-a.png', { rects: [[10, 10, 40, 20]] });
  const b = await image('px-b.png', { rects: [[10, 10, 40, 20], [150, 80, 1, 1]] });
  const result = await compare(a, b);
  assert.equal(result.status, 'same');
  assert.ok(result.ratio > 0 && result.ratio <= 0.002, `ratio ${result.ratio}`);
});

test('a moved button is changed, with a side-by-side image beside the current shot', async () => {
  const a = await image('move-a.png', { rects: [[10, 10, 40, 20]] });
  const b = await image('move-b.png', { rects: [[120, 60, 40, 20]] });
  const result = await compare(a, b);
  assert.equal(result.status, 'changed');
  assert.ok(result.ratio > 0.002);
  assert.ok(result.diffPath && fs.existsSync(result.diffPath));
  assert.equal(path.dirname(result.diffPath), path.dirname(b));
  const meta = await sharp(result.diffPath).metadata();
  assert.ok(meta.width > 3 * 100, 'before, after and difference sit side by side');
});

test('different sizes are changed with ratio 1 and still get a side-by-side', async () => {
  const a = await image('size-a.png', { width: 200, height: 100 });
  const b = await image('size-b.png', { width: 200, height: 140 });
  const result = await compare(a, b);
  assert.equal(result.status, 'changed');
  assert.equal(result.ratio, 1);
  assert.ok(result.diffPath && fs.existsSync(result.diffPath));
});

test('changes inside a mask box are ignored; changes outside it are not', async () => {
  const a = await image('mask-a.png', { rects: [[10, 10, 40, 20]] });
  const b = await image('mask-b.png', { rects: [[10, 10, 40, 20], [100, 40, 60, 30]] });
  const masked = await compare(a, b, { maskBoxes: [{ x: 90, y: 30, width: 80, height: 50 }] });
  assert.equal(masked.status, 'same');
  assert.equal(masked.ratio, 0);

  const partial = await compare(a, b, { maskBoxes: [{ x: 0, y: 0, width: 50, height: 50 }] });
  assert.equal(partial.status, 'changed');
});

test('threshold and maxRatio are options', async () => {
  const a = await image('opt-a.png', { rects: [[10, 10, 40, 20]] });
  const b = await image('opt-b.png', { rects: [[10, 10, 40, 20], [100, 40, 20, 10]] });
  assert.equal((await compare(a, b)).status, 'changed');
  assert.equal((await compare(a, b, { maxRatio: 0.5 })).status, 'same');
});

// ---- command line -------------------------------------------------------------------------

const PAGE = (color, text, hue = 120) => `<!doctype html><html><head><meta charset="utf-8"><title>Diff page</title>
<style>body{margin:0;font:32px Arial,sans-serif;background:#fff}
#hero{margin:40px;padding:40px;background:${color};color:#fff;border-radius:12px}
#clock{margin:40px;height:300px;background:hsl(${hue},70%,50%)}</style></head>
<body><div id="hero">${text}</div><div id="clock"></div></body></html>`;

// A project with a scenario that takes one shot at the desktop profile.
function project({ mask = false } = {}) {
  const proj = fs.mkdtempSync(path.join(root, 'proj-'));
  fs.mkdirSync(path.join(proj, '.eyes'));
  const page = path.join(proj, 'page.html');
  fs.writeFileSync(page, PAGE('#2a5d9f', 'Hello Eyes'));
  const scenario = path.join(proj, '.eyes', 'hero.yaml');
  fs.writeFileSync(
    scenario,
    `name: hero\nurl: "../page.html"\nviews: [desktop]\n${mask ? 'mask: ["#clock"]\n' : ''}steps:\n  - shot: { name: top }\n`,
  );
  return { proj, page, scenario };
}

function cli(args, { env = {}, drop = [] } = {}) {
  const base = { ...process.env };
  for (const key of drop) delete base[key];
  return spawnSync(process.execPath, [eyes, ...args], {
    encoding: 'utf8',
    timeout: 240000,
    env: { ...base, ...env },
  });
}

const baselineFile = (proj) => path.join(proj, '.eyes', 'baselines', 'hero', 'top@desktop.png');
const pendingFile = (proj) => path.join(proj, '.eyes', 'baselines', '.pending', 'hero', 'top@desktop.png');
const HUMAN = { drop: ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID'] };

test('diff without a baseline reports new and passes; --update writes only to .pending', () => {
  const { proj, scenario } = project();
  const first = cli(['diff', scenario]);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /diff \[desktop\] top: new \(no baseline\)/);
  assert.ok(!fs.existsSync(baselineFile(proj)));
  assert.ok(!fs.existsSync(pendingFile(proj)), 'no --update, nothing written');

  const second = cli(['diff', scenario, '--update']);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.match(second.stdout, /Pending: 1 images?\. A person accepts them with: eyes accept hero/);
  assert.ok(fs.existsSync(pendingFile(proj)));
  assert.ok(!fs.existsSync(baselineFile(proj)), 'accepted baselines are untouched');
});

test('accept refuses inside Claude Code (exit 2) and moves nothing; a person moves the files', () => {
  const { proj, scenario } = project();
  assert.equal(cli(['diff', scenario, '--update']).status, 0);
  assert.ok(fs.existsSync(pendingFile(proj)));

  const refused = cli(['accept', 'hero', '--out', proj], { env: { CLAUDECODE: '1' } });
  assert.equal(refused.status, 2, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /eyes accept is for you to run in your own terminal after looking at the pending images/);
  assert.ok(fs.existsSync(pendingFile(proj)));
  assert.ok(!fs.existsSync(baselineFile(proj)));

  const sessionOnly = cli(['accept', 'hero', '--out', proj], { env: { CLAUDE_CODE_SESSION_ID: 'abc' }, drop: ['CLAUDECODE'] });
  assert.equal(sessionOnly.status, 2);
  assert.ok(fs.existsSync(pendingFile(proj)));

  const listed = cli(['accept', 'hero', '--list', '--out', proj], HUMAN);
  assert.equal(listed.status, 0, listed.stdout + listed.stderr);
  assert.match(listed.stdout, /top@desktop\.png/);
  assert.ok(fs.existsSync(pendingFile(proj)), '--list moves nothing');

  const accepted = cli(['accept', 'hero', '--out', proj], HUMAN);
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  assert.ok(fs.existsSync(baselineFile(proj)));
  assert.ok(!fs.existsSync(pendingFile(proj)));
  assert.match(accepted.stdout, /Accepted 1 image/);
});

test('accept with nothing pending is a usage error', () => {
  const { proj } = project();
  const r = cli(['accept', 'hero', '--out', proj], HUMAN);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /No pending images for hero/);
});

test('a changed page fails with a side-by-side in the contact sheet; --update proposes it as pending', async () => {
  const { proj, page, scenario } = project();
  assert.equal(cli(['diff', scenario, '--update']).status, 0);
  assert.equal(cli(['accept', 'hero', '--out', proj], HUMAN).status, 0);

  const same = cli(['diff', scenario]);
  assert.equal(same.status, 0, same.stdout + same.stderr);
  assert.doesNotMatch(same.stdout, /diff \[/);

  fs.writeFileSync(page, PAGE('#b3402a', 'Hello Changed Eyes'));
  const changed = cli(['diff', scenario, '--update']);
  assert.equal(changed.status, 1, changed.stdout + changed.stderr);
  assert.match(changed.stdout, /diff \[desktop\] top: changed \d+\.\d\d% -> .*top.*\.png/);
  assert.match(changed.stdout, /Pending: 1 images?/);
  assert.ok(changed.stdout.trim().split('\n').length < 40);
  const read = /^Read: (.+)$/m.exec(changed.stdout);
  assert.ok(read, 'a contact sheet path is printed');
  assert.ok(fs.existsSync(read[1]));

  const runs = fs.readdirSync(path.join(proj, '.eyes', 'runs'));
  const report = JSON.parse(fs.readFileSync(path.join(proj, '.eyes', 'runs', runs.at(-1), 'report.json'), 'utf8'));
  assert.equal(report.diffs.length, 1);
  assert.equal(report.diffs[0].status, 'changed');
  assert.ok(fs.existsSync(report.diffs[0].sideBySide));
  assert.ok(fs.existsSync(pendingFile(proj)), 'the changed image is waiting for a person');
  const accepted = await sharp(baselineFile(proj)).stats();
  const pending = await sharp(pendingFile(proj)).stats();
  assert.notDeepEqual(accepted.channels.map((c) => c.mean), pending.channels.map((c) => c.mean));
});

test('scenario mask hides a changing region from the comparison', () => {
  const { proj, page, scenario } = project({ mask: true });
  assert.equal(cli(['diff', scenario, '--update']).status, 0);
  assert.equal(cli(['accept', 'hero', '--out', proj], HUMAN).status, 0);

  // Only the #clock block changes, and it is big enough to fail the comparison unmasked.
  fs.writeFileSync(page, PAGE('#2a5d9f', 'Hello Eyes', 300));
  const r = cli(['diff', scenario]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('a URL or file target uses look\'s capture and names the baselines after the run name', () => {
  const proj = fs.mkdtempSync(path.join(root, 'look-'));
  const page = path.join(proj, 'landing.html');
  fs.writeFileSync(page, PAGE('#2a5d9f', 'Static'));
  const r = cli(['diff', page, '--views', 'desktop', '--name', 'landing', '--update', '--out', proj]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.existsSync(path.join(proj, '.eyes', 'baselines', '.pending', 'landing', 'look@desktop.png')));
  assert.match(r.stdout, /eyes accept landing/);
});

test('diff --update from a failing run proposes nothing and says so', () => {
  const { proj, page, scenario } = project();
  fs.writeFileSync(page, PAGE('#2a5d9f', 'Hello Eyes').replace('</body>', '<script>console.error("broken build")</script></body>'));
  const r = cli(['diff', scenario, '--update']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /run failed; nothing proposed/);
  assert.doesNotMatch(r.stdout, /Pending:/);
  assert.ok(!fs.existsSync(pendingFile(proj)), 'a failing run must not propose baselines');
});

test('diffShots with update writes nothing pending when the report already failed (check, error or layout)', async () => {
  const { proj } = project();
  const shot = path.join(proj, 'shot.png');
  await sharp({ create: { width: 8, height: 8, channels: 4, background: '#fff' } }).png().toFile(shot);
  const shotsByProfile = [[{ name: 'top', profile: 'desktop', path: shot, maskBoxes: [] }]];
  const failures = [
    (r) => r.addCheck({ profile: 'desktop', step: 1, label: 'x', passed: false }),
    (r) => r.addError({ profile: 'desktop', kind: 'console', text: 'boom' }),
    (r) => r.addLayout({ profile: 'desktop', kind: 'hscroll', selector: 'body' }),
  ];
  for (const fail of failures) {
    const report = new Report('hero', ['desktop']);
    fail(report);
    const result = await diffShots({ projectRoot: proj, scenario: 'hero', shotsByProfile, report, update: true });
    assert.equal(result.pending, 0);
    assert.equal(result.refused, true);
    assert.ok(!fs.existsSync(pendingFile(proj)));
  }
});
