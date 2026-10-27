// Author, creator and maintainer: Dhruba Poudel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TeamStore } from '../dist/server/team-store.js';

const code = (name) => (error) => error.code === name;
const digest = (value) => createHash('sha256').update(value).digest('hex');
let counter = 0;
const key = () => `team-command-${++counter}`;
function fixture(t, options = {}) {
  let ms = Date.parse('2026-10-28T00:00:00.000Z');
  const store = new TeamStore({
    now: () => new Date(ms),
    retryBaseMs: 10,
    leaseMs: 100,
    ...options,
  });
  t.after(() => store.close());
  return { store, advance: (n = 1000) => (ms += n), now: () => new Date(ms) };
}
test('workspace lifetime remains exactly 24 hours when the clock advances between reads', (t) => {
  let tickingClock = Date.parse('2026-10-28T00:00:00.000Z');
  const { store } = fixture(t, { now: () => new Date(tickingClock++) });
  const { analyst } = accounts(store);
  const { workspace } = analyst.snapshot;
  assert.equal(Date.parse(workspace.expiresAt) - Date.parse(workspace.createdAt), 86_400_000);
});
function accounts(store) {
  const access = store.createDemo();
  const signIn = (role) => {
    const credential = access.credentials.find((item) => item.role === role);
    return store.login({
      workspaceId: access.workspaceId,
      username: credential.username,
      password: credential.password,
    });
  };
  return { access, analyst: signIn('analyst'), approver: signIn('approver'), signIn };
}
const job = (store, token, id) => store.getSnapshot(token).jobs.find((item) => item.id === id);
function enqueue(store, token, scenario = 'healthy') {
  return store.enqueue(token, key(), { scenario }).jobId;
}
function source(store, id) {
  const claim = store.claimNext();
  assert.equal(claim?.id, id);
  assert.equal(claim.phase, 'source');
  const response = store.sandboxSource(id);
  store.completeAttempt(id, claim.leaseToken, {
    outcome:
      response.status === 200
        ? 'success'
        : response.status === 429
          ? 'rate_limit'
          : 'upstream_error',
    httpStatus: response.status,
    durationMs: 12,
    message:
      response.status === 200
        ? 'Fictional source returned a record.'
        : 'Fictional source returned a temporary error.',
    data: response.body,
  });
  return { claim, response };
}
function prepareDelivery(store, pair, scenario = 'healthy') {
  const id = enqueue(store, pair.analyst.token, scenario);
  source(store, id);
  let current = job(store, pair.analyst.token, id);
  store.review(pair.analyst.token, id, key(), {
    expectedRevision: current.revision,
    payload: current.payload,
    reason: 'Checked the fictional service reference and duration.',
  });
  current = job(store, pair.approver.token, id);
  store.approve(pair.approver.token, id, key(), {
    expectedRevision: current.revision,
    reason: 'Verified the reviewed fictional record before release.',
  });
  return id;
}
function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'exception-studio-team-'));
  return join(directory, 'team.sqlite');
}
// Register after all database close hooks so Windows has released its file handles.
function cleanupDatabase(t, databasePath) {
  t.after(() => {
    const target = resolve(dirname(databasePath)),
      parent = resolve(tmpdir());
    assert.ok(
      target.startsWith(parent + sep) && basename(target).startsWith('exception-studio-team-'),
    );
    rmSync(target, { recursive: true, force: true });
  });
}

