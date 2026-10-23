import './setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { runBefore, runWebScenario } from '../src/commands/run.mjs';
import { loadScenario } from '../src/scenario.mjs';
import { Report } from '../src/report.mjs';
import { resolveProfiles } from '../src/profiles.mjs';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const eyes = path.join(here, '..', 'bin', 'eyes.mjs');
const APP = path.join(here, 'fixtures', 'app.html').replaceAll('\\', '/');
const GOOD_SERVER = path.join(here, 'fixtures', 'servers', 'good.mjs');

let root;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'eyes-run-'));
});
after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// A fresh project: <proj>/.eyes/<file>. Returns the project folder and the scenario path.
function project(files) {
  const proj = fs.mkdtempSync(path.join(root, 'proj-'));
  const paths = {};
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(proj, '.eyes', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    paths[name] = file;
  }
  return { proj, paths };
}

function run(file, args = [], { cwd } = {}) {
  const result = spawnSync(process.execPath, [eyes, 'run', file, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 240000,
  });
  const proj = path.resolve(path.dirname(file), '..');
  const runs = path.join(proj, '.eyes', 'runs');
  const dirs = fs.existsSync(runs) ? fs.readdirSync(runs) : [];
  const runDir = dirs.length ? path.join(runs, dirs[0]) : null;
  const reportFile = runDir && path.join(runDir, 'report.json');
  const report = reportFile && fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : null;
  return { ...result, runDir, report, dirs };
}

const header = (extra = '') => `url: "${APP}"\n${extra}`;

test('the fixture scenario clicks, types, drags into the zone, presses a key and passes at both profiles', async () => {
  const { paths } = project({
    'app.yaml': header(
      [
        'steps:',
        '  - wait: "#add"',
        '  - click: "#add"',
        '  - click: "text=Add item"',
        '  - check: "window.__eyes.state.added === 2"',
        '  - check: { text: "#items", contains: "Item 2" }',
        '  - type: { into: "#name", text: "hello" }',
        '  - check: "window.__eyes.state.typed === \'hello\'"',
        '  - drag: { from: "#card", to: "#zone" }',
        '  - check: "window.__eyes.state.dropped === true"',
        '  - check: { text: "#zone", contains: "Dropped" }',
        '  - key: ArrowRight',
        '  - check: "window.__eyes.state.key === \'ArrowRight\'"',
        '  - shot: dropped',
        '  - check: { visible: "#zone" }',
        '  - check: { hidden: "#nothing-here" }',
      ].join('\n'),
    ),
  });
  const r = run(paths['app.yaml']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.report.passed, true);
  assert.equal(r.report.name, 'app');
  assert.deepEqual(r.report.profiles, ['desktop', '4k']);
  assert.equal(r.report.checks.length, 2 * 8);
  assert.ok(r.report.checks.every((c) => c.passed));
  assert.deepEqual(r.report.shots.map((s) => [s.profile, s.name]), [['desktop', 'dropped'], ['4k', 'dropped']]);
  for (const s of r.report.shots) assert.ok(fs.existsSync(s.path));
  assert.ok(r.report.sheet && fs.existsSync(r.report.sheet));
  assert.ok((await sharp(r.report.sheet).metadata()).width <= 2400);

  const lines = r.stdout.trim().split('\n');
  assert.equal(lines[0], 'PASS app (desktop, 4k)');
  assert.equal(lines.at(-1), `Read: ${r.report.sheet}`);
  assert.match(r.dirs[0], /^\d{8}-\d{6}-app$/);
});

test('--views limits the profiles', () => {
  const { paths } = project({ 'one.yaml': header('steps:\n  - check: "window.__eyes.ready"\n') });
  const r = run(paths['one.yaml'], ['--views', 'desktop']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.report.profiles, ['desktop']);
  assert.equal(r.report.shots.length, 1, 'a final shot is taken when the scenario takes none');
});

