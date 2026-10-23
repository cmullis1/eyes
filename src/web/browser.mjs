// Chromium launch with GPU detection, and per-profile pages that feed the run report.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EyesError } from '../report.mjs';
import { trackNetwork } from './ready.mjs';

// Browsers live next to the package (<eyes root>/browsers) in development and when installed.
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'browsers',
  );
}

const { chromium } = await import('playwright');

const GPU_ARGS = ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];
// Beyond any monitor, but not -32000: Windows uses that position for minimised windows.
const OFF_SCREEN = '--window-position=-16000,-16000';
const SOFTWARE = /SwiftShader|llvmpipe|Software|Microsoft Basic Render/i;
const FAVICON = /\/favicon\.ico(\?|$)/i;
const HTTP_STATUS_NOTE = /^Failed to load resource: the server responded with a status of \d+/;
const NOT_INSTALLED = 'Chromium not installed; run eyes/install.mjs';
// The first stack frame's location: "at fn (url:line:col)" or "at url:line:col".
const STACK_FRAME = /^\s*at (?:.*? \()?(.+?:\d+:\d+)\)?\s*$/m;

// logFile: where Chromium writes its own log (its browser, GPU and renderer processes all append to it).
async function start({ headed, logFile }) {
  const args = [...GPU_ARGS, ...(headed ? [OFF_SCREEN] : []), ...(logFile ? ['--enable-logging', `--log-file=${logFile}`] : [])];
  try {
    // channel 'chromium' selects the new headless mode (the full browser), not the headless shell.
    return await chromium.launch(
      headed ? { headless: false, args } : { headless: true, channel: 'chromium', args },
    );
  } catch (err) {
    if (/Executable doesn't exist|playwright install/i.test(err.message)) {
      throw new EyesError(NOT_INSTALLED, 3);
    }
    throw new EyesError(`Chromium would not start: ${String(err.message).split('\n')[0]}`, 3);
  }
}

async function readRenderer(browser) {
  const page = await browser.newPage();
  try {
    await page.goto('about:blank');
    const renderer = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl');
      if (!gl) return '';
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
    });
    const text = renderer || 'unavailable (WebGL context could not be created)';
    return { renderer: text, software: !renderer || SOFTWARE.test(renderer) };
  } finally {
    await page.close();
  }
}

// Headless first. When headless only has software rendering, a real window parked off screen
// (the headed fallback) is tried; gpu.headed says which one is in use.
// logFile(mode): a path for that launch's Chromium log, or undefined for none.
// forceHeaded (EYES_FORCE_HEADED=1) goes straight to the headed fallback, to test it.
export async function launch({ logFile = () => undefined, forceHeaded = process.env.EYES_FORCE_HEADED === '1' } = {}) {
  let headless = null;
  let gpu = null;
  if (!forceHeaded) {
    headless = await start({ headed: false, logFile: logFile('headless') });
    try {
      gpu = await readRenderer(headless);
      if (!gpu.software) return { browser: headless, gpu: { ...gpu, headed: false } };
    } catch (err) {
      await headless.close().catch(() => {});
      throw err;
    }
  }
  let headed = null;
  try {
    headed = await start({ headed: true, logFile: logFile('headed') });
    const headedGpu = await readRenderer(headed);
    if (forceHeaded || !headedGpu.software) {
      await headless?.close().catch(() => {});
      return { browser: headed, gpu: { ...headedGpu, headed: true } };
    }
  } catch {
    // Headed launch is an optimisation; fall through to software headless.
  }
  await headed?.close().catch(() => {});
  if (!headless) {
    headless = await start({ headed: false, logFile: logFile('headless') });
    try {
      gpu = await readRenderer(headless);
    } catch (err) {
      await headless.close().catch(() => {});
      throw err;
    }
  }
  return { browser: headless, gpu: { ...gpu, headed: false } };
}

// "url:line:col" of the innermost frame of an error's stack, when it has one.
export function stackLocation(stack) {
  const lines = String(stack ?? '').split('\n').slice(1).join('\n');
  return STACK_FRAME.exec(lines)?.[1];
}

export async function openPage(browser, profile, report) {
  const context = await browser.newContext({
    viewport: { width: profile.width, height: profile.height },
    deviceScaleFactor: profile.deviceScaleFactor,
    // Touch views emulate a phone or tablet: the page sees pointer: coarse and hover: none.
    ...(profile.touch ? { hasTouch: true, isMobile: true } : {}),
  });
  context.setDefaultTimeout(30000);
  context.setDefaultNavigationTimeout(30000);
  const page = await context.newPage();
  trackNetwork(page);

  const add = (kind, text, location) =>
    report.addError({ profile: profile.name, kind, text, location });

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const loc = msg.location();
    // Chrome's generic note for an HTTP error status; the response listener below
    // reports the same failure with its status and URL, so skip it here.
    if (HTTP_STATUS_NOTE.test(msg.text())) return;
    if (FAVICON.test(loc?.url ?? '')) return;
    add('console', msg.text(), loc?.url ? `${loc.url}:${loc.lineNumber}` : undefined);
  });
  page.on('pageerror', (err) => add('pageerror', err.message, stackLocation(err.stack)));
  page.on('requestfailed', (req) => {
    const url = req.url();
    if (FAVICON.test(url)) return;
    add('requestfailed', `${req.method()} ${url} ${req.failure()?.errorText ?? 'failed'}`, url);
  });
  page.on('response', (res) => {
    const url = res.url();
    if (res.status() < 400 || FAVICON.test(url)) return;
    add('requestfailed', `${res.status()} ${res.request().method()} ${url}`, url);
  });
  return page;
}