test('demo credentials are independent random secrets and never appear in snapshots or the database', (t) => {
  const path = temporaryDatabase(t),
    { store } = fixture(t, { databasePath: path });
  const pair = accounts(store),
    other = store.createDemo();
  assert.equal(pair.access.credentials.length, 2);
  assert.equal(new Set(pair.access.credentials.map((c) => c.password)).size, 2);
  assert.notEqual(pair.access.credentials[0].password, other.credentials[0].password);
  for (const credential of pair.access.credentials) {
    assert.match(credential.password, /^[A-Za-z0-9_-]{24}$/);
    assert.ok(!JSON.stringify(pair.analyst.snapshot).includes(credential.password));
    assert.ok(!readFileSync(path).includes(Buffer.from(credential.password)));
  }
  assert.match(pair.analyst.token, /^[A-Za-z0-9_-]{43}$/);
  const sql = new DatabaseSync(path);
  t.after(() => sql.close());
  const users = sql
    .prepare('SELECT salt,password_hash FROM team_users WHERE workspace_id=?')
    .all(pair.access.workspaceId);
  assert.equal(users.length, 2);
  assert.notEqual(users[0].salt, users[1].salt);
  for (const user of users) assert.match(user.password_hash, /^[a-f0-9]{64}$/);
  assert.equal(
    sql
      .prepare('SELECT COUNT(*) AS n FROM team_sessions WHERE token_hash=?')
      .get(pair.analyst.token).n,
    0,
  );
  assert.equal(
    sql
      .prepare('SELECT COUNT(*) AS n FROM team_sessions WHERE token_hash=?')
      .get(digest(pair.analyst.token)).n,
    1,
  );
  assert.equal(pair.analyst.snapshot.actor.role, 'analyst');
  assert.equal(pair.approver.snapshot.actor.role, 'approver');
  assert.equal(
    new Date(pair.access.expiresAt) - new Date(pair.analyst.snapshot.workspace.createdAt),
    24 * 60 * 60 * 1000,
  );
  cleanupDatabase(t, path);
});

test('wrong accounts, role forgery and extra fields cannot grant authority', (t) => {
  const { store } = fixture(t),
    pair = accounts(store),
    c = pair.access.credentials[0];
  for (const username of [c.username, 'not.an.account']) {
    assert.throws(
      () =>
        store.login({
          workspaceId: pair.access.workspaceId,
          username,
          password: 'incorrect password',
        }),
      code('INVALID_CREDENTIALS'),
    );
  }
  assert.throws(
    () =>
      store.login({
        workspaceId: pair.access.workspaceId,
        username: c.username,
        password: c.password,
        role: 'approver',
      }),
    code('UNEXPECTED_FIELD'),
  );
  assert.throws(
    () => store.enqueue(pair.approver.token, key(), { scenario: 'healthy' }),
    code('ROLE_REQUIRED'),
  );
  assert.throws(
    () =>
      store.enqueue(pair.analyst.token, key(), {
        scenario: 'healthy',
        actor: { role: 'approver' },
      }),
    code('UNEXPECTED_FIELD'),
  );
  assert.throws(
    () => store.enqueue('forged-token', key(), { scenario: 'healthy' }),
    code('TEAM_LOGIN_REQUIRED'),
  );
  const id = enqueue(store, pair.analyst.token);
  assert.throws(
    () =>
      store.approve(pair.analyst.token, id, key(), {
        expectedRevision: 1,
        reason: 'I claim an approver role.',
      }),
    code('ROLE_REQUIRED'),
  );
  assert.throws(
    () =>
      store.review(pair.approver.token, id, key(), {
        expectedRevision: 1,
        payload: {},
        reason: 'A forged analyst request.',
      }),
    code('ROLE_REQUIRED'),
  );
  assert.equal(store.getSnapshot(pair.analyst.token).metrics.total, 1);
});

test('logout invalidates its opaque token without affecting the other actor', (t) => {
  const { store } = fixture(t),
    pair = accounts(store);
  store.logout(pair.analyst.token);
  store.logout();
  assert.throws(() => store.getSnapshot(pair.analyst.token), code('TEAM_LOGIN_REQUIRED'));
  assert.equal(store.getSnapshot(pair.approver.token).actor.role, 'approver');
});

