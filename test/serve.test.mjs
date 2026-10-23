import './setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startServer } from '../src/serve.mjs';
import { waitForServer } from '../src/commands/serve.mjs';
import { EyesError } from '../src/report.mjs';

const SERVERS = path.join(import.meta.dirname, 'fixtures', 'servers');
const cmdFor = (name) => `node "${path.join(SERVERS, name)}" {port}`;
const EYES = path.join(import.meta.dirname, '..', 'bin', 'eyes.mjs');

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function canBind(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condition not met in time');
}

async function untilAsync(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('condition not met in time');
}

async function startGood(opts = {}) {
  const server = await startServer(cmdFor('good.mjs'), { cwd: process.cwd(), ...opts });
  const pid = Number(
    (await until(() => /CHILD_PID=(\d+)/.exec(server.logTail()))) [1],
  );
  return { server, pid };
}

test('good server answers, and stop() kills the whole tree and frees the port', async () => {
  const { server, pid } = await startGood();
  try {
    const res = await fetch(server.url);
    assert.equal(await res.text(), 'ok');
    assert.ok(alive(pid), 'grandchild should be alive while the server runs');
    assert.equal(server.url, `http://127.0.0.1:${server.port}/`);
  } finally {
    await server.stop();
  }
  assert.equal(alive(pid), false, 'grandchild must be dead after stop()');
  assert.equal(await canBind(server.port), true, 'port must be free after stop()');
  await server.stop(); // idempotent
});

test('crashing server gives an exit-3 error containing its output', async () => {
  await assert.rejects(
    startServer(cmdFor('crash.mjs'), { cwd: process.cwd() }),
    (err) => err instanceof EyesError && err.exitCode === 3 && err.message.includes('boom'),
  );
});

test('silent server times out with exit 3 quickly and leaves no process behind', async () => {
  const t0 = Date.now();
  let error;
  await assert.rejects(
    startServer(cmdFor('silent.mjs'), { cwd: process.cwd(), timeoutMs: 3000 }),
    (err) => {
      error = err;
      return err instanceof EyesError && err.exitCode === 3 && err.message.includes('never listening');
    },
  );
  assert.ok(Date.now() - t0 < 5000, 'should fail within 5 s');
  const pid = Number(/^PID=(\d+)/m.exec(error.message)?.[1]);
  const childPid = Number(/CHILD_PID=(\d+)/.exec(error.message)?.[1]);
  assert.ok(pid > 0 && childPid > 0, 'error should carry the server output: ' + error.message);
  assert.equal(alive(pid), false, 'silent server must be dead');
  assert.equal(alive(childPid), false, 'its grandchild must be dead');
});

test('two servers started at once get different ports and are independent', async () => {
  const [a, b] = await Promise.all([startGood(), startGood()]);
  try {
    assert.notEqual(a.server.port, b.server.port);
    await a.server.stop();
    assert.equal(alive(a.pid), false);
    assert.equal(alive(b.pid), true, 'stopping one must not disturb the other');
    assert.equal((await fetch(b.server.url)).status, 200);
  } finally {
    await a.server.stop();
    await b.server.stop();
  }
  assert.equal(alive(b.pid), false);
});

test('command without {port} is a usage error (exit 2)', async () => {
  await assert.rejects(
    startServer('node whatever.mjs', { cwd: process.cwd() }),
    (err) => err instanceof EyesError && err.exitCode === 2 && err.message.includes('{port}'),
  );
});