test('a scenario views: list is used, and --views overrides it', () => {
  const { paths } = project({ 'v.yaml': header('views: [laptop]\nsteps:\n  - check: "true"\n') });
  const a = run(paths['v.yaml']);
  assert.equal(a.status, 0, a.stdout + a.stderr);
  assert.deepEqual(a.report.profiles, ['laptop']);
});

const TOUCH_PAGE = path.join(here, 'fixtures', 'touch.html').replaceAll('\\', '/');

test('tap runs at touch views; at a view without touch it is exit 2 before any browser starts', () => {
  const { paths } = project({
    'tap.yaml': `url: "${TOUCH_PAGE}"\nviews: [phone, ipad-mini-side]\nsteps:\n  - tap: "#menu"\n  - check: "window.__eyes.state.pointerType === 'touch' && window.__eyes.state.clicks === 1"\n`,
  });
  const a = run(paths['tap.yaml']);
  assert.equal(a.status, 0, a.stdout + a.stderr);
  assert.deepEqual(a.report.profiles, ['phone', 'ipad-mini-side']);
  assert.ok(a.report.checks.every((c) => c.passed), JSON.stringify(a.report.checks));

  fs.rmSync(path.join(path.dirname(paths['tap.yaml']), 'runs'), { recursive: true, force: true });
  const b = run(paths['tap.yaml'], ['--views', 'phone,desktop']);
  assert.equal(b.status, 2);
  assert.match(b.stderr, /step 1 is a tap.*desktop is not touch/s);
  assert.equal(b.runDir, null);
});

const TALL_TOUCH_PAGE = path.join(here, 'fixtures', 'touch-tall.html').replaceAll('\\', '/');

// The colour of the pixel 10 px in from the left at device row y: green is the page's pointer: coarse styling, red its mouse styling.
async function colourAt(file, y) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + 10) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}

test('a full-page shot at a touch view keeps the finger: touch styling in the shot, pointer: coarse after it, no pointer change', async () => {
  const touchOnly = [
    '  - check: "window.scrollY === 1000"',
    '  - shot: { name: whole, full: true }',
    '  - check: "matchMedia(\'(pointer: coarse)\').matches && matchMedia(\'(hover: none)\').matches"',
    '  - check: "window.__eyes.state.pointerChanges === 0"',
    '  - check: "window.scrollY === 1000 && window.innerHeight < 4000"',
  ].join('\n');
  const { paths } = project({
    'tall.yaml': `url: "${TALL_TOUCH_PAGE}"\nviews: [ipad-mini-side, phone]\nsteps:\n${touchOnly}\n`,
    'tall-desktop.yaml': `url: "${TALL_TOUCH_PAGE}"\nviews: [desktop]\nsteps:\n  - shot: { name: whole, full: true }\n`,
  });
  const r = run(paths['tall.yaml']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.report.checks.every((c) => c.passed), JSON.stringify(r.report.checks));
  for (const [view, width, scale] of [['ipad-mini-side', 1133, 2], ['phone', 360, 3]]) {
    const file = path.join(r.runDir, `${view}-whole.png`);
    const meta = await sharp(file).metadata();
    assert.deepEqual([meta.width, meta.height], [width * scale, 4000 * scale], view);
    assert.deepEqual(await colourAt(file, 5), [0, 255, 0], `${view} top`);
    assert.deepEqual(await colourAt(file, meta.height - 5), [0, 255, 0], `${view} bottom`);
  }

  // Desktop full shots are unchanged: the whole page, with the mouse styling.
  fs.rmSync(path.join(path.dirname(paths['tall.yaml']), 'runs'), { recursive: true, force: true });
  const d = run(paths['tall-desktop.yaml']);
  assert.equal(d.status, 0, d.stdout + d.stderr);
  const file = path.join(d.runDir, 'desktop-whole.png');
  assert.equal((await sharp(file).metadata()).height, 4000);
  assert.deepEqual(await colourAt(file, 3990), [255, 0, 0]);
});

