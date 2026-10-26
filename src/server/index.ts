// Author, creator and maintainer: Dhruba Poudel.
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { createApp } from './app.js';
import { createStore } from './store.js';

const port = Number(process.env.PORT || 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
const databasePath = resolve(process.env.DATABASE_PATH || 'data/exception-studio.sqlite');
const store = createStore({ databasePath, publicMode: process.env.DEMO_ONLY !== 'false' });
const server = createApp({ store, publicOrigin: process.env.PUBLIC_ORIGIN,
  clientDirectory: resolve(dirname(fileURLToPath(import.meta.url)), '../client') });
server.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`Exception Studio listening on port ${port}; fictional-data sandbox mode.`));
const cleanupTimer = setInterval(() => { try { store.cleanupExpired(); } catch { console.error('Expired-sandbox cleanup could not complete.'); } }, 10 * 60 * 1000);
cleanupTimer.unref();
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  clearInterval(cleanupTimer);
  server.close(() => { store.close(); process.exit(0); });
  server.closeIdleConnections();
  setTimeout(() => { store.close(); process.exit(0); }, 5000).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
