import './setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { launch, openPage } from '../src/web/browser.mjs';
import { waitReady, ReadyTimeout } from '../src/web/ready.mjs';
import { Report } from '../src/report.mjs';
import { resolveProfiles } from '../src/profiles.mjs';
import { runSteps } from '../src/web/steps.mjs';
import { captureProfile } from '../src/web/capture.mjs';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');
const profile = { name: '4k', width: 2194, height: 1105, deviceScaleFactor: 1.75 };

let server;
let base;
let browser;
let gpu;
const sockets = new Set();

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/hang') {
      // Never answered: stands in for a websocket or long poll.
      return;
    }
    if (url.pathname === '/reset.png' || url.pathname === '/favicon.ico') {
      req.socket.destroy();
      return;
    }
    const file = path.join(fixtures, path.basename(url.pathname));
    if (url.pathname.endsWith('.html') && fs.existsSync(file)) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(fs.readFileSync(file));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  ({ browser, gpu } = await launch());
});

after(async () => {
  try {
    await browser?.close();
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function withPage(fn, view = profile) {
  const report = new Report('web-test', [view]);
  const page = await openPage(browser, view, report);
  try {
    return await fn(page, report);
  } finally {
    await page.context().close();
  }
}

test('launch returns a browser and a non-empty renderer string', () => {
  console.log(`WebGL renderer: ${gpu.renderer} (software: ${gpu.software})`);
  assert.equal(typeof gpu.renderer, 'string');
  assert.ok(gpu.renderer.length > 0);
  assert.equal(typeof gpu.software, 'boolean');
});

test('openPage applies viewport and device scale factor', async () => {
  await withPage(async (page) => {
    await page.goto(`${base}/ok.html`);
    const m = await page.evaluate(() => ({
      w: window.innerWidth,
      h: window.innerHeight,
      dpr: window.devicePixelRatio,
    }));
    assert.deepEqual(m, { w: 2194, h: 1105, dpr: 1.75 });
  });
});

test('errors.html yields console, pageerror and requestfailed, tagged with the profile', async () => {
  await withPage(async (page, report) => {
    await page.goto(`${base}/errors.html`);
    await waitReady(page);
    const kinds = new Set(report.errors.map((e) => e.kind));
    assert.deepEqual([...kinds].sort(), ['console', 'pageerror', 'requestfailed']);
    for (const e of report.errors) assert.equal(e.profile, '4k');
    assert.ok(report.errors.some((e) => e.kind === 'console' && /boom-console/.test(e.text)));
    assert.ok(report.errors.some((e) => e.kind === 'pageerror' && /boom-thrown/.test(e.text)));
    assert.ok(report.errors.some((e) => e.kind === 'requestfailed' && /reset\.png/.test(e.text)));
  });
});

test('a page error carries file:line:col from the first frame of its stack', async () => {
  await withPage(async (page, report) => {
    await page.goto(`${base}/errors.html`);
    await waitReady(page);
    const thrown = report.errors.find((e) => e.kind === 'pageerror' && /boom-thrown/.test(e.text));
    assert.ok(thrown, JSON.stringify(report.errors));
    assert.equal(thrown.location, `${base}/errors.html:10:26`);
  });
});

test('HTTP 404 is one requestfailed entry (status + URL), with no duplicate console entry', async () => {
  await withPage(async (page, report) => {
    await page.goto(`${base}/errors.html`);
    await waitReady(page);
    const missing = report.errors.filter((e) => /missing\.png/.test(e.text) || /missing\.png/.test(e.location ?? ''));
    assert.equal(missing.length, 1, JSON.stringify(missing));
    assert.equal(missing[0].kind, 'requestfailed');
    assert.equal(missing[0].profile, '4k');
    assert.equal(missing[0].text, `404 GET ${base}/missing.png`);
    assert.equal(missing[0].location, `${base}/missing.png`);
    assert.equal(report.errors.filter((e) => /Failed to load resource: the server responded/.test(e.text)).length, 0);
    assert.ok(report.errors.some((e) => e.kind === 'requestfailed' && /reset\.png/.test(e.text)));
  });
});

test('a 404 favicon.ico is not reported in either path', async () => {
  await withPage(async (page, report) => {
    await page.goto(`${base}/ok.html`);
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          const img = new Image();
          img.onload = img.onerror = () => resolve(true);
          img.src = '/sub/favicon.ico';
        }),
    );
    await waitReady(page);
    assert.deepEqual(report.errors, []);
  });
});

test('favicon.ico failures are not reported', async () => {
  await withPage(async (page, report) => {
    await page.goto(`${base}/ok.html`);
    await page.evaluate(() => fetch('/favicon.ico').catch(() => {}));
    await waitReady(page);
    assert.equal(report.errors.filter((e) => /favicon/.test(e.text)).length, 0);
  });
});

test('websocket.html (request open forever) becomes ready in under 8 s', async () => {
  await withPage(async (page) => {
    const t0 = Date.now();
    await page.goto(`${base}/websocket.html`);
    await waitReady(page);
    const took = Date.now() - t0;
    assert.ok(took < 8000, `took ${took} ms`);
  });
});

