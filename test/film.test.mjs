import './setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { flickerScore, FlickerMeter, judgeFlicker } from '../src/flicker.mjs';
import { sampledFrames } from '../src/commands/film.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const eyes = path.join(here, '..', 'bin', 'eyes.mjs');
const fixture = (name) => path.join(here, 'fixtures', name);

let root;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'eyes film-'));
});
after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// A solid-colour frame with a filled rectangle, as raw RGBA.
function frame(width, height, rect) {
  const data = Buffer.alloc(width * height * 4, 255);
  if (rect) {
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        const i = (y * width + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = 0;
      }
    }
  }
  return { data, width, height };
}

test('flickerScore is 0 for a block that slides smoothly', () => {
  const frames = [0, 1, 2, 3, 4].map((n) => frame(40, 20, { x: 4 + n * 3, y: 4, w: 12, h: 12 }));
  assert.equal(flickerScore(frames), 0);
});

test('flickerScore is high when a block strobes on and off', () => {
  const frames = [0, 1, 2, 3, 4, 5].map((n) => frame(40, 20, n % 2 ? null : { x: 4, y: 4, w: 20, h: 10 }));
  const score = flickerScore(frames);
  assert.ok(score > 0.2, `expected a high score, got ${score}`);
});

test('flickerScore is 0 with fewer than three frames and rejects mixed sizes', () => {
  assert.equal(flickerScore([]), 0);
  assert.equal(flickerScore([frame(4, 4), frame(4, 4)]), 0);
  assert.throws(() => flickerScore([frame(4, 4), frame(4, 4), frame(5, 4)]), /size/i);
});

test('FlickerMeter gives the same score as flickerScore when fed frame by frame', () => {
  const frames = [0, 1, 2, 3].map((n) => frame(30, 10, n % 2 ? null : { x: 2, y: 2, w: 10, h: 5 }));
  const meter = new FlickerMeter();
  for (const f of frames) meter.push(f);
  assert.equal(meter.score(), flickerScore(frames));
});

test('a small strobing element on a big page is high: the worst tile is judged, not the whole frame', () => {
  const box = { x: 300, y: 200, w: 200, h: 200 };
  const frames = [0, 1, 2, 3, 4].map((n) => frame(2560, 1311, n % 2 ? null : box));
  const meter = new FlickerMeter();
  for (const f of frames) meter.push(f);
  const result = meter.result();
  assert.ok(result.score > 0.5, `worst tile ${result.score}`);
  assert.ok(result.frame < 0.02, `whole frame ${result.frame}`);
  assert.ok(result.tile.x >= box.x - 64 && result.tile.x < box.x + box.w, JSON.stringify(result.tile));
  assert.equal(flickerScore(frames), result.score);
  assert.equal(judgeFlicker(result.score).high, true);
});

test('fast motion is not flicker: a block that moves its own width each frame passes each pixel once', () => {
  const frames = [0, 1, 2, 3, 4, 5].map((n) => frame(400, 64, { x: n * 40, y: 10, w: 40, h: 40 }));
  assert.equal(flickerScore(frames), 0);
});

test('the flicker verdict is taken on the printed value, so 0.020 is never "above 0.020"', () => {
  assert.deepEqual(judgeFlicker(0.0204), { text: '0.020', high: false, threshold: '0.020' });
  assert.deepEqual(judgeFlicker(0.0206), { text: '0.021', high: true, threshold: '0.020' });
  assert.deepEqual(judgeFlicker(1), { text: '1.000', high: true, threshold: '0.020' });
});

function film(target, args = [], { out } = {}) {
  const outDir = out ?? fs.mkdtempSync(path.join(root, 'out-'));
  const result = spawnSync(process.execPath, [eyes, 'film', target, '--out', outDir, ...args], {
    encoding: 'utf8',
    timeout: 240000,
  });
  const runs = path.join(outDir, '.eyes', 'runs');
  const dirs = fs.existsSync(runs) ? fs.readdirSync(runs).sort() : [];
  const runDir = dirs.length ? path.join(runs, dirs[dirs.length - 1]) : null;
  const reportFile = runDir && path.join(runDir, 'report.json');
  const report = reportFile && fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : null;
  return { ...result, outDir, runDir, report, dirs };
}

const framesOf = (runDir, view) =>
  fs.readdirSync(path.join(runDir, view)).filter((f) => /^frame-\d{4}\.png$/.test(f)).sort();