test('workspace scope prevents reading, reviewing or approving a foreign job', (t) => {
  const { store } = fixture(t),
    first = accounts(store),
    second = accounts(store);
  const id = enqueue(store, first.analyst.token);
  source(store, id);
  const current = job(store, first.analyst.token, id);
  assert.equal(store.getSnapshot(second.analyst.token).jobs.length, 0);
  assert.throws(() => store.trace(second.analyst.token, id), code('TEAM_JOB_NOT_FOUND'));
  assert.throws(
    () =>
      store.review(second.analyst.token, id, key(), {
        expectedRevision: current.revision,
        payload: current.payload,
        reason: 'Attempt to cross workspace boundary.',
      }),
    code('TEAM_JOB_NOT_FOUND'),
  );
  assert.throws(
    () =>
      store.approve(second.approver.token, id, key(), {
        expectedRevision: current.revision,
        reason: 'Attempt to cross workspace boundary.',
      }),
    code('TEAM_JOB_NOT_FOUND'),
  );
  assert.deepEqual(
    store
      .getSnapshot(second.analyst.token)
      .events.map((e) => e.type)
      .sort(),
    ['account.signed_in', 'account.signed_in', 'workspace.created'],
  );
});

test('exact idempotency replays do not create new state and body changes reject atomically', (t) => {
  const { store } = fixture(t),
    pair = accounts(store),
    request = key();
  const first = store.enqueue(pair.analyst.token, request, { scenario: 'healthy' });
  const repeated = store.enqueue(pair.analyst.token, request, { scenario: 'healthy' });
  assert.equal(repeated.replayed, true);
  assert.equal(repeated.jobId, first.jobId);
  assert.deepEqual(repeated.snapshot, first.snapshot);
  assert.throws(
    () => store.enqueue(pair.analyst.token, request, { scenario: 'timeout' }),
    code('IDEMPOTENCY_CONFLICT'),
  );
  assert.equal(store.getSnapshot(pair.analyst.token).jobs.length, 1);
  assert.throws(
    () => store.enqueue(pair.analyst.token, undefined, { scenario: 'healthy' }),
    code('IDEMPOTENCY_REQUIRED'),
  );
});

test('stale revisions reject while retrying the same successful command remains safe', (t) => {
  const { store } = fixture(t),
    pair = accounts(store),
    id = enqueue(store, pair.analyst.token);
  source(store, id);
  const current = job(store, pair.analyst.token, id),
    request = key();
  const input = {
    expectedRevision: current.revision,
    payload: current.payload,
    reason: 'Verified against the fictional source record.',
  };
  const first = store.review(pair.analyst.token, id, request, input);
  assert.equal(first.snapshot.jobs[0].status, 'awaiting_approval');
  assert.equal(store.review(pair.analyst.token, id, request, input).replayed, true);
  const before = store.getSnapshot(pair.analyst.token);
  assert.throws(
    () => store.review(pair.analyst.token, id, key(), input),
    (error) =>
      error.code === 'STALE_TEAM_JOB' && error.details.currentRevision === current.revision + 1,
  );
  assert.deepEqual(store.getSnapshot(pair.analyst.token), before);
  assert.throws(
    () =>
      store.review(pair.analyst.token, id, request, {
        ...input,
        reason: 'A different explanation changes this command.',
      }),
    code('IDEMPOTENCY_CONFLICT'),
  );
});

test('separate server actors review and approve before a single verified destination write', (t) => {
  const { store } = fixture(t),
    pair = accounts(store),
    id = prepareDelivery(store, pair);
  const before = job(store, pair.analyst.token, id);
  assert.notEqual(before.submittedBy, before.approvedBy);
  assert.equal(before.submittedByName, 'Avery Chen');
  assert.equal(before.approvedByName, 'Sam Rivera');
  const claim = store.claimNext();
  assert.equal(claim.phase, 'delivery');
  const response = store.sandboxDestination(id, { eventId: claim.eventId, payload: claim.payload });
  store.completeAttempt(id, claim.leaseToken, {
    outcome: 'success',
    httpStatus: 200,
    durationMs: 20,
    message: 'Returned a destination receipt.',
    data: response.body,
  });
  const snapshot = store.getSnapshot(pair.analyst.token),
    delivered = job(store, pair.analyst.token, id);
  assert.equal(delivered.status, 'delivered');
  assert.equal(delivered.receipt.id, response.body.id);
  assert.equal(snapshot.metrics.destinationWrites, 1);
  assert.equal(snapshot.metrics.delivered, 1);
  assert.equal(snapshot.metrics.attempts, 2);
  assert.equal(snapshot.metrics.p95AttemptMs, 20);
  const trace = store.trace(pair.analyst.token, id);
  assert.equal(trace.author, 'Dhruba Poudel');
  assert.equal(trace.creator, 'Dhruba Poudel');
  assert.equal(trace.events.find((e) => e.type === 'review.approved').actorName, 'Sam Rivera');
  assert.equal(trace.events.find((e) => e.type === 'review.submitted').actorRole, 'analyst');
  assert.ok(trace.events.every((e) => e.traceId === delivered.traceId));
});

