// Author, creator and maintainer: Dhruba Poudel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../dist/server/app.js';
import { createStore } from '../dist/server/store.js';
import { TeamStore } from '../dist/server/team-store.js';
import { createTeamWorker } from '../dist/server/team-worker.js';

const SECRET = 'team-worker-transport-tests-only';
let command = 0;
const key = () => `worker-command-${++command}`;
function actors(store) {
  const access = store.createDemo();
  const login = (role) => {
    const c = access.credentials.find((credential) => credential.role === role);
    return store.login({
      workspaceId: access.workspaceId,
      username: c.username,
      password: c.password,
    }).token;
  };
  return { analyst: login('analyst'), approver: login('approver') };
}
const readJob = (store, token, id) => store.getSnapshot(token).jobs.find((job) => job.id === id);
async function running(t, { socket = false, timeoutMs = 250, handler } = {}) {
  const classic = createStore();
  const store = new TeamStore({ retryBaseMs: 5 });
  const server = handler
    ? createServer(handler)
    : createApp({ store: classic, teamStore: store, teamSandboxSecret: SECRET });
  if (socket) {
    const socketAddress =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\exception-studio-worker-${randomUUID()}`
        : join(tmpdir(), `es-${randomUUID()}.sock`);
    server.listen(socketAddress);
  } else server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const worker = createTeamWorker({
    store,
    baseUrl: typeof address === 'string' ? 'http://127.0.0.1' : `http://127.0.0.1:${address.port}`,
    ...(typeof address === 'string' ? { socketPath: address } : {}),
    secret: SECRET,
    timeoutMs,
  });
  t.after(async () => {
    await worker.stop();
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    store.close();
    classic.close();
  });
  return { store, server, worker, address, pair: actors(store) };
}
function enqueue(store, analyst, scenario = 'healthy') {
  return store.enqueue(analyst, key(), { scenario }).jobId;
}
async function approvedJob(context, scenario = 'healthy') {
  const { store, worker, pair } = context;
  const id = enqueue(store, pair.analyst, scenario);
  await worker.runOnce();
  let current = readJob(store, pair.analyst, id);
  assert.equal(current.status, 'awaiting_review');
  store.review(pair.analyst, id, key(), {
    expectedRevision: current.revision,
    payload: current.payload,
    reason: 'Verified the fictional source before requesting approval.',
  });
  current = readJob(store, pair.approver, id);
  store.approve(pair.approver, id, key(), {
    expectedRevision: current.revision,
    reason: 'A separate demo account approved this fictional delivery.',
  });
  return id;
}

test('loopback TCP transports source and approved destination as real HTTP', async (t) => {
  const context = await running(t),
    { store, worker, pair } = context;
  const id = await approvedJob(context);
  await worker.runOnce();
  const current = readJob(store, pair.analyst, id);
  assert.equal(current.status, 'delivered');
  assert.deepEqual(
    current.attempts.map((a) => a.httpStatus),
    [200, 200],
  );
  assert.equal(store.getSnapshot(pair.analyst).metrics.destinationWrites, 1);
});

test('the actual listening Unix socket or Windows named pipe carries the complete workflow', async (t) => {
  const context = await running(t, { socket: true }),
    { store, worker, pair, address } = context;
  assert.equal(typeof address, 'string');
  const id = await approvedJob(context);
  await worker.runOnce();
  assert.equal(readJob(store, pair.analyst, id).status, 'delivered');
  assert.equal(store.getSnapshot(pair.analyst).metrics.destinationWrites, 1);
});

