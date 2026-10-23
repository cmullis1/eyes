import './setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createCalibrationServer } from '../src/commands/calibrate.mjs';
import { resolveProfiles } from '../src/profiles.mjs';

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eyes calibrate '));
  return path.join(dir, 'nested', 'profiles.json');
}

async function start(calibrationPath, onSaved = () => {}) {
  const server = createCalibrationServer({ calibrationPath, onSaved });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise((resolve) => server.close(resolve));
  return { base, close };
}

const post = (base, body, headers = {}) =>
  fetch(`${base}/save`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

test('the page shows the measured size and offers both monitor buttons', async () => {
  const { base, close } = await start(tempFile());
  try {
    const res = await fetch(base);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.match(html, /innerWidth/);
    assert.match(html, /devicePixelRatio/);
    assert.match(html, /This is my desktop monitor/);
    assert.match(html, /This is my 4K monitor/);
  } finally {
    await close();
  }
});

test('posting a 4k measurement stores it through saveCalibration', async () => {
  const file = tempFile();
  const saved = [];
  const { base, close } = await start(file, (name) => saved.push(name));
  try {
    const res = await post(base, { name: '4k', width: 2194, height: 1105, deviceScaleFactor: 1.75 });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
      '4k': { width: 2194, height: 1105, deviceScaleFactor: 1.75 },
    });
    assert.deepEqual(saved, ['4k']);
    assert.deepEqual(resolveProfiles(['4k'], file), [
      { name: '4k', width: 2194, height: 1105, deviceScaleFactor: 1.75 },
    ]);
  } finally {
    await close();
  }
});

test('the desktop entry is kept alongside the 4k one', async () => {
  const file = tempFile();
  const { base, close } = await start(file);
  try {
    await post(base, { name: 'desktop', width: 2560, height: 1311, deviceScaleFactor: 1 });
    await post(base, { name: '4k', width: 2194, height: 1105, deviceScaleFactor: 1.75 });
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).sort(), ['4k', 'desktop']);
  } finally {
    await close();
  }
});

test('invalid measurements are refused and nothing is written', async () => {
  const file = tempFile();
  const saved = [];
  const { base, close } = await start(file, (name) => saved.push(name));
  try {
    const bad = [
      { name: 'laptop', width: 1366, height: 639, deviceScaleFactor: 1 },
      { name: '4k', width: 0, height: 1105, deviceScaleFactor: 1.75 },
      { name: '4k', width: 2194, height: -5, deviceScaleFactor: 1.75 },
      { name: '4k', width: 2194, height: 1105, deviceScaleFactor: null },
      { name: '4k', width: '2194', height: 1105, deviceScaleFactor: 1.75 },
      { name: '4k', width: 2194, height: Infinity, deviceScaleFactor: 1.75 },
      { name: '4k', width: 2194, height: 1105 },
      'not json {',
      '[1,2]',
    ];
    for (const body of bad) {
      const res = await post(base, body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(saved, []);
  } finally {
    await close();
  }
});

test('a browser tab on another site cannot post a measurement', async () => {
  const file = tempFile();
  const { base, close } = await start(file);
  try {
    const body = { name: '4k', width: 2194, height: 1105, deviceScaleFactor: 1.75 };
    const wrongType = await post(base, body, { 'content-type': 'text/plain' });
    assert.equal(wrongType.status, 415);
    const wrongOrigin = await post(base, body, { origin: 'https://example.com' });
    assert.equal(wrongOrigin.status, 403);
    assert.equal(fs.existsSync(file), false);
  } finally {
    await close();
  }
});

test('unknown paths are 404', async () => {
  const { base, close } = await start(tempFile());
  try {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  } finally {
    await close();
  }
});

// A raw request, so the Host header and the request target can be anything (as a rebinding attack or a broken client sends).
function raw(base, { method = 'POST', target = '/save', host, origin, body = '' }) {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), '127.0.0.1', () => {
      const headers = [`${method} ${target} HTTP/1.1`, `Host: ${host ?? `127.0.0.1:${port}`}`];
      if (origin) headers.push(`Origin: ${origin}`);
      headers.push('Content-Type: application/json', `Content-Length: ${Buffer.byteLength(body)}`, 'Connection: close', '', body);
      socket.end(headers.join('\r\n'));
    });
    let text = '';
    socket.setEncoding('utf8');
    socket.on('data', (d) => (text += d));
    socket.on('end', () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1])));
    socket.on('error', reject);
  });
}

test('a request naming another host (DNS rebinding) is refused, even with a matching Origin', async () => {
  const file = tempFile();
  const { base, close } = await start(file);
  const { port } = new URL(base);
  try {
    const body = JSON.stringify({ name: '4k', width: 1, height: 1, deviceScaleFactor: 1 });
    assert.equal(await raw(base, { host: `evil.example:${port}`, origin: `http://evil.example:${port}`, body }), 403);
    assert.equal(await raw(base, { host: `evil.example:${port}`, body }), 403);
    assert.equal(await raw(base, { method: 'GET', target: '/', host: `evil.example:${port}` }), 403);
    assert.equal(fs.existsSync(file), false, 'nothing written');
    assert.equal(await raw(base, { host: `localhost:${port}`, origin: `http://localhost:${port}`, body }), 200);
  } finally {
    await close();
  }
});

test('a request target that is not a valid URL is a 400, not a crash', async () => {
  const { base, close } = await start(tempFile());
  try {
    assert.equal(await raw(base, { method: 'GET', target: '//[' }), 400);
    assert.equal((await fetch(base)).status, 200, 'the server is still up');
  } finally {
    await close();
  }
});

test('with no explicit path, calibrate saves where EYES_CALIBRATION points (what the installed wrapper sets)', async () => {
  const file = tempFile();
  const before = process.env.EYES_CALIBRATION;
  process.env.EYES_CALIBRATION = file;
  const server = createCalibrationServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await post(`http://127.0.0.1:${server.address().port}`, { name: 'desktop', width: 1000, height: 500, deviceScaleFactor: 1 });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { desktop: { width: 1000, height: 500, deviceScaleFactor: 1 } });
  } finally {
    process.env.EYES_CALIBRATION = before;
    await new Promise((resolve) => server.close(resolve));
  }
});
