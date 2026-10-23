// Fixture for registerCleanup: argv[2] = marker file, argv[3] = how to end.
import fs from 'node:fs';
import { registerCleanup } from '../../../src/serve.mjs';

const marker = process.argv[2];
const mode = process.argv[3];
registerCleanup(() => fs.appendFileSync(marker, 'ran\n'));
registerCleanup(() => fs.appendFileSync(marker, 'ran2\n'));
if (mode === 'exit') process.exit(0);
if (mode === 'throw') setImmediate(() => { throw new Error('kaboom'); });
