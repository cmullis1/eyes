// Fixture dev server that runs forever but never listens. Like good.mjs it keeps a grandchild
// alive, and it prints both PIDs so tests can prove the whole tree died.
import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore' });
console.log(`PID=${process.pid}`);
console.log(`CHILD_PID=${child.pid}`);
console.log('starting up, never listening');
setInterval(() => {}, 1e6);
