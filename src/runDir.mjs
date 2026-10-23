import fs from 'node:fs';
import path from 'node:path';

const pad = (n) => String(n).padStart(2, '0');

function stamp(d) {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

// Creates <projectRoot>/.eyes/runs/<YYYYMMDD-HHMMSS>-<name>, adding -2, -3 if taken.
export function makeRunDir(projectRoot, name, now = new Date()) {
  const runs = path.join(projectRoot, '.eyes', 'runs');
  fs.mkdirSync(runs, { recursive: true });
  const base = `${stamp(now)}-${name}`;
  for (let n = 1; ; n++) {
    const dir = path.join(runs, n === 1 ? base : `${base}-${n}`);
    try {
      fs.mkdirSync(dir);
      return dir;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
}
