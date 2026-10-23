import './setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { BrowserSession, captureEach } from '../src/web/session.mjs';
import { captureProfile, finishRun } from '../src/web/capture.mjs';
import { Report } from '../src/report.mjs';
import { resolveProfiles } from '../src/profiles.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const eyes = path.join(here, '..', 'bin', 'eyes.mjs');
const OK = pathToFileURL(path.join(here, 'fixtures', 'ok.html')).href;
const APP = path.join(here, 'fixtures', 'app.html').replaceAll('\\', '/');

let root;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'eyes-session-'));
});
after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// Kills Chromium's whole process tree, as a crash or an outside kill would.
async function killChromium(browser) {
  const cdp = await browser.newBrowserCDPSession();
  const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
  const pid = processInfo.find((p) => p.type === 'browser').id;
  if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
  else process.kill(pid, 'SIGKILL');
  return pid;
}

// Two profiles of `look`; kills Chromium at the start of the second profile `kills` times.
async function lookWithKills(kills) {
  const runDir = fs.mkdtempSync(path.join(root, 'run-'));
  const profiles = resolveProfiles(['laptop', 'desktop']);
  const report = new Report('kill', profiles.map((p) => p.name));
  const session = await BrowserSession.open();
  session.saveLogIn(runDir);
  let left = kills;
  try {
    const shotsByProfile = await captureEach({
      session,
      profiles,
      report,
      capture: async (browser, profile) => {
        if (profile.name === 'desktop' && left > 0) {
          left -= 1;
          await killChromium(browser);
        }
        return captureProfile({ browser, profile, report, runDir, url: OK }, async (page, tools) => {
          await tools.shot('look');
          await tools.layout();
        });
      },
    });
    return { report, runDir, shotsByProfile };
  } finally {
    await session.close();
  }
}

test('Chromium killed between profiles: relaunched, the profile runs again, and the run passes', async () => {
  const { report, runDir, shotsByProfile } = await lookWithKills(1);
  assert.deepEqual(report.errors, []);
  assert.equal(report.exitCode(), 0, JSON.stringify(report.toJSON()));
  assert.deepEqual(report.shots.map((s) => s.profile), ['laptop', 'desktop']);
  assert.equal(shotsByProfile[1].length, 1);
  assert.ok(report.notes.some((n) => /Chromium died during desktop; it was restarted/.test(n)), report.notes.join('\n'));
  const log = fs.readFileSync(path.join(runDir, 'browser.log'), 'utf8');
  assert.match(log, /===== launch 1 \(headless\) =====/);
  assert.match(log, /===== launch 2 \(headless\) =====/);
});

test('Chromium killed again on the retry: a browser error, exit 3, and never a page exception', async () => {
  const { report, runDir } = await lookWithKills(2);
  assert.deepEqual(report.errors.map((e) => e.kind), ['browser']);
  assert.match(report.errors[0].text, /Chromium died twice during desktop/);
  assert.equal(report.exitCode(), 3);
  const code = await finishRun({ report, runDir, shotsByProfile: [[], []] });
  assert.equal(code, 3);
  assert.ok(fs.existsSync(path.join(runDir, 'browser.log')));
});

test('a clean run writes browser.log with Chromium\'s own output', async () => {
  const { runDir } = await lookWithKills(0);
  const log = fs.readFileSync(path.join(runDir, 'browser.log'), 'utf8');
  assert.match(log, /===== launch 1 \(headless\) =====\n\[\d+:\d+:/);
});

// A .mjs scenario that kills Chromium from inside the desktop profile, while its page is open,
// as many times as the counter file allows.
function killerProject(kills) {
  const proj = fs.mkdtempSync(path.join(root, 'proj-'));
  const dir = path.join(proj, '.eyes');
  fs.mkdirSync(dir);
  const counter = path.join(dir, 'kills.txt').replaceAll('\\', '/');
  fs.writeFileSync(counter, String(kills));
  const file = path.join(dir, 'killer.mjs');
  fs.writeFileSync(
    file,
    [
      "import fs from 'node:fs';",
      "import { spawnSync } from 'node:child_process';",
      `export const config = { url: ${JSON.stringify(`file:///${APP}`)}, views: ['laptop', 'desktop'] };`,
      'export default async (page, eyes) => {',
      `  const left = Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8'));`,
      "  if (eyes.profile.name === 'desktop' && left > 0) {",
      `    fs.writeFileSync(${JSON.stringify(counter)}, String(left - 1));`,
      '    const cdp = await page.context().browser().newBrowserCDPSession();',
      "    const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');",
      "    const pid = processInfo.find((p) => p.type === 'browser').id;",
      "    spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });",
      '  }',
      "  await eyes.shot('after');",
      "  eyes.check('ready', await page.evaluate(() => window.__eyes.ready));",
      '};',
      '',
    ].join('\n'),
  );
  return { proj, file };
}

function runCli(file) {
  const result = spawnSync(process.execPath, [eyes, 'run', file], { encoding: 'utf8', timeout: 240000 });
  const runs = path.join(path.dirname(file), 'runs');
  const runDir = path.join(runs, fs.readdirSync(runs)[0]);
  return { ...result, runDir, report: JSON.parse(fs.readFileSync(path.join(runDir, 'report.json'), 'utf8')) };
}

test('eyes run: Chromium killed mid-profile is retried and passes (exit 0)', { skip: process.platform !== 'win32' }, () => {
  const { file } = killerProject(1);
  const r = runCli(file);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.report.errors, []);
  assert.deepEqual(r.report.checks.map((c) => [c.profile, c.passed]), [['laptop', true], ['desktop', true]]);
  assert.match(r.stdout, /Chromium died during desktop; it was restarted/);
  assert.ok(fs.existsSync(path.join(r.runDir, 'browser.log')));
});

test('eyes run: Chromium killed mid-profile twice is exit 3 with a browser error', { skip: process.platform !== 'win32' }, () => {
  const { file } = killerProject(2);
  const r = runCli(file);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.deepEqual(r.report.errors.map((e) => e.kind), ['browser']);
  assert.equal(r.report.environmentFailure, true);
  assert.match(r.stdout, /Environment failure \(exit 3\)/);
});