test('unapproved, wrong-phase, altered and wrong-event destination calls cannot write', (t) => {
  const { store } = fixture(t),
    pair = accounts(store),
    id = enqueue(store, pair.analyst.token);
  const fake = {
    eventId: 'FAKE',
    payload: { reference: 'WO-EXAMPLE', team: 'North region', minutes: 45 },
  };
  assert.throws(() => store.sandboxDestination(id, fake), code('DESTINATION_NOT_APPROVED'));
  source(store, id);
  const received = job(store, pair.analyst.token, id);
  assert.throws(
    () => store.sandboxDestination(id, { eventId: received.eventId, payload: received.payload }),
    code('DESTINATION_NOT_APPROVED'),
  );
  store.review(pair.analyst.token, id, key(), {
    expectedRevision: received.revision,
    payload: received.payload,
    reason: 'Checked before requesting separate approval.',
  });
  const reviewed = job(store, pair.approver.token, id);
  store.approve(pair.approver.token, id, key(), {
    expectedRevision: reviewed.revision,
    reason: 'Separate actor approves this fictional item.',
  });
  const claim = store.claimNext();
  assert.throws(
    () => store.sandboxDestination(id, { eventId: 'WRONG-EVENT', payload: claim.payload }),
    code('DESTINATION_PAYLOAD_MISMATCH'),
  );
  assert.throws(
    () =>
      store.sandboxDestination(id, {
        eventId: claim.eventId,
        payload: { ...claim.payload, minutes: 46 },
      }),
    code('DESTINATION_PAYLOAD_MISMATCH'),
  );
  assert.equal(store.getSnapshot(pair.analyst.token).metrics.destinationWrites, 0);
});

test('schema drift retains immutable original evidence while explicit review supplies the valid mapping', (t) => {
  const path = temporaryDatabase(t),
    { store } = fixture(t, { databasePath: path }),
    pair = accounts(store),
    id = enqueue(store, pair.analyst.token, 'schema_drift');
  source(store, id);
  const drifted = job(store, pair.analyst.token, id),
    raw = drifted.sourceRaw;
  assert.equal(drifted.status, 'schema_error');
  assert.equal(drifted.payload, null);
  assert.equal(raw.minutes, 45);
  const mapped = { reference: raw.workOrder, team: raw.region, minutes: raw.minutes };
  assert.throws(
    () =>
      store.review(pair.analyst.token, id, key(), {
        expectedRevision: drifted.revision,
        payload: { ...mapped, minutes: -1 },
        reason: 'Rejected invalid duration should leave evidence unchanged.',
      }),
    code('INVALID_TEAM_INPUT'),
  );
  assert.equal(job(store, pair.analyst.token, id).revision, drifted.revision);
  store.review(pair.analyst.token, id, key(), {
    expectedRevision: drifted.revision,
    payload: mapped,
    reason: 'Explicitly mapped workOrder and region to current field names.',
  });
  const reviewed = job(store, pair.analyst.token, id);
  assert.deepEqual(reviewed.sourceRaw, raw);
  assert.equal(reviewed.sourceSha256, drifted.sourceSha256);
  assert.deepEqual(reviewed.payload, mapped);
  const sql = new DatabaseSync(path);
  t.after(() => sql.close());
  assert.throws(
    () => sql.prepare('UPDATE team_jobs SET source_raw=? WHERE id=?').run('{}', id),
    /immutable/,
  );
  cleanupDatabase(t, path);
});

