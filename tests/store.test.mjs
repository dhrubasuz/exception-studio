// Author, creator and maintainer: Dhruba Poudel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../dist/server/store.js';

const key = (label) => 'request-' + label;
const expectCode = (code) => (error) => error.code === code;
function removeTestDirectory(directory) {
  const target = resolve(directory),
    parent = resolve(tmpdir());
  assert.ok(
    target.startsWith(parent + sep) && basename(target).startsWith('exception-studio-'),
    'Cleanup stays in the named temporary test directory.',
  );
  rmSync(target, { recursive: true, force: true });
}
function setup(t, options = {}) {
  const store = createStore(options);
  t.after(() => store.close());
  return store;
}
function imported(store, fixtureId = 'mixed') {
  const { token } = store.createSession();
  return { token, snapshot: store.importFixture(token, key('initial'), { fixtureId }).snapshot };
}

test('a new isolated session has no imported data and exposes no access token', (t) => {
  const store = setup(t),
    created = store.createSession();
  assert.match(created.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(created.snapshot.rows.length, 0);
  assert.equal(created.snapshot.revision, 0);
  assert.equal(created.snapshot.activeImport, null);
  assert.ok(!JSON.stringify(created.snapshot).includes(created.token));
  assert.equal(
    new Date(created.snapshot.session.expiresAt) - new Date(created.snapshot.session.createdAt),
    24 * 60 * 60 * 1000,
  );
});
test('import stores six held records and reconciliation counts include every original row', (t) => {
  const store = setup(t),
    { snapshot } = imported(store);
  assert.deepEqual(snapshot.summary, {
    total: 22,
    accepted: 16,
    held: 6,
    excluded: 0,
    changed: 0,
    acceptedMinutes: 1220,
  });
  assert.equal(snapshot.revision, 1);
  assert.equal(snapshot.activeImport.sourceRows, 22);
  assert.match(snapshot.activeImport.sourceSha256, /^[a-f0-9]{64}$/);
});
test('correcting one duplicate never silently accepts its previously held counterpart', (t) => {
  const store = setup(t),
    { token, snapshot } = imported(store);
  const duplicate = snapshot.rows[1];
  const next = store.decide(token, duplicate.id, key('correct-duplicate'), {
    expectedRevision: 1,
    action: 'accept',
    changes: { reference: 'DEMO-002' },
    reason: 'Restored the fictional second reference from its teaching example.',
  }).snapshot;
  assert.equal(next.rows[0].issues.length, 0);
  assert.equal(next.rows[0].decision, 'unreviewed');
  assert.equal(next.rows[1].decision, 'accepted');
  assert.equal(next.rows[1].original.reference, 'DEMO-001');
  assert.equal(next.rows[1].current.reference, 'DEMO-002');
  assert.deepEqual(next.rows[1].changedFields, ['reference']);
  const accepted = store.decide(token, next.rows[0].id, key('review-first'), {
    expectedRevision: 2,
    action: 'accept',
    reason: 'Reviewed the remaining original reference.',
  }).snapshot;
  assert.equal(accepted.summary.held, 4);
});
test('invalid corrections roll back row state, revision, events and retry-key allocation', (t) => {
  const store = setup(t),
    { token, snapshot } = imported(store),
    row = snapshot.rows[4];
  const before = store.getSnapshot(token);
  assert.throws(
    () =>
      store.decide(token, row.id, key('invalid'), {
        expectedRevision: 1,
        action: 'accept',
        changes: { team: '' },
        reason: 'Still invalid.',
      }),
    expectCode('RECORD_INVALID'),
  );
  assert.deepEqual(store.getSnapshot(token), before);
  const corrected = store.decide(token, row.id, key('invalid'), {
    expectedRevision: 1,
    action: 'accept',
    changes: { team: 'Business systems' },
    reason: 'Corrected with fictional data.',
  }).snapshot;
  assert.equal(corrected.revision, 2);
  assert.equal(corrected.rows[4].original.team, '');
  assert.equal(corrected.rows[4].current.team, 'Business systems');
});
test('stale decisions are rejected with the current revision and no side effect', (t) => {
  const store = setup(t),
    { token, snapshot } = imported(store, 'clean'),
    row = snapshot.rows[0];
  store.decide(token, row.id, key('first'), {
    expectedRevision: 1,
    action: 'accept',
    changes: { team: 'Web operations' },
    reason: 'First review.',
  });
  const before = store.getSnapshot(token);
  assert.throws(
    () =>
      store.decide(token, row.id, key('second'), {
        expectedRevision: 1,
        action: 'exclude',
        reason: 'Stale review.',
      }),
    (error) => error.code === 'REVISION_CONFLICT' && error.details.currentRevision === 2,
  );
  assert.deepEqual(store.getSnapshot(token), before);
});
test('identical retries return the exact original response even after a later mutation', (t) => {
  const store = setup(t),
    { token, snapshot } = imported(store, 'clean'),
    row = snapshot.rows[0];
  const command = {
    expectedRevision: 1,
    action: 'accept',
    changes: { team: 'Web operations' },
    reason: 'First review.',
  };
  const first = store.decide(token, row.id, key('retry'), command);
  store.decide(token, snapshot.rows[1].id, key('later'), {
    expectedRevision: 2,
    action: 'exclude',
    reason: 'A later decision.',
  });
  const replay = store.decide(token, row.id, key('retry'), {
    reason: command.reason,
    changes: command.changes,
    action: command.action,
    expectedRevision: command.expectedRevision,
  });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.snapshot, first.snapshot);
  assert.equal(store.getSnapshot(token).revision, 3);
  assert.throws(
    () => store.decide(token, row.id, key('retry'), { ...command, reason: 'Different content.' }),
    expectCode('IDEMPOTENCY_CONFLICT'),
  );
});
test('imports are idempotent, and unrecognised public data is never imported', (t) => {
  const store = setup(t),
    { token } = store.createSession();
  const first = store.importFixture(token, key('sample'), { fixtureId: 'mixed' });
  assert.deepEqual(
    store.importFixture(token, key('sample'), { fixtureId: 'mixed' }).snapshot,
    first.snapshot,
  );
  assert.throws(
    () => store.importFixture(token, key('sample'), { fixtureId: 'clean' }),
    expectCode('IDEMPOTENCY_CONFLICT'),
  );
  assert.throws(
    () =>
      store.importFixture(token, key('upload'), {
        fixtureId: 'mixed',
        csv: 'private arbitrary data',
      }),
    expectCode('FICTIONAL_FIXTURES_ONLY'),
  );
  assert.throws(
    () => store.importFixture(token, undefined, { fixtureId: 'clean' }),
    expectCode('IDEMPOTENCY_REQUIRED'),
  );
  assert.equal(store.getSnapshot(token).revision, 1);
});
test('exclusions require reasons, preserve source context and reconcile exactly', (t) => {
  const store = setup(t),
    { token, snapshot } = imported(store),
    row = snapshot.rows[4];
  assert.throws(
    () =>
      store.decide(token, row.id, key('no-reason'), {
        expectedRevision: 1,
        action: 'exclude',
        reason: '',
      }),
    expectCode('REASON_REQUIRED'),
  );
  assert.throws(
    () =>
      store.decide(token, row.id, key('combined'), {
        expectedRevision: 1,
        action: 'exclude',
        changes: { team: 'Ops' },
        reason: 'Combined action.',
      }),
    expectCode('EXCLUSION_WITH_CHANGE'),
  );
  const next = store.decide(token, row.id, key('exclude'), {
    expectedRevision: 1,
    action: 'exclude',
    reason: 'Outside this fictional reporting scope.',
  }).snapshot;
  assert.equal(next.summary.excluded, 1);
  assert.equal(
    next.summary.accepted + next.summary.held + next.summary.excluded,
    next.summary.total,
  );
  assert.equal(next.rows[4].original.team, '');
  assert.equal(next.rows[4].decision, 'excluded');
});
test('unresolved exceptions block publication with no partial publication or event', (t) => {
  const store = setup(t),
    { token } = imported(store),
    before = store.getSnapshot(token);
  assert.throws(
    () => store.publish(token, key('blocked'), { expectedRevision: 1 }),
    expectCode('UNRESOLVED_RECORDS'),
  );
  assert.deepEqual(store.getSnapshot(token), before);
});
test('frozen CSV and manifest survive later edits, another import and database restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'exception-studio-'));
  const databasePath = join(directory, 'test.sqlite');
  let store = createStore({ databasePath });
  try {
    const { token, snapshot } = imported(store, 'clean');
    const published = store.publish(token, key('publish'), { expectedRevision: 1 }).snapshot;
    assert.equal(published.revision, 1);
    const publication = published.publications[0],
      original = store.publication(token, publication.id),
      manifest = JSON.parse(original.manifestJson);
    assert.equal(manifest.author, 'Dhruba Poudel');
    assert.equal(manifest.dataSha256, createHash('sha256').update(original.csv).digest('hex'));
    assert.equal(manifest.csvBytes, original.csv.length);
    assert.equal(manifest.counts.accepted, 22);
    const repeated = store.publish(token, key('new-publish-key'), { expectedRevision: 1 }).snapshot;
    assert.equal(repeated.publications.length, 1);
    assert.equal(repeated.events.filter((event) => event.type === 'dataset.published').length, 1);
    store.decide(token, snapshot.rows[0].id, key('edit-after'), {
      expectedRevision: 1,
      action: 'accept',
      changes: { team: '=1+1' },
      reason: 'Fictional spreadsheet formula neutralisation test.',
    });
    const second = store.publish(token, key('second-publication'), { expectedRevision: 2 }).snapshot
      .publications[0];
    assert.ok(
      Buffer.from(store.publication(token, second.id).csv).toString('utf8').includes("'=1+1"),
    );
    store.importFixture(token, key('new-import'), { fixtureId: 'mixed' });
    store.close();
    store = createStore({ databasePath });
    const reopened = store.publication(token, publication.id);
    assert.deepEqual(reopened, original);
    assert.equal(store.getSnapshot(token).publications.length, 2);
  } finally {
    store.close();
    removeTestDirectory(directory);
  }
});
test('a sandbox cannot read or decide another sandbox’s records or publications', (t) => {
  const store = setup(t),
    first = imported(store, 'clean'),
    second = imported(store, 'clean');
  const publication = store.publish(first.token, key('publish'), { expectedRevision: 1 }).snapshot
    .publications[0];
  assert.throws(
    () => store.publication(second.token, publication.id),
    (error) => error.status === 404,
  );
  assert.throws(
    () =>
      store.decide(second.token, first.snapshot.rows[0].id, key('cross'), {
        expectedRevision: 1,
        action: 'exclude',
        reason: 'Cross-sandbox attempt.',
      }),
    (error) => error.status === 404,
  );
  assert.equal(store.getSnapshot(first.token).revision, 1);
  assert.equal(store.getSnapshot(second.token).revision, 1);
});
test('access expires at the stated boundary and expired capacity can be reclaimed', (t) => {
  let now = new Date('2026-10-26T00:00:00Z');
  const store = setup(t, { now: () => now, maxSandboxes: 1 }),
    first = store.createSession();
  assert.throws(() => store.createSession(), expectCode('CAPACITY'));
  now = new Date('2026-10-27T00:00:00Z');
  assert.throws(() => store.getSnapshot(first.token), expectCode('SESSION_REQUIRED'));
  assert.ok(store.createSession().token);
});
test('import/publication counts enforce declared limits without evicting an older snapshot', (t) => {
  const store = setup(t),
    { token } = store.createSession();
  for (let index = 0; index < 20; index += 1) {
    const snapshot = store.importFixture(token, key('import-' + index), {
      fixtureId: 'clean',
    }).snapshot;
    store.publish(token, key('publication-' + index), { expectedRevision: snapshot.revision });
  }
  const before = store.getSnapshot(token);
  assert.equal(before.publications.length, 20);
  assert.throws(
    () => store.importFixture(token, key('too-many'), { fixtureId: 'clean' }),
    expectCode('IMPORT_LIMIT'),
  );
  assert.deepEqual(store.getSnapshot(token), before);
  const edited = store.decide(token, before.rows[0].id, key('after-cap'), {
    expectedRevision: before.revision,
    action: 'accept',
    changes: { team: 'Web operations' },
    reason: 'Fictional later revision.',
  }).snapshot;
  assert.throws(
    () => store.publish(token, key('too-many-publications'), { expectedRevision: edited.revision }),
    expectCode('PUBLICATION_LIMIT'),
  );
  assert.equal(store.getSnapshot(token).publications.length, 20);
});
test('database triggers reject direct updates to immutable source and publication content', () => {
  const directory = mkdtempSync(join(tmpdir(), 'exception-studio-trigger-')),
    databasePath = join(directory, 'test.sqlite');
  const store = createStore({ databasePath });
  const created = imported(store, 'clean');
  store.publish(created.token, key('publish'), { expectedRevision: 1 });
  const connection = new DatabaseSync(databasePath);
  try {
    assert.throws(
      () =>
        connection
          .prepare('UPDATE source_rows SET original_json = ? WHERE id = ?')
          .run('{}', created.snapshot.rows[0].id),
      /immutable/,
    );
    assert.throws(() => connection.exec("UPDATE imports SET source_csv = 'changed'"), /immutable/);
    assert.throws(
      () => connection.exec("UPDATE publications SET manifest_json = '{}'"),
      /immutable/,
    );
    assert.equal(store.getSnapshot(created.token).rows[0].original.reference, 'DEMO-001');
  } finally {
    connection.close();
    store.close();
    removeTestDirectory(directory);
  }
});
