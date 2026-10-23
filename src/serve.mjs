// Dev server lifecycle: free port, start, wait until it answers, and always kill the whole tree.
import { spawn, spawnSync, execFile } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { EyesError } from './report.mjs';

const IS_WIN = process.platform === 'win32';
const POLL_MS = 100;
const REQUEST_TIMEOUT_MS = 2000;
const PORT_FREE_TIMEOUT_MS = 10000;
const STOP_TIMEOUT_MS = 10000;
const TASKKILL_TIMEOUT_MS = 5000;
const LOG_LINES_KEPT = 200;

// ---- cleanup registry: every cleanup runs once, on exit, Ctrl-C, SIGTERM or a crash ----

const cleanups = new Set();
let handlersInstalled = false;
let shuttingDown = false;

// Runs registered cleanups. The async pass (signals, crashes) runs each entry once and awaits it.
// The sync pass (process 'exit', or a second Ctrl-C while the async pass is stuck) cannot await,
// so entries receive { sync: true } and must finish their work before returning. A sync pass also
// reaches entries whose async run has not finished yet; entries that finished are already removed.
function runCleanups({ sync }) {
  const pending = [];
  for (const entry of [...cleanups]) {
    if (sync ? entry.syncRan : entry.ran) continue;
    if (sync) entry.syncRan = true;
    else entry.ran = true;
    const done = () => cleanups.delete(entry);
    try {
      const result = entry.fn({ sync });
      if (result && typeof result.then === 'function') {
        pending.push(
          result.then(done, (err) => {
            done();
            console.error(err?.message ?? String(err));
          }),
        );
      } else {
        done();
      }
    } catch (err) {
      done();
      console.error(err?.message ?? String(err));
    }
  }
  return Promise.all(pending);
}

async function shutdown(code) {
  if (shuttingDown) {
    // Second Ctrl-C (or a crash) while shutting down: stop waiting, kill synchronously, leave.
    runCleanups({ sync: true });
    process.exit(code);
  }
  shuttingDown = true;
  await runCleanups({ sync: false });
  process.exit(code);
}

function installHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.on('exit', () => {
    runCleanups({ sync: true });
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
    try {
      process.on(signal, () => shutdown(130));
    } catch {
      // signal not supported on this platform
    }
  }
  process.on('uncaughtException', (err) => {
    console.error(err?.stack ?? String(err));
    shutdown(3);
  });
}

// fn({ sync }) may be async; when sync is true it must complete before returning.
// Returns a function that unregisters it.
export function registerCleanup(fn) {
  installHandlers();
  const entry = { fn, ran: false, syncRan: false };
  cleanups.add(entry);
  return () => cleanups.delete(entry);
}

// ---- killing process trees ----

// Only call this for a process that is known to still be running: Windows reuses PIDs quickly.
export function killTreeSync(pid) {
  if (!pid) return;
  if (IS_WIN) {
    spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: TASKKILL_TIMEOUT_MS,
    });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

export function killTree(pid) {
  if (!pid) return Promise.resolve();
  if (!IS_WIN) {
    killTreeSync(pid);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    execFile(
      'taskkill',
      ['/T', '/F', '/PID', String(pid)],
      { windowsHide: true, timeout: TASKKILL_TIMEOUT_MS },
      () => resolve(),
    );
  });
}

// ---- ports ----

const reservedPorts = new Set();
// Errors meaning this machine has no IPv6 loopback, so nothing can be listening there.
const NO_IPV6 = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT']);

function listenOnce(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(port, host, () => {
      const actual = srv.address().port;
      srv.close(() => resolve(actual));
    });
  });
}

// Dev servers bind 127.0.0.1, ::1 (Vite's default where localhost resolves to ::1 first) or both,
// so a port is free only when it is free on both loopbacks.
async function listenBoth(port) {
  const actual = await listenOnce(port, '127.0.0.1');
  try {
    await listenOnce(actual, '::1');
  } catch (err) {
    if (!NO_IPV6.has(err.code)) throw err;
  }
  return actual;
}

async function freePort() {
  for (let i = 0; i < 20; i++) {
    let port;
    try {
      port = await listenBoth(0);
    } catch {
      continue; // taken on ::1: try another
    }
    if (!reservedPorts.has(port)) {
      reservedPorts.add(port);
      return port;
    }
  }
  throw new EyesError('Could not find a port free on both 127.0.0.1 and ::1', 3);
}

async function waitPortFree(port) {
  const deadline = Date.now() + PORT_FREE_TIMEOUT_MS;
  for (;;) {
    try {
      await listenBoth(port);
      return;
    } catch {
      if (Date.now() > deadline) {
        throw new EyesError(`Port ${port} is still in use after the dev server was stopped`, 3);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

// ---- readiness ----

// The addresses a dev server may answer on, in order of preference; the first that answers is the origin.
const LOOPBACK_HOSTS = ['127.0.0.1', '[::1]', 'localhost'];

function probe(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: REQUEST_TIMEOUT_MS, agent: false }, (res) => {
      res.resume();
      resolve(true);
    });
    req.once('timeout', () => req.destroy());
    req.once('error', () => resolve(false));
  });
}

