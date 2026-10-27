// Author, creator and maintainer: Dhruba Poudel.
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { createApp } from './app.js';
import { createStore } from './store.js';
import { randomBytes } from 'node:crypto';
import { TeamStore } from './team-store.js';
import { createTeamWorker } from './team-worker.js';

const port = Number(process.env.PORT || 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT must be a valid TCP port.');
const databasePath = resolve(process.env.DATABASE_PATH || 'data/exception-studio.sqlite');
const store = createStore({ databasePath, publicMode: process.env.DEMO_ONLY !== 'false' });
const teamStore = new TeamStore({ databasePath });
const teamSandboxSecret = randomBytes(32).toString('hex');
const server = createApp({
  store,
  teamStore,
  teamSandboxSecret,
  publicOrigin: process.env.PUBLIC_ORIGIN,
  clientDirectory: resolve(dirname(fileURLToPath(import.meta.url)), '../client'),
});
const worker = createTeamWorker({
  store: teamStore,
  baseUrl: `http://127.0.0.1:${port}`,
  secret: teamSandboxSecret,
});
server.listen(port, process.env.HOST || '127.0.0.1', () => {
  worker.start();
  console.log(
    `Exception Studio Team Edition listening on port ${port}; fictional-data sandbox mode.`,
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
  void worker.stop().finally(() => {
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