test('quiet page becomes ready quickly and a late selector is awaited', async () => {
  await withPage(async (page) => {
    const t0 = Date.now();
    await page.goto(`${base}/ok.html`);
    await waitReady(page, { selector: '#late' });
    assert.ok(Date.now() - t0 < 4000);
    assert.equal(await page.locator('#late').count(), 1);
  });
});

test('missing selector throws ReadyTimeout within the timeout budget', async () => {
  await withPage(async (page) => {
    const t0 = Date.now();
    await page.goto(`${base}/never.html`);
    await assert.rejects(
      () => waitReady(page, { selector: '#never', timeoutMs: 2000 }),
      (err) => err instanceof ReadyTimeout && /#never/.test(err.message),
    );
    const took = Date.now() - t0;
    assert.ok(took < 4000, `took ${took} ms`);
  });
});

test('launch reports exit code 3 when Chromium is not installed', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'eyes-nobrowser-'));
  try {
    const script = `
      import { launch } from ${JSON.stringify(new URL('../src/web/browser.mjs', import.meta.url).href)};
      try { const r = await launch(); await r.browser.close(); console.log('LAUNCHED'); }
      catch (e) { console.log(JSON.stringify({ name: e.name, code: e.exitCode, message: e.message })); }
    `;
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: empty },
      encoding: 'utf8',
      timeout: 60000,
    });
    const result = JSON.parse(out.stdout.trim().split('\n').pop());
    assert.equal(result.name, 'EyesError');
    assert.equal(result.code, 3);
    assert.equal(result.message, 'Chromium not installed; run eyes/install.mjs');
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('forced headed fallback: renders in a window parked off screen (not the minimised spot), and closes it', async () => {
  const { browser: headed, gpu: headedGpu } = await launch({ forceHeaded: true });
  let pid;
  try {
    assert.equal(headedGpu.headed, true);
    const cdp = await headed.newBrowserCDPSession();
    pid = (await cdp.send('SystemInfo.getProcessInfo')).processInfo.find((p) => p.type === 'browser').id;
    const report = new Report('headed', [profile.name]);
    const page = await openPage(headed, { name: 'laptop', width: 800, height: 600, deviceScaleFactor: 1 }, report);
    await page.goto(`${base}/ok.html`);
    await waitReady(page);
    const where = await page.evaluate(() => ({ x: window.screenX, y: window.screenY, visible: document.visibilityState }));
    assert.deepEqual(where, { x: -16000, y: -16000, visible: 'visible' });
    const png = await page.screenshot();
    const sharp = (await import('sharp')).default;
    const { channels } = await sharp(png).stats();
    assert.ok(channels.some((c) => c.max - c.min > 50), 'the shot has content');
    await page.context().close();
  } finally {
    await headed.close();
  }
  if (process.platform === 'win32') {
    const left = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' }).stdout;
    assert.doesNotMatch(left, new RegExp(`\\b${pid}\\b`), 'the headed Chromium is gone after close');
  }
});