// ---- the server ----

// killTreeImpl and stopTimeoutMs exist so tests can simulate a kill that does not work.
export async function startServer(
  command,
  {
    cwd = process.cwd(),
    readyPath = '/',
    timeoutMs = 60000,
    stopTimeoutMs = STOP_TIMEOUT_MS,
    killTreeImpl = killTree,
  } = {},
) {
  if (typeof command !== 'string' || !command.includes('{port}')) {
    throw new EyesError(
      'The serve command must contain {port} so Eyes can pick a free port, e.g. "npm run dev -- --port {port}"',
      2,
    );
  }
  const port = await freePort();
  let url = null;
  const finalCommand = command.replaceAll('{port}', String(port));

  const lines = [];
  let partial = '';
  const onData = (chunk) => {
    const parts = (partial + chunk.toString()).split(/\r?\n/);
    partial = parts.pop();
    lines.push(...parts);
    if (lines.length > LOG_LINES_KEPT) lines.splice(0, lines.length - LOG_LINES_KEPT);
  };
  const logTail = (n = 20) => {
    const all = partial ? [...lines, partial] : lines;
    return all.slice(-n).join('\n');
  };

  const child = spawn(finalCommand, {
    cwd,
    shell: true,
    windowsHide: true,
    detached: !IS_WIN,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  let exited = false;
  let exitInfo = '';
  const exitedPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      exited = true;
      exitInfo = signal ? `signal ${signal}` : `code ${code}`;
      resolve();
    });
    child.once('error', (err) => {
      exited = true;
      exitInfo = `error ${err.message}`;
      resolve();
    });
  });

  // Never signal a PID after the child has exited: Windows reuses PIDs quickly.
  const killNowSync = () => {
    if (!exited) killTreeSync(child.pid);
  };

  const unregister = registerCleanup(({ sync }) => {
    if (sync) {
      killNowSync();
      return undefined;
    }
    return stop();
  });

  let stopping = false;
  let stopPromise = null;
  function stop() {
    stopping = true;
    stopPromise ??= (async () => {
      if (!exited) await killTreeImpl(child.pid);
      if (!exited) {
        let timer;
        const timedOut = new Promise((r) => {
          timer = setTimeout(r, stopTimeoutMs, 'timeout');
        });
        const result = await Promise.race([exitedPromise, timedOut]);
        clearTimeout(timer);
        if (result === 'timeout') {
          killNowSync();
          throw new EyesError(
            `The dev server could not be stopped (process ${child.pid} was still running after ${stopTimeoutMs} ms): ${finalCommand}`,
            3,
          );
        }
      }
      await waitPortFree(port);
    })().finally(() => {
      unregister();
      reservedPorts.delete(port);
    });
    return stopPromise;
  }

  const failure = async (why) => {
    let stopError = null;
    try {
      await stop();
    } catch (err) {
      stopError = err;
    }
    const tail = logTail();
    const output = tail ? `\nLast server output:\n${tail}` : '\n(the server printed nothing)';
    return new EyesError(`${why}${stopError ? `\n${stopError.message}` : ''}${output}`, 3);
  };

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (exited) {
      throw await failure(`Dev server exited before answering (${exitInfo}): ${finalCommand}`);
    }
    const candidates = LOOPBACK_HOSTS.map((host) => `http://${host}:${port}${readyPath}`);
    const answered = await Promise.all(candidates.map(probe));
    url = candidates.find((_, i) => answered[i]) ?? null;
    if (url) {
      // The probes ran side by side and the server may have started listening between them (a
      // slow machine makes that gap long), so a less-preferred address can answer first. Ask
      // again in preference order so the origin does not depend on that timing.
      for (const candidate of candidates) {
        if (candidate === url || (await probe(candidate))) {
          url = candidate;
          break;
        }
      }
      break;
    }
    if (exited) continue;
    if (Date.now() > deadline) {
      throw await failure(`Dev server did not answer on port ${port} (tried ${LOOPBACK_HOSTS.join(', ')}) within ${timeoutMs} ms: ${finalCommand}`);
    }
    await Promise.race([new Promise((r) => setTimeout(r, POLL_MS)), exitedPromise]);
  }

  // exitedEarly(): how the server ended, when it exited by itself (not stopped by Eyes); else null.
  const exitedEarly = () => (exited && !stopping ? exitInfo : null);
  return { url, port, stop, logTail, exited: exitedPromise, isStopping: () => stopping, exitedEarly };
}