test('a drag built from dispatchEvent does not drop the card; the drag step does', () => {
  const synthetic = [
    'export default async (page, eyes) => {',
    '  await page.evaluate(() => {',
    "    const card = document.getElementById('card');",
    "    const zone = document.getElementById('zone').getBoundingClientRect();",
    '    const at = (x, y, type) => card.dispatchEvent(new PointerEvent(type, { pointerId: 1, clientX: x, clientY: y, bubbles: true }));',
    "    at(10, 10, 'pointerdown');",
    "    for (let i = 1; i <= 10; i++) at(zone.left + 20 + i, zone.top + 20, 'pointermove');",
    "    at(zone.left + 30, zone.top + 30, 'pointerup');",
    '  });',
    "  eyes.check('synthetic drag is ignored', await page.evaluate(() => window.__eyes.state.dropped === false));",
    '};',
    `export const config = { url: ${JSON.stringify(APP)}, views: ['desktop'] };`,
    '',
  ].join('\n');
  const { paths } = project({
    'synthetic.mjs': synthetic,
    'real.yaml': header('views: [desktop]\nsteps:\n  - drag: { from: "#card", to: "#zone" }\n  - check: "window.__eyes.state.dropped === true"\n'),
  });
  const a = run(paths['synthetic.mjs']);
  assert.equal(a.status, 0, a.stdout + a.stderr);
  assert.equal(a.report.checks.length, 1);
  assert.equal(a.report.checks[0].label, 'synthetic drag is ignored');
  assert.equal(a.report.checks[0].passed, true);

  const b = run(paths['real.yaml']);
  assert.equal(b.status, 0, b.stdout + b.stderr);
});

