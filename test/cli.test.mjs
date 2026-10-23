import './setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const EYES = path.join(import.meta.dirname, '..', 'bin', 'eyes.mjs');

test('eyes --help describes each command as it actually behaves', () => {
  const r = spawnSync(process.execPath, [EYES, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  const line = (command) => r.stderr.split('\n').find((l) => l.trimStart().startsWith(`${command} `));
  assert.match(line('serve'), /start a dev server command on a free port/);
  assert.match(line('calibrate'), /record this PC's monitor window sizes/);
  assert.match(line('accept'), /move pending baselines into place \(a person runs this, never Claude\)/);
  assert.match(line('diff'), /compare shots with approved baselines/);
  for (const command of ['look', 'run', 'diff', 'accept', 'film', 'serve', 'calibrate']) assert.ok(line(command), command);
});