test('duplicate source events return one scoped job and retries of the command do not increment dedupe metrics', (t) => {
  const { store } = fixture(t),
    pair = accounts(store),
    firstKey = key();
  const first = store.enqueue(pair.analyst.token, firstKey, { scenario: 'duplicate' });
  const request = key(),
    duplicate = store.enqueue(pair.analyst.token, request, { scenario: 'duplicate' });
  assert.equal(first.jobId, duplicate.jobId);
  assert.equal(duplicate.snapshot.jobs.length, 1);
  assert.equal(duplicate.snapshot.metrics.duplicateEvents, 1);
  assert.equal(
    store.enqueue(pair.analyst.token, request, { scenario: 'duplicate' }).snapshot.metrics
      .duplicateEvents,
    1,
  );
  const other = accounts(store),
    otherId = enqueue(store, other.analyst.token, 'duplicate');
  assert.notEqual(otherId, first.jobId);
  assert.equal(store.getSnapshot(other.analyst.token).metrics.duplicateEvents, 0);
});

test('Retry-After and exponential backoff persist their due times without blocking another job', (t) => {
  const { store, advance, now } = fixture(t),
    pair = accounts(store),
    id = enqueue(store, pair.analyst.token, 'rate_limit');
  let claim = store.claimNext(),
    response = store.sandboxSource(id);
  assert.equal(response.status, 429);
  store.completeAttempt(id, claim.leaseToken, {
    outcome: 'rate_limit',
    httpStatus: 429,
    durationMs: 4,
    message: 'Retry after one second.',
    retryAfterMs: 1000,
  });
  assert.equal(
    job(store, pair.analyst.token, id).nextAttemptAt,
    new Date(now().getTime() + 1000).toISOString(),
  );
  assert.equal(store.claimNext(), null);
  const otherId = enqueue(store, pair.analyst.token);
  source(store, otherId);
  advance(999);
  assert.equal(store.claimNext(), null);
  advance(1);
  ({ claim, response } = source(store, id));
  assert.equal(response.status, 429);
  assert.equal(
    job(store, pair.analyst.token, id).nextAttemptAt,
    new Date(now().getTime() + 20).toISOString(),
  );
  advance(20);
  source(store, id);
  const recovered = job(store, pair.analyst.token, id);
  assert.equal(recovered.status, 'awaiting_review');
  assert.deepEqual(
    recovered.attempts.map((a) => a.outcome),
    ['rate_limit', 'rate_limit', 'success'],
  );
  assert.equal(recovered.sourceAttempts, 3);
});

test('upstream failure reaches a bounded failed queue and explicit restoration replays a new generation', (t) => {
  const { store, advance } = fixture(t),
    pair = accounts(store),
    id = enqueue(store, pair.analyst.token, 'upstream_down');
  for (let i = 0; i < 3; i++) {
    source(store, id);
    advance();
  }
  const failed = job(store, pair.analyst.token, id);
  assert.equal(failed.status, 'dead_letter');
  assert.equal(failed.sourceAttempts, 3);
  assert.equal(store.claimNext(), null);
  assert.throws(
    () =>
      store.replay(pair.analyst.token, id, key(), {
        expectedRevision: failed.revision,
        reason: 'Must explicitly declare connector restoration.',
      }),
    code('INVALID_TEAM_INPUT'),
  );
  store.replay(pair.analyst.token, id, key(), {
    expectedRevision: failed.revision,
    reason: 'Restored the fictional connector for a controlled replay.',
    restoreConnector: true,
  });
  source(store, id);
  const recovered = job(store, pair.analyst.token, id);
  assert.equal(recovered.status, 'awaiting_review');
  assert.equal(recovered.generation, 2);
  assert.equal(recovered.sourceAttempts, 1);
  assert.equal(recovered.sourceRecovered, true);
  assert.deepEqual(
    recovered.attempts.map((a) => a.generation),
    [1, 1, 1, 2],
  );
  assert.match(
    store.trace(pair.analyst.token, id).events.find((e) => e.type === 'connector.restored').message,
    /controlled replay/,
  );
});

