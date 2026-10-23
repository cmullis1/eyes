// Fixture dev server: listens on the port in argv[2] and keeps a grandchild alive.
import http from 'node:http';
import { spawn } from 'node:child_process';

const port = Number(process.argv[2]);
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore' });
console.log(`CHILD_PID=${child.pid}`);
http.createServer((req, res) => res.end('ok')).listen(port, '127.0.0.1', () => {
  console.log(`listening on ${port}`);
});
