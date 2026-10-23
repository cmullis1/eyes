import path from 'node:path';
import { EyesError } from '../report.mjs';
import { startServer } from '../serve.mjs';

const USAGE = 'Usage: eyes serve "<command containing {port}>" [--cwd dir]';

// Resolves once the server has been stopped on purpose (Ctrl-C), with the exit code to use.
// A server that ends without anyone asking it to is an environment failure.
export async function waitForServer(server) {
  await server.exited;
  if (server.isStopping()) {
    await server.stop(); // same stop already under way: wait for the port to be free again
    return 130;
  }
  throw new EyesError(`Dev server stopped by itself.\nLast server output:\n${server.logTail()}`, 3);
}

export default async function command(args) {
  let serveCommand = null;
  let cwd = process.cwd();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cwd') {
      if (i + 1 >= args.length) throw new EyesError(`--cwd needs a directory\n${USAGE}`, 2);
      cwd = path.resolve(args[++i]);
    } else if (serveCommand === null) {
      serveCommand = args[i];
    } else {
      throw new EyesError(`Unexpected argument: ${args[i]}\n${USAGE}`, 2);
    }
  }
  if (serveCommand === null) throw new EyesError(USAGE, 2);

  const server = await startServer(serveCommand, { cwd });
  console.log(server.url);
  // Keep running until Ctrl-C (the cleanup handlers stop the server) or the server dies by itself.
  return waitForServer(server);
}
