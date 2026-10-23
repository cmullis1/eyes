// Fixture: starts good.mjs, reports its grandchild PID and port, then ends the process without
// calling stop(). Modes: exit, throw, sigint2 (two SIGINTs while a stop that cannot finish is running).
import path from 'node:path';
import { startServer } from '../../../src/serve.mjs';

const mode = process.argv[2];
const opts = { cwd: process.cwd() };
if (mode === 'sigint2') {
  opts.killTreeImpl = async () => {}; // a kill that silently does nothing
  opts.stopTimeoutMs = 60000;
}
const server = await startServer(`node "${path.join(import.meta.dirname, 'good.mjs')}" {port}`, opts);
const pid = /CHILD_PID=(\d+)/.exec(server.logTail())?.[1];
console.log(JSON.stringify({ port: server.port, pid: Number(pid) }));
if (mode === 'throw') setImmediate(() => { throw new Error('driver crash'); });
else if (mode === 'sigint2') {
  process.emit('SIGINT');
  setTimeout(() => process.emit('SIGINT'), 300);
} else process.exit(0);
