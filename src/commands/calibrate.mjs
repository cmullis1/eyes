// eyes calibrate: the user opens a printed link in Chrome on each monitor and presses one button;
// the measured window size and device scale are stored as that monitor's display profile.

import http from 'node:http';
import { EyesError } from '../report.mjs';
import { defaultCalibrationPath, saveCalibration } from '../profiles.mjs';
import { registerCleanup } from '../serve.mjs';

const USAGE = 'Usage: eyes calibrate';
const MONITORS = ['desktop', '4k'];
const MAX_BODY_BYTES = 4096;

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Eyes calibration</title>
<style>
  body { font: 18px/1.5 system-ui, sans-serif; margin: 2rem; max-width: 40rem; }
  #size { font-size: 2rem; font-weight: 600; margin: 1rem 0; }
  button { font: inherit; padding: 0.6rem 1rem; margin: 0 0.5rem 0.5rem 0; cursor: pointer; }
  #status { margin-top: 1rem; min-height: 1.5em; }
</style>
</head>
<body>
<h1>Eyes calibration</h1>
<p>Open this page in a maximised Chrome window at 100% zoom, then press the button for the monitor it is on.</p>
<div id="size"></div>
<button id="desktop">This is my desktop monitor</button>
<button id="4k">This is my 4K monitor</button>
<div id="status"></div>
<script>
const measure = () => ({
  width: window.innerWidth,
  height: window.innerHeight,
  deviceScaleFactor: Math.round(window.devicePixelRatio * 10000) / 10000,
});
const size = document.getElementById('size');
const status = document.getElementById('status');
const show = () => {
  const m = measure();
  size.textContent = m.width + ' \\u00d7 ' + m.height + ' @ ' + m.deviceScaleFactor;
};
show();
window.addEventListener('resize', show);
for (const name of ${JSON.stringify(MONITORS)}) {
  document.getElementById(name).addEventListener('click', async () => {
    try {
      const res = await fetch('/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, ...measure() }),
      });
      const body = await res.json();
      status.textContent = res.ok ? 'Saved ' + name + ': ' + size.textContent : 'Not saved: ' + body.error;
    } catch (err) {
      status.textContent = 'Not saved: ' + err.message;
    }
  });
}
</script>
</body>
</html>
`;

function isPositive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

// Returns the validated entry, or throws an Error whose message is shown to the person.
function validateMeasurement(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('expected a JSON object with name, width, height and deviceScaleFactor');
  }
  if (!MONITORS.includes(body.name)) throw new Error(`name must be one of ${MONITORS.join(', ')}`);
  for (const key of ['width', 'height', 'deviceScaleFactor']) {
    if (!isPositive(body[key])) throw new Error(`${key} must be a positive number`);
  }
  return { name: body.name, width: body.width, height: body.height, deviceScaleFactor: body.deviceScaleFactor };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// The server alone, so it can be tested without printing or waiting. `onSaved(name)` runs after
// each measurement is stored. It listens on 127.0.0.1 only, and every request must name this
// server in its Host header (127.0.0.1:<port> or localhost:<port>): a website that rebinds its own
// name to 127.0.0.1 still sends its own name, so its script cannot reach the page or the save.
// A save must also come from this server's own page when it says where it came from (Origin).
export function createCalibrationServer({ calibrationPath = defaultCalibrationPath(), onSaved = () => {} } = {}) {
  const send = (res, status, type, body) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };
  const json = (res, status, value) => send(res, status, 'application/json', JSON.stringify(value));

  const server = http.createServer(async (req, res) => {
    const port = server.address()?.port;
    const host = req.headers.host ?? '';
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      json(res, 403, { error: 'wrong host' });
      return;
    }
    let url;
    try {
      url = new URL(req.url, `http://${host}`);
    } catch {
      json(res, 400, { error: 'bad request' });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/') {
      send(res, 200, 'text/html; charset=utf-8', PAGE);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/save') {
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== `http://${host}`) {
        json(res, 403, { error: 'wrong origin' });
        return;
      }
      if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
        json(res, 415, { error: 'expected application/json' });
        return;
      }
      let entry;
      try {
        let parsed;
        try {
          parsed = JSON.parse(await readBody(req));
        } catch (err) {
          throw new Error(err instanceof SyntaxError ? 'body is not valid JSON' : err.message);
        }
        entry = validateMeasurement(parsed);
      } catch (err) {
        json(res, 400, { error: err.message });
        return;
      }
      try {
        saveCalibration(entry, calibrationPath);
      } catch (err) {
        json(res, 500, { error: `could not write ${calibrationPath}: ${err.message}` });
        return;
      }
      json(res, 200, { saved: entry.name });
      onSaved(entry.name);
      return;
    }
    json(res, 404, { error: 'not found' });
  });
  return server;
}

export default async function command(args) {
  if (args.length > 0) throw new EyesError(`eyes calibrate takes no arguments.\n${USAGE}`, 2);

  const saved = new Set();
  let finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  const server = createCalibrationServer({
    onSaved: (name) => {
      saved.add(name);
      const left = MONITORS.filter((m) => !saved.has(m));
      console.log(left.length === 0 ? `Saved ${name}. Both monitors are calibrated.` : `Saved ${name}. Still to do: ${left.join(', ')}.`);
      if (left.length === 0) finish();
    },
  });
  // close() also drops idle keep-alive sockets, so the last response still reaches the page.
  const closeServer = () => new Promise((resolve) => server.close(resolve));

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const unregister = registerCleanup(({ sync }) => {
    if (sync) {
      server.closeAllConnections();
      server.close();
      return undefined;
    }
    server.closeAllConnections();
    return closeServer();
  });

  console.log('Open this link in Chrome, maximised, on each monitor, and press the matching button:');
  console.log(`  http://127.0.0.1:${server.address().port}/`);
  console.log('Waiting for both monitors (Ctrl-C to stop).');

  await done;
  unregister();
  await closeServer();
  return 0;
}