test('EYES_FORCE_HEADED=1 eyes look passes and its GPU line names the headed fallback', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'eyes-headed-'));
  try {
    const r = spawnSync(process.execPath, [path.join(here, '..', 'bin', 'eyes.mjs'), 'look', path.join(fixtures, 'ok.html'), '--views', 'laptop', '--out', out], {
      env: { ...process.env, EYES_FORCE_HEADED: '1' },
      encoding: 'utf8',
      timeout: 120000,
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^GPU: .*\(headed off-screen fallback\)$/m);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('a page with window.__eyes.ready is waited for until it says true', async () => {
  await withPage(async (page) => {
    const t0 = Date.now();
    await page.goto(`${base}/late-ready.html`);
    await waitReady(page);
    assert.ok(Date.now() - t0 >= 1400, `ready after ${Date.now() - t0} ms`);
    assert.equal(await page.evaluate(() => window.__eyes.ready), true);
    assert.equal(await page.locator('#state').innerText(), 'ready');
  });
});

test('a page whose window.__eyes.ready never turns true is a ReadyTimeout that names it', async () => {
  await withPage(async (page) => {
    await page.goto(`${base}/late-ready.html?never`);
    await assert.rejects(
      () => waitReady(page, { timeoutMs: 2000 }),
      (err) => err instanceof ReadyTimeout && /window\.__eyes\.ready/.test(err.message),
    );
  });
});

const [phone, ipadSide, desktop] = resolveProfiles(['phone', 'ipad-mini-side', 'desktop']);

const media = (page) =>
  page.evaluate(() => ({
    coarse: matchMedia('(pointer: coarse)').matches,
    hoverNone: matchMedia('(hover: none)').matches,
    w: window.innerWidth,
    h: window.innerHeight,
    dpr: window.devicePixelRatio,
    touchPoints: navigator.maxTouchPoints,
  }));

test('a touch view emulates a touch device: pointer: coarse and hover: none, at its viewport and scale', async () => {
  await withPage(async (page) => {
    await page.goto(`${base}/touch.html`);
    const m = await media(page);
    assert.equal(m.coarse, true);
    assert.equal(m.hoverNone, true);
    assert.ok(m.touchPoints > 0, `maxTouchPoints ${m.touchPoints}`);
    assert.deepEqual([m.w, m.h, m.dpr], [360, 780, 3]);
  }, phone);
  await withPage(async (page) => {
    await page.goto(`${base}/touch.html`);
    const m = await media(page);
    assert.deepEqual([m.coarse, m.hoverNone, m.w, m.h, m.dpr], [true, true, 1133, 744, 2]);
  }, ipadSide);
});

test('desktop is not a touch device: pointer: coarse and hover: none are both false', async () => {
  await withPage(async (page) => {
    await page.goto(`${base}/touch.html`);
    const m = await media(page);
    assert.equal(m.coarse, false);
    assert.equal(m.hoverNone, false);
    assert.equal(m.touchPoints, 0);
    assert.deepEqual([m.w, m.h, m.dpr], [2560, 1311, 1]);
  }, desktop);
});

function stepTools() {
  const shots = [];
  return { shots, tools: { shot: async (name) => { shots.push(name); } } };
}

test('a tap step is a real finger: touchstart, a touch pointer and a click', async () => {
  await withPage(async (page, report) => {
    await page.goto(`${base}/touch.html`);
    const { tools } = stepTools();
    const ok = await runSteps(page, [{ type: 'tap', value: '#menu' }], { profile: phone, report, tools });
    assert.equal(ok, true);
    const state = await page.evaluate(() => window.__eyes.state);
    assert.deepEqual(state, { pointerType: 'touch', touches: 1, clicks: 1 });
  }, phone);
});

test('a tap step at a view without touch is a failed check that says so, with a failed-step shot', async () => {
  await withPage(async (page, report) => {
    await page.goto(`${base}/touch.html`);
    const { shots, tools } = stepTools();
    const ok = await runSteps(page, [{ type: 'tap', value: '#menu' }], { profile: desktop, report, tools });
    assert.equal(ok, false);
    assert.equal(report.checks.length, 1);
    assert.equal(report.checks[0].passed, false);
    assert.match(report.checks[0].detail, /tap needs a touch view, and desktop is not one/);
    assert.deepEqual(shots, ['failed-step-1']);
    assert.equal(await page.evaluate(() => window.__eyes.state.clicks), 0);
  }, desktop);
});

// bands.html: a 60px sticky blue header, then 100px bands coloured by their index. Returns the first
// row (sampled every 7 device px) that does not show the band the page has at that height, or null.
async function firstWrongRow(file, scale) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  for (let y = 60 * scale + 5; y < info.height; y += 7) {
    const css = y / scale;
    const inside = (css - 60) % 100;
    if (inside < 2 || inside > 98) continue; // band edges blend
    const band = Math.floor((css - 60) / 100);
    const i = (y * info.width + 5) * info.channels;
    if (data[i + 2] !== 128 || data[i] !== band % 250 || data[i + 1] !== Math.floor(band / 250) * 40) {
      return `row ${y} shows rgb(${data[i]}, ${data[i + 1]}, ${data[i + 2]}), not band ${band}`;
    }
  }
  return null;
}

async function tallShot(view, height) {
  const [shotProfile] = resolveProfiles([view]);
  const report = new Report('tall', [shotProfile]);
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eyes-tall-'));
  const [shot] = await captureProfile(
    { browser, profile: shotProfile, report, runDir, url: `${base}/bands.html?height=${height}` },
    async (page, tools) => {
      await tools.shot('whole', { full: true });
    },
  );
  const meta = await sharp(shot.path).metadata();
  const wrong = await firstWrongRow(shot.path, shotProfile.deviceScaleFactor);
  return { size: [meta.width, meta.height], wrong, notes: report.notes, errors: report.errors };
}

test('a full-page shot taller than one capture (16,384 device px) shows the whole page once, in order, at phone, desktop and 4k', async () => {
  for (const [view, height, size] of [
    ['phone', 6000, [1080, 18180]], // 18,180 device px at scale 3
    ['desktop', 17000, [2560, 17060]],
    ['4k', 10000, [3840, 17605]], // a fractional scale: tiles must meet exactly
  ]) {
    const shot = await tallShot(view, height);
    assert.deepEqual(shot.errors, [], view);
    assert.deepEqual(shot.size, size, view);
    assert.equal(shot.wrong, null, view);
    assert.deepEqual(shot.notes, [], view);
  }
});

test('a page too tall for one image is cut at the top 65,535 rows, and the report says so', async () => {
  const shot = await tallShot('phone', 30000);
  assert.deepEqual(shot.size, [1080, 65535]);
  assert.equal(shot.wrong, null);
  assert.equal(shot.notes.length, 1);
  assert.match(shot.notes[0], /30060px tall at phone; its full-page shot shows the top 21845px/);
});