test('film of a smooth animation: 10 frames, a 10-page GIF, a steady flicker score and a sheet', async () => {
  const r = film(fixture('spin.html'), ['--seconds', '1', '--fps', '10']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.runDir);

  const frames = framesOf(r.runDir, 'desktop');
  assert.equal(frames.length, 10);
  assert.equal(frames[0], 'frame-0001.png');
  assert.equal(frames[9], 'frame-0010.png');

  const gifs = fs.readdirSync(r.runDir).filter((f) => f.endsWith('.gif'));
  assert.equal(gifs.length, 1);
  const meta = await sharp(path.join(r.runDir, gifs[0]), { animated: true }).metadata();
  assert.equal(meta.pages, 10);

  assert.match(r.stdout, /flicker 0\.\d+ \(steady\)/);
  assert.match(r.stdout, /\.gif/);
  const lines = r.stdout.trim().split('\n');
  assert.ok(lines.length < 40);
  assert.match(lines.at(-1), /^Read: .*sheet\.png$/);
  assert.ok(fs.existsSync(r.report.sheet));
  assert.equal(r.report.passed, true);
  const note = r.report.notes.find((n) => n.startsWith('flicker'));
  assert.ok(Number(note.split(' ')[1]) < 0.02, note);
});

test('film of a 200x200 box strobing on the 2560x1311 desktop view fails as high', () => {
  const r = film(fixture('flicker-small.html'), ['--seconds', '1', '--fps', '20', '--views', 'desktop']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /flicker \d\.\d{3} \(high\): worst 64x64 px tile at \d+,\d+; whole frame 0\.0\d\d/);
  assert.equal(r.report.checks.find((c) => c.label === 'flicker').passed, false);
});

test('film of a strobing page fails with a high flicker score', () => {
  const r = film(fixture('flicker.html'), ['--seconds', '1', '--fps', '20', '--views', 'laptop']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /flicker \d\.\d+ \(high\)/);
  assert.match(r.stdout, /check failed \[laptop\] .*flicker/);
  assert.ok(Number(r.report.notes.find((n) => n.startsWith('flicker')).split(' ')[1]) > 0.05);
  assert.equal(r.report.checks.find((c) => c.label === 'flicker').passed, false);
  assert.match(r.stdout.trim().split('\n').at(-1), /^Read: /);
});

test('the sheet samples every ceil(n/12)-th frame, starting with the first', () => {
  assert.deepEqual(sampledFrames(1), [1]);
  assert.deepEqual(sampledFrames(10), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(sampledFrames(12), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.deepEqual(sampledFrames(30), [1, 4, 7, 10, 13, 16, 19, 22, 25, 28]);
  assert.equal(sampledFrames(60).length, 12);
  assert.ok(sampledFrames(600).length <= 12);
});

test('two runs produce byte-identical frames (JS-driven animation)', () => {
  const a = film(fixture('spin.html'), ['--seconds', '1', '--fps', '10', '--views', 'laptop']);
  const b = film(fixture('spin.html'), ['--seconds', '1', '--fps', '10', '--views', 'laptop']);
  assert.equal(a.status, 0, a.stdout + a.stderr);
  assert.equal(b.status, 0, b.stdout + b.stderr);
  const f5a = fs.readFileSync(path.join(a.runDir, 'laptop', 'frame-0005.png'));
  const f5b = fs.readFileSync(path.join(b.runDir, 'laptop', 'frame-0005.png'));
  assert.ok(f5a.equals(f5b), 'frame 5 differs between runs');
  const f1 = fs.readFileSync(path.join(a.runDir, 'laptop', 'frame-0001.png'));
  assert.ok(!f1.equals(f5a), 'frame 1 and frame 5 should differ: the page is moving');
});

// x of the first non-white pixel on the row through the middle of the box.
async function boxLeft(file) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const row = 280 * info.width * info.channels;
  for (let x = 0; x < info.width; x++) if (data[row + x * info.channels] < 250) return x;
  return -1;
}

test('a CSS animation is driven by Eyes too: exactly one frame of motion per frame, the same every run', async () => {
  const a = film(fixture('css-spin.html'), ['--seconds', '1', '--fps', '10', '--views', 'laptop']);
  const b = film(fixture('css-spin.html'), ['--seconds', '1', '--fps', '10', '--views', 'laptop']);
  assert.equal(a.status, 0, a.stdout + a.stderr);
  // The box slides 400 px in 2 s from x = 300: 20 px per 100 ms frame.
  for (const n of [1, 5, 10]) {
    const file = (r) => path.join(r.runDir, 'laptop', `frame-${String(n).padStart(4, '0')}.png`);
    assert.equal(await boxLeft(file(a)), 300 + 20 * n, `frame ${n}`);
    assert.ok(fs.readFileSync(file(a)).equals(fs.readFileSync(file(b))), `frame ${n} differs between runs`);
  }
});

// x of the first non-white pixel on the row through the middle of a box whose top is `top` (100 px tall).
async function leftAt(file, top) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const row = (top + 50) * info.width * info.channels;
  for (let x = 0; x < info.width; x++) if (data[row + x * info.channels] < 250) return x;
  return -1;
}
const frameFile = (r, n, view = 'laptop') => path.join(r.runDir, view, `frame-${String(n).padStart(4, '0')}.png`);