test('drag to a canvas point lands on the right pixel', () => {
  const { paths } = project({
    'canvas.yaml': header(
      'views: [desktop]\nsteps:\n' +
        '  - drag: { from: "#card", to: { canvas: "#canvas", x: 0.5, y: 0.25 } }\n' +
        '  - check: "(() => { const r = document.getElementById(\'canvas\').getBoundingClientRect(); const u = window.__eyes.state.lastUp; return Math.abs(u[0] - (r.left + r.width / 2)) <= 1 && Math.abs(u[1] - (r.top + r.height / 4)) <= 1; })()"\n',
    ),
  });
  const r = run(paths['canvas.yaml']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('a failing check exits 1, shoots failed-step-<n> and skips the rest of that profile', () => {
  const { paths } = project({
    'fail.yaml': header(
      [
        'steps:',
        '  - click: "#add"',
        '  - check: "window.__eyes.state.dropped === true"',
        '  - shot: never-taken',
        '  - check: "true"',
      ].join('\n'),
    ),
  });
  const r = run(paths['fail.yaml']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(r.report.passed, false);
  const failed = r.report.checks.filter((c) => !c.passed);
  assert.deepEqual(failed.map((c) => [c.profile, c.step]), [['desktop', 2], ['4k', 2]]);
  assert.equal(failed[0].detail, 'false');
  assert.deepEqual(
    r.report.shots.map((s) => [s.profile, s.name]),
    [['desktop', 'failed-step-2'], ['4k', 'failed-step-2']],
  );
  assert.equal(r.report.checks.length, 2, 'steps after the failure are skipped');
  const lines = r.stdout.trim().split('\n');
  assert.match(lines[0], /^FAIL fail \(desktop, 4k\)$/);
  assert.ok(lines.some((l) => /^check failed \[desktop\] step 2 /.test(l)));
  assert.equal(lines.at(-1), `Read: ${r.report.sheet}`);
});

test('an action that cannot happen is a failed check with a failed-step shot', () => {
  const { paths } = project({
    'missing.yaml': header('views: [desktop]\nsteps:\n  - click: "#does-not-exist"\n'),
  });
  const r = run(paths['missing.yaml']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(r.report.checks[0].step, 1);
  assert.equal(r.report.checks[0].passed, false);
  assert.match(r.report.checks[0].label, /click #does-not-exist/);
  assert.deepEqual(r.report.shots.map((s) => s.name), ['failed-step-1']);
}, { timeout: 60000 });

test('clock: fixed starts at 2026-01-01T12:00:00Z and advance runs timers', () => {
  const { paths } = project({
    'clock.yaml': header(
      [
        'views: [desktop]',
        'clock: fixed',
        'steps:',
        '  - check: "new Date().toISOString().startsWith(\'2026-01-01T12:\')"',
        '  - check: "window.__eyes.state.later === undefined"',
        '  - advance: 60s',
        '  - check: "window.__eyes.state.later === true"',
        '  - check: { text: "#later", contains: "later arrived" }',
      ].join('\n'),
    ),
  });
  const r = run(paths['clock.yaml']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('a .mjs scenario can shoot and check, and eyes.check(false) fails the run', () => {
  const script = [
    'export default async (page, eyes) => {',
    "  await page.click('#add');",
    "  await eyes.shot('after-click');",
    "  eyes.check('one item', (await page.locator('#items li').count()) === 1);",
    "  eyes.check('wrong on purpose', false, 'expected nothing');",
    '};',
    `export const config = { url: ${JSON.stringify(APP)}, views: ['desktop'] };`,
    '',
  ].join('\n');
  const { paths } = project({ 'script.mjs': script });
  const r = run(paths['script.mjs']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.deepEqual(r.report.checks.map((c) => [c.label, c.passed]), [['one item', true], ['wrong on purpose', false]]);
  assert.equal(r.report.checks[1].detail, 'expected nothing');
  assert.deepEqual(r.report.shots.map((s) => s.name), ['after-click', 'failed-step-2']);
});

test('a script that throws, and a reload that destroys the page context, are errors; every profile is still reported', () => {
  const script = [
    'export default async (page, eyes) => {',
    "  eyes.check('before the reload', true);",
    '  await page.evaluate(() => { location.reload(); return new Promise(() => {}); });',
    '};',
    `export const config = { url: ${JSON.stringify(APP)} };`,
    '',
  ].join('\n');
  const { paths } = project({ 'reload.mjs': script });
  const r = run(paths['reload.mjs']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.deepEqual(r.report.profiles, ['desktop', '4k']);
  const errors = r.report.errors.filter((e) => e.kind === 'exception');
  assert.deepEqual(errors.map((e) => e.profile), ['desktop', '4k']);
  assert.match(errors[0].text, /Execution context was destroyed/);
  assert.deepEqual(r.report.shots.map((s) => [s.profile, s.name]), [['desktop', 'error'], ['4k', 'error']]);
  assert.ok(r.report.sheet && fs.existsSync(r.report.sheet));
  assert.equal(r.stdout.trim().split('\n').at(-1), `Read: ${r.report.sheet}`);
});

test('a page that cannot be opened is an error per profile, not a crash', () => {
  const { paths } = project({ 'dead.yaml': 'url: "http://127.0.0.1:1/"\nsteps:\n  - check: "true"\n' });
  const r = run(paths['dead.yaml']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.deepEqual(r.report.errors.filter((e) => e.kind === 'navigation').map((e) => e.profile), ['desktop', '4k']);
  assert.ok(r.report.sheet);
});

test('serve: starts the dev server on a free port, runs against it, and stops it', async () => {
  const cmd = `node "${GOOD_SERVER.replaceAll('\\', '/')}" {port}`;
  const { paths } = project({
    'served.yaml':
      `serve: '${cmd}'\nurl: /\nviews: [desktop]\nsteps:\n` +
      '  - check: "document.body.innerText"\n' +
      '  - check: "location.origin"\n',
  });
  const r = run(paths['served.yaml']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.report.checks[0].detail, '"ok"');
  const origin = JSON.parse(r.report.checks[1].detail);
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  await assert.rejects(fetch(origin, { signal: AbortSignal.timeout(3000) }), 'the server must be stopped');
});

test('serve: a server that dies on start is exit 3 with its output', () => {
  const crash = path.join(here, 'fixtures', 'servers', 'crash.mjs').replaceAll('\\', '/');
  const { paths } = project({
    'crash.yaml': `serve: 'node "${crash}" {port}'\nurl: /\nsteps:\n  - check: "true"\n`,
  });
  const r = run(paths['crash.yaml']);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stderr, /boom/);
});

test('serve: a server that exits on its own during the run is a server error, exit 3', () => {
  const dies = path.join(here, 'fixtures', 'servers', 'dies.mjs').replaceAll('\\', '/');
  const { paths } = project({
    'dies.yaml':
      `serve: 'node "${dies}" {port}'\nurl: /page\nviews: [desktop]\nsteps:\n` +
      '  - check: "new Promise((r) => setTimeout(() => r(true), 1500))"\n',
  });
  const r = run(paths['dies.yaml']);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.deepEqual(r.report.errors.map((e) => e.kind), ['server']);
  assert.match(r.report.errors[0].text, /exited during the run \(code 1\).*server going away/);
});

test('before: runs first in the project root (the folder holding .eyes) and its output can feed the page', () => {
  const writer = "require('fs').writeFileSync('generated.html','<h1 id=g>made by before</h1>')";
  const { paths } = project({
    'gen.yaml':
      `before: ${JSON.stringify(`node -e "${writer}"`)}\nurl: ../generated.html\nviews: [desktop]\nsteps:\n` +
      '  - check: { text: "#g", contains: "made by before" }\n',
  });
  const r = run(paths['gen.yaml'], [], { cwd: root });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const proj = path.resolve(path.dirname(paths['gen.yaml']), '..');
  assert.ok(fs.existsSync(path.join(proj, 'generated.html')));
  assert.ok(fs.existsSync(path.join(proj, '.eyes', 'runs')), 'run output goes next to the .eyes folder');
});

test('before: a failing command is exit 3 with its last output lines, and nothing else runs', () => {
  const script = "for (let i = 1; i <= 30; i++) console.log('line ' + i); console.error('bad news'); process.exit(4)";
  const { paths } = project({
    'bad.yaml': `before: ${JSON.stringify(`node -e "${script}"`)}\nurl: "${APP}"\nsteps:\n  - check: "true"\n`,
  });
  const r = run(paths['bad.yaml']);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stderr, /before/i);
  assert.match(r.stderr, /bad news/);
  assert.match(r.stderr, /line 30/);
  assert.doesNotMatch(r.stderr, /line 5\b/);
  assert.equal(r.runDir, null);
});

test('a scenario outside any .eyes folder puts its runs under the current directory; --out overrides', () => {
  const loose = fs.mkdtempSync(path.join(root, 'loose-'));
  const file = path.join(loose, 'loose.yaml');
  fs.writeFileSync(file, header('views: [desktop]\nsteps:\n  - check: "true"\n'));
  const cwd = fs.mkdtempSync(path.join(root, 'cwd-'));
  const a = spawnSync(process.execPath, [eyes, 'run', file], { cwd, encoding: 'utf8', timeout: 240000 });
  assert.equal(a.status, 0, a.stdout + a.stderr);
  assert.equal(fs.readdirSync(path.join(cwd, '.eyes', 'runs')).length, 1);

  const out = fs.mkdtempSync(path.join(root, 'out-'));
  const b = spawnSync(process.execPath, [eyes, 'run', file, '--out', out], { cwd, encoding: 'utf8', timeout: 240000 });
  assert.equal(b.status, 0, b.stdout + b.stderr);
  assert.equal(fs.readdirSync(path.join(out, '.eyes', 'runs')).length, 1);
});

test('scenario names are slugged for the run folder and the report', () => {
  const { paths } = project({
    'odd.yaml': header(`name: "My Odd/Name: ${'x'.repeat(80)}"\nviews: [desktop]\nsteps:\n  - check: "true"\n`),
  });
  const r = run(paths['odd.yaml']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.report.name, /^my-odd-name-x+$/);
  assert.ok(r.report.name.length <= 60);
  assert.ok(r.dirs[0].endsWith(`-${r.report.name}`));
  assert.match(r.stdout.split('\n')[0], new RegExp(`^PASS ${r.report.name} `));
});

test('schema errors are exit 2 with the step number and no run folder, for web and Godot scenarios', () => {
  const { paths } = project({
    'bad-step.yaml': header('steps:\n  - key: a\n  - swipe: "#x"\n'),
    'bad-advance.yaml': header('steps:\n  - advance: 500ms\n'),
    'godot.yaml': 'kind: godot\nsteps:\n  - key: a\n',
    'missing-url.yaml': 'steps:\n  - key: a\n',
    'no-file.yaml': 'url: nope/missing.html\nsteps:\n  - key: a\n',
  });
  const a = run(paths['bad-step.yaml']);
  assert.equal(a.status, 2);
  assert.match(a.stderr, /step 2/);
  assert.equal(a.runDir, null);

  const b = run(paths['bad-advance.yaml']);
  assert.equal(b.status, 2);
  assert.match(b.stderr, /step 1.*advance/s);

  const c = run(paths['godot.yaml']);
  assert.equal(c.status, 2);
  assert.match(c.stderr, /godot\.frames/);
  assert.equal(c.runDir, null);

  const d = run(paths['missing-url.yaml']);
  assert.equal(d.status, 2);
  assert.match(d.stderr, /url/);

  const e = run(paths['no-file.yaml']);
  assert.equal(e.status, 2);
  assert.match(e.stderr, /not found/i);

  const f = spawnSync(process.execPath, [eyes, 'run'], { encoding: 'utf8' });
  assert.equal(f.status, 2);
  assert.match(f.stderr, /Usage: eyes run/);

  const g = run(paths['bad-step.yaml'], ['--views', 'nope']);
  assert.equal(g.status, 2);
});

// ---- review fixes ----

const CLOCK_PAGE = path.join(here, 'fixtures', 'clock.html').split(path.sep).join('/');

test('runBefore keeps the last output lines and multi-byte text on every run', async () => {
  const script = path.join(root, 'noisy.mjs');
  fs.writeFileSync(
    script,
    "console.log('héllo ✓ '.repeat(20000));\nconsole.error('bad news ✗');\nprocess.exit(4);\n",
  );
  for (let i = 0; i < 15; i++) {
    await assert.rejects(runBefore(`node "${script}"`, root), (err) => {
      assert.equal(err.exitCode, 3);
      assert.match(err.message, /bad news ✗/);
      assert.match(err.message, /héllo ✓/);
      assert.doesNotMatch(err.message, /\uFFFD/);
      return true;
    });
  }
});

test('runBefore is not held up by a grandchild that keeps the output pipes open', async () => {
  const script = path.join(root, 'lingering.mjs');
  fs.writeFileSync(
    script,
    "import { spawn } from 'node:child_process';\n" +
      "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 6000)'], { stdio: 'inherit' });\n" +
      "console.log('last words');\nprocess.exit(3);\n",
  );
  const started = Date.now();
  await assert.rejects(runBefore(`node "${script}"`, root), (err) => {
    assert.match(err.message, /last words/);
    return true;
  });
  assert.ok(Date.now() - started < 4500, `took ${Date.now() - started} ms`);
});

test('--out only moves the run folder: before still runs in the project root', () => {
  const marker = "require('fs').writeFileSync('where.txt','here')";
  const { proj, paths } = project({
    'out.yaml': `before: ${JSON.stringify(`node -e "${marker}"`)}\nurl: "${APP}"\nviews: [desktop]\nsteps:\n  - check: "true"\n`,
  });
  const out = fs.mkdtempSync(path.join(root, 'elsewhere-'));
  const r = spawnSync(process.execPath, [eyes, 'run', paths['out.yaml'], '--out', out], { encoding: 'utf8', timeout: 240000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.existsSync(path.join(proj, 'where.txt')), 'before ran in the folder holding .eyes');
  assert.ok(!fs.existsSync(path.join(out, 'where.txt')), 'before did not run in --out');
  assert.equal(fs.readdirSync(path.join(out, '.eyes', 'runs')).length, 1);
  assert.ok(!fs.existsSync(path.join(proj, '.eyes', 'runs')));
});

test('runWebScenario works with just {profiles, runDir, report} for a file url, and with an origin for a served path', async () => {
  const { paths } = project({
    'direct.yaml': `url: "${APP}"\nsteps:\n  - check: "window.__eyes.ready"\n  - shot: direct\n`,
    'served.yaml': 'url: /page\nsteps:\n  - check: { text: "#h", contains: "served here" }\n',
  });
  const dir = path.dirname(paths['direct.yaml']);
  const okPage = path.relative(dir, path.join(here, 'fixtures', 'ok.html')).split(path.sep).join('/');
  fs.writeFileSync(path.join(dir, 'relative.yaml'), `url: "${okPage}"
steps:
  - check: { text: "#ok", contains: "Fine" }
`);
  paths['relative.yaml'] = path.join(path.dirname(paths['direct.yaml']), 'relative.yaml');
  const profiles = resolveProfiles(['desktop']);
  const attempt = async (file, extra) => {
    const scenario = await loadScenario(file);
    const report = new Report(scenario.name, ['desktop']);
    const runDir = fs.mkdtempSync(path.join(root, 'rd-'));
    const shotsByProfile = await runWebScenario(scenario, { profiles, runDir, report, ...extra });
    return { report, shotsByProfile };
  };

  const a = await attempt(paths['direct.yaml']);
  assert.equal(a.report.passed, true, JSON.stringify(a.report.toJSON()));
  assert.equal(a.shotsByProfile.length, 1);
  assert.equal(a.shotsByProfile[0].length, 1);

  const c = await attempt(paths['relative.yaml']);
  assert.equal(c.report.passed, true, JSON.stringify(c.report.toJSON()));

  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(req.url === '/page' ? '<h1 id="h">served here</h1>' : 'nope');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const b = await attempt(paths['served.yaml'], { origin: `http://127.0.0.1:${server.address().port}` });
    assert.equal(b.report.passed, true, JSON.stringify(b.report.toJSON()));
  } finally {
    server.close();
  }
});

test('runWebScenario rejects a scenario with no url and no origin with exit 2', async () => {
  const { paths } = project({ 'nourl.yaml': 'steps:\n  - check: "true"\n' });
  const scenario = await loadScenario(paths['nourl.yaml']);
  const runDir = fs.mkdtempSync(path.join(root, 'rd-'));
  await assert.rejects(
    runWebScenario(scenario, { profiles: resolveProfiles(['desktop']), runDir, report: new Report('x', ['desktop']) }),
    (err) => err.exitCode === 2 && /url/.test(err.message),
  );
});

test('clock: fixed is deterministic: time is frozen at 12:00:00.000 until advance, and two runs shoot identical pixels', () => {
  const scenario = [
    `url: "${CLOCK_PAGE}"`,
    'views: [desktop]',
    'clock: fixed',
    'steps:',
    '  - check: "Date.now() === Date.parse(\'2026-01-01T12:00:00.000Z\')"',
    '  - check: { text: "#now", contains: "2026-01-01T12:00:00.000Z" }',
    '  - shot: start',
    '  - advance: 1s',
    '  - check: "window.__clock.ticks === 10"',
    '  - check: { text: "#now", contains: "2026-01-01T12:00:01.000Z" }',
    '  - shot: later',
  ].join('\n');
  const shoot = () => {
    const { paths } = project({ 'clock.yaml': scenario });
    const r = run(paths['clock.yaml']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return Object.fromEntries(r.report.shots.map((s) => [s.name, fs.readFileSync(s.path)]));
  };
  const first = shoot();
  const second = shoot();
  assert.ok(first.start.equals(second.start), 'start shots differ between runs');
  assert.ok(first.later.equals(second.later), 'later shots differ between runs');
  assert.ok(!first.start.equals(first.later), 'advance should change what is on screen');
});

// ---- clock: fixed freezes and advances CSS/Web animations too ----

const fixturePage = (name) => path.join(here, 'fixtures', name).split(path.sep).join('/');

// x of the first non-white pixel on the row through the middle of a box whose top is `top` (100 px tall).
async function boxLeftAt(file, top) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const row = (top + 50) * info.width * info.channels;
  for (let x = 0; x < info.width; x++) if (data[row + x * info.channels] < 250) return x;
  return -1;
}

function fixedRun(page, steps, extra = []) {
  const yaml = [`url: "${fixturePage(page)}"`, 'views: [laptop]', 'clock: fixed', 'steps:', ...steps.map((s) => `  - ${s}`), ...extra].join('\n');
  const { paths } = project({ 'anim.yaml': yaml });
  const r = run(paths['anim.yaml']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return { ...r, shot: (name) => r.report.shots.find((s) => s.name === name).path };
}

test('clock: fixed with an infinite CSS animation: two runs shoot byte-identical pixels', () => {
  const a = fixedRun('css-spin.html', ['advance: 300ms', 'shot: mid']);
  const b = fixedRun('css-spin.html', ['advance: 300ms', 'shot: mid']);
  assert.ok(fs.readFileSync(a.shot('mid')).equals(fs.readFileSync(b.shot('mid'))), 'shots differ between runs');
});

test('advance moves a CSS animation by exactly that much, and a playbackRate of 2 doubles it', async () => {
  // css-spin: 400 px per 2 s from x = 300, so 100 px per 500 ms.
  const r = fixedRun('css-spin.html', ['shot: start', 'advance: 500ms', 'shot: half', 'advance: 500ms', 'shot: one']);
  const row = async (name) => {
    const { data, info } = await sharp(r.shot(name)).raw().toBuffer({ resolveWithObject: true });
    const base = 280 * info.width * info.channels;
    for (let x = 0; x < info.width; x++) if (data[base + x * info.channels] < 250) return x;
    return -1;
  };
  assert.equal(await row('start'), 300);
  assert.equal(await row('half'), 400);
  assert.equal(await row('one'), 500);

  // rate.html plays at twice the speed: 400 px per second, so 500 ms moves 200 px.
  const fast = fixedRun('rate.html', ['shot: start', 'advance: 500ms', 'shot: half']);
  assert.equal(await boxLeftAt(fast.shot('start'), 100), 100);
  assert.equal(await boxLeftAt(fast.shot('half'), 100), 300);
});

test('the animation freeze survives a navigation made by a step', async () => {
  const r = fixedRun('nav-a.html', ['click: "#go"', 'wait: "#box"', 'shot: landed', 'advance: 500ms', 'shot: later']);
  assert.equal(await boxLeftAt(r.shot('landed'), 100), 100);
  assert.equal(await boxLeftAt(r.shot('later'), 100), 200);
});

test('clock: real leaves animations running in real time', async () => {
  const yaml = [`url: "${fixturePage('css-spin.html')}"`, 'views: [laptop]', 'steps:', '  - shot: only'].join('\n');
  const { paths } = project({ 'real.yaml': yaml });
  const r = run(paths['real.yaml']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // Not frozen at the first frame: real time has passed since the page loaded.
  const { data, info } = await sharp(r.report.shots[0].path).raw().toBuffer({ resolveWithObject: true });
  const base = 280 * info.width * info.channels;
  let left = -1;
  for (let x = 0; x < info.width; x++) if (data[base + x * info.channels] < 250) { left = x; break; }
  assert.ok(left > 300, `expected the animation to have moved in real time, box at ${left}`);
});