test('cwd with spaces works', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eyes serve '));
  try {
    const { server, pid } = await startGood({ cwd: dir });
    await server.stop();
    assert.equal(alive(pid), false);
  } finally {
    // Windows can hold the folder for a moment after its last process dies (longer when busy).
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test('readyPath is used for the readiness poll', async () => {
  const { server } = await startGood({ readyPath: '/health' });
  try {
    assert.equal(server.url, `http://127.0.0.1:${server.port}/health`);
  } finally {
    await server.stop();
  }
});

for (const mode of ['exit', 'throw']) {
  test(`registerCleanup runs every cleanup exactly once on ${mode}`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eyes-hooks-'));
    const marker = path.join(dir, 'marker.txt');
    try {
      spawnSync(process.execPath, [path.join(SERVERS, 'hooks.mjs'), marker, mode], {
        encoding: 'utf8',
      });
      const lines = fs.readFileSync(marker, 'utf8').trim().split('\n').sort();
      assert.deepEqual(lines, ['ran', 'ran2']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('eyes serve without a command, or without {port}, exits 2', () => {
  for (const args of [[], ['node foo.mjs']]) {
    const r = spawnSync(process.execPath, [EYES, 'serve', ...args], { encoding: 'utf8' });
    assert.equal(r.status, 2, `args ${JSON.stringify(args)}: ${r.stderr}`);
  }
});

for (const mode of ['exit', 'throw']) {
  test(`a server still running when the process ends by ${mode} is killed with its whole tree`, async () => {
    const r = spawnSync(process.execPath, [path.join(SERVERS, 'driver.mjs'), mode], { encoding: 'utf8' });
    const { port, pid } = JSON.parse(r.stdout.trim().split('\n')[0]);
    assert.ok(pid > 0, `driver output: ${r.stdout} ${r.stderr}`);
    await until(() => !alive(pid));
    await untilAsync(() => canBind(port));
  });
}

test('stop() is bounded: a kill that does nothing ends in an exit-3 error, with the sync fallback killing the tree', async () => {
  const { server, pid } = await startGood({ killTreeImpl: async () => {}, stopTimeoutMs: 500 });
  const t0 = Date.now();
  await assert.rejects(
    server.stop(),
    (err) => err instanceof EyesError && err.exitCode === 3 && err.message.includes('could not be stopped'),
  );
  assert.ok(Date.now() - t0 < 5000, 'stop() must not hang');
  await until(() => !alive(pid));
  // The OS can take a moment after the process dies to release its listening socket (longer on a
  // busy machine); the stop() call itself was already checked above, so wait for the port.
  await untilAsync(() => canBind(server.port));
});

test('a second Ctrl-C during a stuck shutdown force-exits and still kills the tree', async () => {
  const r = spawnSync(process.execPath, [path.join(SERVERS, 'driver.mjs'), 'sigint2'], {
    encoding: 'utf8',
    timeout: 30000,
  });
  const { port, pid } = JSON.parse(r.stdout.trim().split('\n')[0]);
  assert.equal(r.status, 130, `stderr: ${r.stderr}`);
  await until(() => !alive(pid));
  await untilAsync(() => canBind(port));
});

test('stop() does not signal a child that has already exited (its PID may be reused)', async () => {
  const calls = [];
  const command =
    `node -e "require('http').createServer((q,s)=>s.end('x')).listen({port},'127.0.0.1',()=>setTimeout(()=>process.exit(0),300))"`;
  const server = await startServer(command, {
    cwd: process.cwd(),
    killTreeImpl: async (pid) => calls.push(pid),
  });
  await server.exited;
  await server.stop();
  assert.deepEqual(calls, []);
});

test('waitForServer: an intentional stop() is not reported as "stopped by itself"', async () => {
  const { server } = await startGood();
  const waiting = waitForServer(server);
  await server.stop();
  assert.equal(await waiting, 130);
});

test('waitForServer: a server that dies on its own is an exit-3 error', async () => {
  const command =
    `node -e "require('http').createServer((q,s)=>s.end('x')).listen({port},'127.0.0.1',()=>setTimeout(()=>process.exit(0),300))"`;
  const server = await startServer(command, { cwd: process.cwd() });
  await assert.rejects(
    waitForServer(server),
    (err) => err instanceof EyesError && err.exitCode === 3 && err.message.includes('stopped by itself'),
  );
  await server.stop();
});

test('a server listening on ::1 only is found, and its origin is the IPv6 loopback', async () => {
  const server = await startServer(cmdFor('ipv6.mjs'), { cwd: process.cwd(), timeoutMs: 15000 });
  try {
    assert.equal(server.url, `http://[::1]:${server.port}/`);
    assert.match(await (await fetch(server.url)).text(), /served over ipv6/);
  } finally {
    await server.stop();
  }
});

test('eyes run against a ::1-only dev server passes', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'eyes-ipv6-'));
  try {
    const file = path.join(proj, '.eyes', 'v6.yaml');
    fs.mkdirSync(path.dirname(file));
    const cmd = cmdFor('ipv6.mjs').replaceAll('\\', '/');
    fs.writeFileSync(file, `serve: '${cmd}'\nurl: /\nviews: [laptop]\nsteps:\n  - check: { text: "#h", contains: "served over ipv6" }\n`);
    const r = spawnSync(process.execPath, [EYES, 'run', file], { encoding: 'utf8', timeout: 120000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});