test('a lost destination response retries to the same persisted receipt with one write', (t) => {
  const { store, advance } = fixture(t),
    pair = accounts(store),
    id = prepareDelivery(store, pair, 'delivery_timeout');
  let claim = store.claimNext();
  const first = store.sandboxDestination(id, { eventId: claim.eventId, payload: claim.payload });
  assert.equal(first.delayMs, 1500);
  store.completeAttempt(id, claim.leaseToken, {
    outcome: 'timeout',
    httpStatus: null,
    durationMs: 500,
    message: 'Deadline exceeded after the destination commit.',
  });
  assert.equal(store.getSnapshot(pair.analyst.token).metrics.destinationWrites, 1);
  assert.equal(job(store, pair.analyst.token, id).status, 'retry_delivery');
  advance();
  claim = store.claimNext();
  const second = store.sandboxDestination(id, { eventId: claim.eventId, payload: claim.payload });
  assert.deepEqual(second.body, first.body);
  assert.equal(second.delayMs, 0);
  store.completeAttempt(id, claim.leaseToken, {
    outcome: 'success',
    httpStatus: 200,
    durationMs: 5,
    message: 'Existing committed receipt returned.',
    data: second.body,
  });
  const current = job(store, pair.analyst.token, id);
  assert.equal(current.status, 'delivered');
  assert.equal(current.deliveryAttempts, 2);
  assert.equal(store.getSnapshot(pair.analyst.token).metrics.destinationWrites, 1);
  assert.equal(
    store.trace(pair.analyst.token, id).events.filter((e) => e.type === 'destination.committed')
      .length,
    1,
  );
});

test('an invented success without a matching destination receipt cannot mark a job delivered', (t) => {
  const { store } = fixture(t),
    pair = accounts(store),
    id = prepareDelivery(store, pair),
    claim = store.claimNext();
  store.completeAttempt(id, claim.leaseToken, {
    outcome: 'success',
    httpStatus: 200,
    durationMs: 10,
    message: 'Fabricated success.',
    data: { id: 'not-a-persisted-receipt' },
  });
  assert.equal(job(store, pair.analyst.token, id).status, 'retry_delivery');
  assert.equal(store.getSnapshot(pair.analyst.token).metrics.destinationWrites, 0);
});

test('source leases survive restart and stale worker completions cannot overwrite the newer claim', (t) => {
  const path = temporaryDatabase(t);
  let ms = Date.parse('2026-10-28T00:00:00.000Z'),
    store = new TeamStore({ databasePath: path, now: () => new Date(ms), leaseMs: 100 });
  t.after(() => store.close());
  const pair = accounts(store),
    id = enqueue(store, pair.analyst.token),
    first = store.claimNext();
  store.close();
  ms += 101;
  store = new TeamStore({ databasePath: path, now: () => new Date(ms), leaseMs: 100 });
  const second = store.claimNext();
  assert.equal(second.id, id);
  assert.notEqual(second.leaseToken, first.leaseToken);
  assert.equal(second.sourceAttempts, 2);
  const before = job(store, pair.analyst.token, id);
  store.completeAttempt(id, first.leaseToken, {
    outcome: 'success',
    httpStatus: 200,
    durationMs: 3,
    message: 'Late stale completion.',
    data: { reference: 'WRONG-OLD', team: 'Wrong actor', minutes: 999 },
  });
  assert.deepEqual(job(store, pair.analyst.token, id), before);
  const response = store.sandboxSource(id);
  store.completeAttempt(id, second.leaseToken, {
    outcome: 'success',
    httpStatus: 200,
    durationMs: 3,
    message: 'Current lease completed.',
    data: response.body,
  });
  assert.equal(job(store, pair.analyst.token, id).status, 'awaiting_review');
  assert.deepEqual(
    job(store, pair.analyst.token, id).attempts.map((a) => a.outcome),
    ['timeout', 'success'],
  );
  cleanupDatabase(t, path);
});