test('the full-body deadline aborts a response whose headers and partial JSON arrived on time', async (t) => {
  let finished = false,
    closedEarly = false;
  const context = await running(t, {
    timeoutMs: 70,
    handler: (request, response) => {
      assert.equal(request.headers['x-team-sandbox-secret'], SECRET);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{"reference":');
      const timer = setTimeout(() => {
        finished = true;
        response.end('"WO-SLOW","team":"North region","minutes":45}');
      }, 1000);
      response.on('close', () => {
        closedEarly = !finished;
        clearTimeout(timer);
      });
    },
  });
  const { store, worker, pair } = context,
    id = enqueue(store, pair.analyst),
    started = performance.now();
  await worker.runOnce();
  const elapsed = performance.now() - started,
    current = readJob(store, pair.analyst, id);
  assert.equal(current.status, 'retry_source');
  assert.equal(current.attempts[0].outcome, 'timeout');
  assert.ok(
    elapsed >= 45 && elapsed < 800,
    `Total deadline elapsed in ${elapsed}ms rather than waiting for the body.`,
  );
  await delay(10);
  assert.equal(closedEarly, true);
  assert.equal(finished, false);
});

test('a destination commit followed by a timed-out response retries over TCP to one receipt', async (t) => {
  const context = await running(t, { timeoutMs: 120 }),
    { store, worker, pair } = context;
  const id = await approvedJob(context, 'delivery_timeout');
  await worker.runOnce();
  const uncertain = readJob(store, pair.analyst, id),
    firstReceipt = uncertain.receipt;
  assert.equal(uncertain.status, 'retry_delivery');
  assert.equal(uncertain.attempts.at(-1).outcome, 'timeout');
  assert.equal(store.getSnapshot(pair.analyst).metrics.destinationWrites, 1);
  await delay(15);
  await worker.runOnce();
  const delivered = readJob(store, pair.analyst, id);
  assert.equal(delivered.status, 'delivered');
  assert.deepEqual(delivered.receipt, firstReceipt);
  assert.equal(delivered.deliveryAttempts, 2);
  assert.equal(store.getSnapshot(pair.analyst).metrics.destinationWrites, 1);
});

test('429 status and Retry-After remain observable and hold a socket job until due', async (t) => {
  const { store, worker, pair } = await running(t, { socket: true });
  const id = enqueue(store, pair.analyst, 'rate_limit'),
    started = Date.now();
  await worker.runOnce();
  const current = readJob(store, pair.analyst, id);
  assert.equal(current.status, 'retry_source');
  assert.equal(current.attempts[0].httpStatus, 429);
  assert.equal(current.attempts[0].outcome, 'rate_limit');
  assert.ok(Date.parse(current.nextAttemptAt) >= started + 1000);
  assert.equal(await worker.runOnce(), false);
});

test('redirects are recorded as HTTP failures and Location is never followed', async (t) => {
  let requests = 0;
  const { store, worker, pair } = await running(t, {
    handler: (_request, response) => {
      requests++;
      response.writeHead(302, { Location: '/must-not-be-requested' });
      response.end('Moved');
    },
  });
  const id = enqueue(store, pair.analyst);
  await worker.runOnce();
  assert.equal(requests, 1);
  const current = readJob(store, pair.analyst, id);
  assert.equal(current.status, 'retry_source');
  assert.equal(current.attempts[0].httpStatus, 302);
  assert.equal(current.attempts[0].outcome, 'upstream_error');
});

test('responses larger than 64 KiB are aborted and cannot become source evidence', async (t) => {
  const { store, worker, pair } = await running(t, {
    handler: (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({ reference: 'WO-LARGE', team: 'x'.repeat(70 * 1024), minutes: 45 }),
      );
    },
  });
  const id = enqueue(store, pair.analyst);
  await worker.runOnce();
  const current = readJob(store, pair.analyst, id);
  assert.equal(current.status, 'retry_source');
  assert.equal(current.sourceRaw, null);
  assert.equal(current.attempts[0].httpStatus, 200);
  assert.match(current.attempts[0].message, /64 KiB/);
});

test('invalid JSON and interrupted bodies fail promptly without stranding the worker', async (t) => {
  let requests = 0;
  const { store, worker, pair } = await running(t, {
    handler: (_request, response) => {
      requests++;
      if (requests === 1) {
        response.writeHead(200);
        response.end('invalid json');
      } else {
        response.writeHead(200, { 'Content-Length': 1000 });
        response.write('{');
        setImmediate(() => response.destroy());
      }
    },
  });
  const id = enqueue(store, pair.analyst);
  await worker.runOnce();
  let current = readJob(store, pair.analyst, id);
  assert.equal(current.attempts[0].outcome, 'upstream_error');
  assert.match(current.attempts[0].message, /invalid JSON/);
  await delay(15);
  await worker.runOnce();
  current = readJob(store, pair.analyst, id);
  assert.equal(current.attempts.length, 2);
  assert.equal(current.attempts[1].outcome, 'upstream_error');
  assert.equal(current.status, 'retry_source');
});

