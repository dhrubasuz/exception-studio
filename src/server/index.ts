// Author, creator and maintainer: Dhruba Poudel.
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { createApp } from './app.js';
import { createStore } from './store.js';
import { TeamStore } from './team-store.js';
import { createTeamWorker } from './team-worker.js';

const port = Number(process.env.PORT || 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT must be a valid TCP port.');
const databasePath = resolve(process.env.DATABASE_PATH || 'data/exception-studio.sqlite');
const store = createStore({ databasePath, publicMode: process.env.DEMO_ONLY !== 'false' });
const teamStore = new TeamStore({ databasePath });
const teamSandboxSecret = teamStore.getSandboxSecret();
const server = createApp({
  store,
  teamStore,
  teamSandboxSecret,
  publicOrigin: process.env.PUBLIC_ORIGIN,
  clientDirectory: resolve(dirname(fileURLToPath(import.meta.url)), '../client'),
});
let worker: ReturnType<typeof createTeamWorker> | undefined;
server.listen(port, process.env.HOST || '127.0.0.1', () => {
  // Managed hosts may replace the requested TCP port with a local Unix socket.
  // Use the actual bound server address rather than assuming PORT was retained.
  const bound = server.address();
  if (!bound) throw new Error('The HTTP server did not expose its bound address.');
  const socketPath = typeof bound === 'string' ? bound : undefined;
  const loopback = typeof bound !== 'string' && bound.family === 'IPv6' ? '[::1]' : '127.0.0.1';
  // LiteSpeed can expose an inherited socket name in another mount namespace.
  // Its normal HTTPS application entry point remains the supported route.
  const ownOrigin =
    socketPath && process.env.PUBLIC_ORIGIN?.startsWith('https://')
      ? new URL(process.env.PUBLIC_ORIGIN).origin
      : undefined;
  worker = createTeamWorker({
    store: teamStore,
    baseUrl: ownOrigin || `http://${loopback}:${typeof bound === 'string' ? port : bound.port}`,
    secret: teamSandboxSecret,
    ...(ownOrigin
      ? { publicOrigin: ownOrigin, timeoutMs: 2000 }
      : socketPath
        ? { socketPath }
        : {}),
  });
  worker.start();
  console.log(
    `Exception Studio Team Edition ready; connector transport: ${ownOrigin ? 'HTTPS own origin' : typeof bound === 'string' ? 'local socket' : 'loopback TCP port ' + bound.port}; fictional-data sandbox mode.`,
  );
});
const cleanupTimer = setInterval(
  () => {
    try {
      store.cleanupExpired();
      teamStore.cleanupExpired();
    } catch {
      console.error('Expired-sandbox cleanup could not complete.');
    }
  },
  10 * 60 * 1000,
);
cleanupTimer.unref();
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  clearInterval(cleanupTimer);
  // Stop new claims before draining the HTTP server, including an active loopback request.
  void (worker?.stop() || Promise.resolve()).finally(() => {
    server.close(() => {
      teamStore.close();
      store.close();
      process.exit(0);
    });
    server.closeIdleConnections();
  });
  setTimeout(() => {
    teamStore.close();
    store.close();
    process.exit(0);
  }, 5000).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('message', (message: unknown) => {
  if (message === 'shutdown') stop();
});