test('restart recovers a committed destination without another HTTP attempt or write', (t) => {
  const path = temporaryDatabase(t);
  let ms = Date.parse('2026-10-28T00:00:00.000Z'),
    store = new TeamStore({ databasePath: path, now: () => new Date(ms), leaseMs: 100 });
  t.after(() => store.close());
  const pair = accounts(store),
    id = prepareDelivery(store, pair, 'delivery_timeout'),
    claim = store.claimNext();
  const receipt = store.sandboxDestination(id, { eventId: claim.eventId, payload: claim.payload });
  store.close();
  ms += 101;
  store = new TeamStore({ databasePath: path, now: () => new Date(ms), leaseMs: 100 });
  assert.equal(store.claimNext(), null);
  const recovered = job(store, pair.analyst.token, id);
  assert.equal(recovered.status, 'delivered');
  assert.equal(recovered.receipt.id, receipt.body.id);
  assert.equal(recovered.deliveryAttempts, 1);
  assert.equal(store.getSnapshot(pair.analyst.token).metrics.destinationWrites, 1);
  assert.match(
    store.trace(pair.analyst.token, id).events.find((e) => e.type === 'worker.recovered').message,
    /without another write/,
  );
  cleanupDatabase(t, path);
});

test('24-hour expiry revokes both actors and cascade cleanup removes workspace data', (t) => {
  const path = temporaryDatabase(t),
    { store, advance } = fixture(t, { databasePath: path }),
    pair = accounts(store);
  prepareDelivery(store, pair);
  advance(24 * 60 * 60 * 1000);
  assert.throws(() => store.getSnapshot(pair.analyst.token), code('TEAM_LOGIN_REQUIRED'));
  assert.throws(() => store.getSnapshot(pair.approver.token), code('TEAM_LOGIN_REQUIRED'));
  const c = pair.access.credentials[0];
  assert.throws(
    () =>
      store.login({
        workspaceId: pair.access.workspaceId,
        username: c.username,
        password: c.password,
      }),
    code('INVALID_CREDENTIALS'),
  );
  assert.equal(store.claimNext(), null);
  store.cleanupExpired();
  const sql = new DatabaseSync(path);
  t.after(() => sql.close());
  for (const table of [
    'team_workspaces',
    'team_users',
    'team_sessions',
    'team_jobs',
    'team_events',
    'team_attempts',
    'team_commands',
    'team_receipts',
  ]) {
    assert.equal(sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
  }
  cleanupDatabase(t, path);
});

test('workspace, job and replay limits bound public demo state', (t) => {
  const { store, advance } = fixture(t, { maxWorkspaces: 1 }),
    pair = accounts(store);
  assert.throws(() => store.createDemo(), code('TEAM_CAPACITY'));
  const id = enqueue(store, pair.analyst.token, 'upstream_down');
  for (let generation = 1; generation <= 3; generation++) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      source(store, id);
      advance();
    }
    const failed = job(store, pair.analyst.token, id);
    assert.equal(failed.status, 'dead_letter');
    const replay = () =>
      store.replay(pair.analyst.token, id, key(), {
        expectedRevision: failed.revision,
        reason: 'Controlled retry while the fictional source remains down.',
        restoreConnector: false,
      });
    if (generation < 3) replay();
    else assert.throws(replay, code('REPLAY_LIMIT'));
  }
  assert.equal(job(store, pair.analyst.token, id).attempts.length, 9);
  for (let i = 1; i < 40; i++) enqueue(store, pair.analyst.token);
  assert.throws(() => enqueue(store, pair.analyst.token), code('TEAM_JOB_LIMIT'));
  assert.equal(store.getSnapshot(pair.analyst.token).jobs.length, 40);
});