test('a finite entrance animation and a transition follow the film clock exactly, however slow the page setup is', async () => {
  const quick = film(pathToFileURL(fixture('entrance.html')).href, ['--seconds', '1', '--fps', '10', '--views', 'laptop']);
  const slow = film(`${pathToFileURL(fixture('entrance.html')).href}?spin=400000000`, ['--seconds', '1', '--fps', '10', '--views', 'laptop']);
  assert.equal(quick.status, 0, quick.stdout + quick.stderr);
  assert.equal(slow.status, 0, slow.stdout + slow.stderr);
  for (const n of [1, 2, 3, 4, 5, 6, 7, 10]) {
    // Entrance: 300 px in 600 ms from x = 100, one frame is 100 ms; it holds its end state after.
    assert.equal(await leftAt(frameFile(quick, n), 100), 100 + Math.min(300, 50 * n), `entrance frame ${n}`);
    // Transition: the timer fires at 200 ms (the end of frame 2); it moves 100 px a frame from frame 3 until 400 px.
    assert.equal(await leftAt(frameFile(quick, n), 300), 100 + Math.min(400, 100 * Math.max(0, n - 2)), `transition frame ${n}`);
    assert.ok(fs.readFileSync(frameFile(quick, n)).equals(fs.readFileSync(frameFile(slow, n))), `frame ${n} differs when setup is slow`);
  }
});

test('Eyes advances exactly the animations the page has running: resumed ones from the frame after, paused ones never', async () => {
  const r = film(fixture('playstate.html'), ['--seconds', '1', '--fps', '10', '--views', 'laptop']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // 20 px per 100 ms frame once running. The CSS one resumes at 300 ms, the scripted one at 500 ms.
  for (let n = 1; n <= 10; n++) {
    assert.equal(await leftAt(frameFile(r, n), 100), 100 + 20 * Math.max(0, n - 3), `resumed frame ${n}`);
    assert.equal(await leftAt(frameFile(r, n), 300), 100, `kept-paused frame ${n}`);
    assert.equal(await leftAt(frameFile(r, n), 500), 100 + 20 * Math.max(0, n - 5), `scripted frame ${n}`);
  }
});

test('a failing first step still leaves a screenshot, a sheet and exit 1', () => {
  const dir = path.join(root, 'failproj');
  fs.mkdirSync(path.join(dir, '.eyes'), { recursive: true });
  const page = fixture('spin.html').split(path.sep).join('/');
  fs.writeFileSync(path.join(dir, '.eyes', 'bad.yaml'), ['name: bad', `url: "${page}"`, 'steps:', '  - check: "false"', ''].join('\n'));
  const r = film(path.join(dir, '.eyes', 'bad.yaml'), ['--seconds', '1', '--fps', '5', '--views', 'laptop']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.ok(r.report.shots.length >= 1, 'no screenshot was taken');
  assert.match(r.stdout.trim().split('\n').at(-1), /^Read: .*sheet\.png$/);
  assert.ok(fs.existsSync(r.report.sheet));
  assert.equal(fs.existsSync(path.join(r.runDir, 'laptop')), false, 'no frames should be recorded after a failed step');
});

test('scenario steps run first, all or the first N with --after', () => {
  const dir = path.join(root, 'proj');
  fs.mkdirSync(path.join(dir, '.eyes'), { recursive: true });
  const page = fixture('clock.html').split(path.sep).join('/');
  fs.writeFileSync(
    path.join(dir, '.eyes', 'two.yaml'),
    [
      'name: two',
      `url: "${page}"`,
      'clock: fixed',
      'steps:',
      '  - advance: 500ms',
      '  - check: "window.__clock.ticks === 5"',
      '  - advance: 500ms',
      '  - check: "window.__clock.ticks === 10"',
      '',
    ].join('\n'),
  );
  const all = film(path.join(dir, '.eyes', 'two.yaml'), ['--seconds', '1', '--fps', '5', '--views', 'laptop']);
  assert.equal(all.status, 0, all.stdout + all.stderr);
  assert.equal(all.report.checks.filter((c) => c.label !== 'flicker').length, 2);
  assert.equal(framesOf(all.runDir, 'laptop').length, 5);

  const some = film(path.join(dir, '.eyes', 'two.yaml'), ['--seconds', '1', '--fps', '5', '--views', 'laptop', '--after', '2']);
  assert.equal(some.status, 0, some.stdout + some.stderr);
  assert.equal(some.report.checks.filter((c) => c.label !== 'flicker').length, 1);
});

test('usage errors are exit 2 and make no run folder', () => {
  const page = fixture('spin.html');
  const cases = [
    [['--seconds', '0'], /seconds/],
    [['--fps', 'fast'], /fps/],
    [['--fps', '60'], /fps/],
    [['--seconds', '31', '--fps', '20'], /600/],
    [['--views', 'laptop,desktop', '--seconds', '16', '--fps', '20'], /600/],
    [['--after', '1'], /--after/],
    [['--after', 'x'], /--after/],
    [['--bogus'], /bogus/],
  ];
  for (const [args, pattern] of cases) {
    const r = film(page, args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, pattern, args.join(' '));
    assert.equal(r.dirs.length, 0, `${args.join(' ')} made a run folder`);
  }
  const missing = film(path.join(root, 'nope.html'));
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /not found/i);
});