test('external targets and non-HTTP schemes are rejected even when a trusted socket is supplied', (t) => {
  const store = new TeamStore();
  t.after(() => store.close());
  for (const baseUrl of [
    'https://example.com',
    'http://127.0.0.1.example.com',
    'ftp://127.0.0.1',
    'http://name:password@127.0.0.1',
  ]) {
    assert.throws(
      () =>
        createTeamWorker({ store, baseUrl, socketPath: '/trusted/listening.sock', secret: SECRET }),
      /loopback/,
    );
  }
  assert.throws(
    () => createTeamWorker({ store, baseUrl: 'http://127.0.0.1', socketPath: '', secret: SECRET }),
    /trusted listening socket/,
  );
});

test('only the exact configured own HTTPS origin may replace loopback transport', async (t) => {
  const store = new TeamStore();
  t.after(() => store.close());
  const trusted = createTeamWorker({
    store,
    baseUrl: 'https://demo.example.com/',
    publicOrigin: 'https://demo.example.com',
    secret: SECRET,
  });
  assert.equal(
    await trusted.runOnce(),
    false,
    'Constructor acceptance does not make an external request when no work is queued.',
  );
  await trusted.stop();
  for (const baseUrl of [
    'https://other.example.com',
    'http://demo.example.com',
    'https://demo.example.com.evil.test',
    'https://demo.example.com:444',
    'https://name:password@demo.example.com',
    'https://demo.example.com/another-path',
    'https://demo.example.com/?token=private',
    'https://demo.example.com/?',
    'https://demo.example.com/#section',
  ])
    assert.throws(
      () =>
        createTeamWorker({
          store,
          baseUrl,
          publicOrigin: 'https://demo.example.com',
          secret: SECRET,
        }),
      /loopback sandbox|own HTTPS origin/,
    );
  for (const publicOrigin of [
    'http://demo.example.com',
    'ftp://demo.example.com',
    'https://name:password@demo.example.com',
    'https://demo.example.com/path',
    'https://demo.example.com/?query=value',
    'https://demo.example.com/?',
    'https://demo.example.com/#section',
  ])
    assert.throws(
      () =>
        createTeamWorker({
          store,
          baseUrl: 'https://demo.example.com',
          publicOrigin,
          secret: SECRET,
        }),
      /plain HTTPS origin/,
    );
  assert.throws(
    () =>
      createTeamWorker({
        store,
        baseUrl: 'https://demo.example.com',
        publicOrigin: 'https://demo.example.com',
        socketPath: '/trusted/listening.sock',
        secret: SECRET,
      }),
    /trusted listening socket/,
  );
});

test('transport failure logging contains error name and code without request, secret or socket details', async (t) => {
  const logger = t.mock.method(console, 'error', () => {});
  const store = new TeamStore();
  const privateSocket =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\missing-private-worker-${randomUUID()}`
      : join(tmpdir(), `private-missing-worker-${randomUUID()}.sock`);
  const worker = createTeamWorker({
    store,
    baseUrl: 'http://127.0.0.1',
    socketPath: privateSocket,
    secret: SECRET,
  });
  t.after(async () => {
    await worker.stop();
    store.close();
  });
  const pair = actors(store),
    id = enqueue(store, pair.analyst);
  await worker.runOnce();
  assert.equal(readJob(store, pair.analyst, id).status, 'retry_source');
  assert.equal(logger.mock.callCount(), 1);
  const [label, detail] = logger.mock.calls[0].arguments;
  assert.equal(label, 'Team sandbox request failed.');
  assert.deepEqual(Object.keys(detail).sort(), ['code', 'name']);
  assert.equal(detail.name, 'Error');
  assert.match(detail.code, /^[A-Z][A-Z0-9_]+$/);
  const logged = JSON.stringify(logger.mock.calls[0].arguments);
  for (const forbidden of [privateSocket, SECRET, 'http://', '/api/team/', id, pair.analyst])
    assert.ok(!logged.includes(forbidden));
});
