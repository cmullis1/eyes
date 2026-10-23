// Loaded into every test process: by `npm test` (node --import) and by an `import ./setup.mjs` at the top of each test file, so plain `node --test <file>` is isolated too.
// Points the calibration file at a path that never exists, so no test reads or writes
// the machine's real ~/.claude/tools/eyes/profiles.json. Child processes the tests
// spawn inherit process.env, so the CLI sees the same path.

import os from 'node:os';
import path from 'node:path';

process.env.EYES_CALIBRATION = path.join(os.tmpdir(), `eyes-test-no-calibration-${process.pid}`, 'profiles.json');
