// Author, creator and maintainer: Dhruba Poudel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../dist/server/app.js';
import { createStore } from '../dist/server/store.js';
import { TeamStore } from '../dist/server/team-store.js';
import { createTeamWorker } from '../dist/server/team-worker.js';

const SECRET = 'private-loopback-key-for-http-tests-only';

async function running(t, { storeOptions = {}, appOptions = {}, workerOptions = {} } = {}) {
  const classicStore = createStore();
  const teamStore = new TeamStore({ retryBaseMs: 5, ...storeOptions });
  const server = createApp({
    store: classicStore,
    teamStore,
    teamSandboxSecret: SECRET,
    sessionCreationsPerMinute: 100,
    mutationsPerMinute: 1000,
    ...appOptions,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const worker = createTeamWorker({
    store: teamStore,
    baseUrl: origin,
    secret: SECRET,
    timeoutMs: 500,
    ...workerOptions,
  });
  t.after(async () => {
    await worker.stop();
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    teamStore.close();
    classicStore.close();
  });
  const request = (route, options = {}) => {
    const {
      method = 'GET',
      cookie,
      data,
      raw,
      key,
      headers = {},
      omitOrigin = false,
      originHeader = appOptions.publicOrigin || origin,
      contentType = 'application/json',
    } = options;
    return fetch(origin + route, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(method !== 'GET' && method !== 'HEAD'
          ? { ...(omitOrigin ? {} : { Origin: originHeader }), 'Content-Type': contentType }
          : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
        ...headers,
      },
      ...(data !== undefined || raw !== undefined ? { body: raw ?? JSON.stringify(data) } : {}),
    });
  };
  const demo = async () => {
    const response = await request('/api/team/demo', { method: 'POST', data: {} });
    assert.equal(response.status, 201, 'A new demo workspace is created once.');
    return response.json();
  };
  const login = async (access, role) => {
    const credential = access.credentials.find((item) => item.role === role);
    assert.ok(credential, `Expected a ${role} demo credential`);
    const response = await request('/api/team/login', {
      method: 'POST',
      data: {
        workspaceId: access.workspaceId,
        username: credential.username,
        password: credential.password,
      },
    });
    assert.equal(response.status, 200);
    const setCookie = response.headers.get('set-cookie');
    assert.ok(setCookie, 'Login sets the actor cookie');
    return {
      response,
      cookie: setCookie.split(';')[0],
      snapshot: await response.json(),
      credential,
    };
  };
  const snapshot = async (cookie) => {
    const response = await request('/api/team/workspace', { cookie });
    assert.equal(response.status, 200);
    return response.json();
  };
  const enqueue = async (cookie, scenario = 'healthy', key = `enqueue-${scenario}`) => {
    const response = await request('/api/team/jobs', {
      method: 'POST',
      cookie,
      key,
      data: { scenario },
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const prepareApproval = async (analyst, approver, scenario = 'healthy') => {
    await enqueue(analyst.cookie, scenario);
    assert.equal(await worker.runOnce(), true);
    const sourceSnapshot = await snapshot(analyst.cookie);
    const sourceJob = sourceSnapshot.jobs[0];
    assert.equal(sourceJob.status, 'awaiting_review');
    const reviewBody = {
      expectedRevision: sourceJob.revision,
      payload: sourceJob.payload,
      reason: 'Checked the fictional source and reconciliation.',
    };
    const reviewed = await request(`/api/team/jobs/${sourceJob.id}/review`, {
      method: 'POST',
      cookie: analyst.cookie,
      key: 'review-job',
      data: reviewBody,
    });
    assert.equal(reviewed.status, 200);
    const reviewSnapshot = await reviewed.json();
    const reviewedJob = reviewSnapshot.jobs.find((job) => job.id === sourceJob.id);
    assert.equal(reviewedJob.status, 'awaiting_approval');
    const approveBody = {
      expectedRevision: reviewedJob.revision,
      reason: 'Independent fictional approver accepted the checked output.',
    };
    const approved = await request(`/api/team/jobs/${sourceJob.id}/approve`, {
      method: 'POST',
      cookie: approver.cookie,
      key: 'approve-job',
      data: approveBody,
    });
    assert.equal(approved.status, 200);
    return { jobId: sourceJob.id, approveBody, approvedSnapshot: await approved.json(), sourceJob };
  };
  return {
    teamStore,
    server,
    worker,
    request,
    demo,
    login,
    snapshot,
    enqueue,
    prepareApproval,
    origin,
  };
}

test('team login requires a real workspace credential and never exposes credentials in a snapshot', async (t) => {
  const api = await running(t);
  assert.equal((await api.request('/api/team/workspace')).status, 401);
  const access = await api.demo();
  assert.equal(access.credentials.length, 2);
  assert.equal((await api.request('/api/team/workspace')).status, 401);
  const analystCredential = access.credentials.find((item) => item.role === 'analyst');
  const wrong = await api.request('/api/team/login', {
    method: 'POST',
    data: {
      workspaceId: access.workspaceId,
      username: analystCredential.username,
      password: 'incorrect-password',
    },
  });
  assert.equal(wrong.status, 401);
  const analyst = await api.login(access, 'analyst');
  assert.equal(analyst.snapshot.actor.role, 'analyst');
  assert.match(analyst.response.headers.get('set-cookie'), /HttpOnly/);
  assert.match(analyst.response.headers.get('set-cookie'), /SameSite=(?:Strict|Lax)/);
  const text = JSON.stringify(analyst.snapshot);
  for (const credential of access.credentials) assert.ok(!text.includes(credential.password));
  assert.ok(!text.includes('passwordHash'));
  assert.ok(!text.includes('token_hash'));
});

test('HTTP team workflow enforces analyst and independent approver permissions through final delivery', async (t) => {
  const api = await running(t);
  const access = await api.demo();
  const analyst = await api.login(access, 'analyst');
  const approver = await api.login(access, 'approver');
  assert.notEqual(analyst.snapshot.actor.id, approver.snapshot.actor.id);
  const forbiddenEnqueue = await api.request('/api/team/jobs', {
    method: 'POST',
    cookie: approver.cookie,
    key: 'approver-enqueue',
    data: { scenario: 'healthy' },
    headers: { 'X-Role': 'analyst' },
  });
  assert.equal(forbiddenEnqueue.status, 403);
  await api.enqueue(analyst.cookie);
  await api.worker.runOnce();
  const source = (await api.snapshot(analyst.cookie)).jobs[0];
  const body = {
    expectedRevision: source.revision,
    payload: source.payload,
    reason: 'Checked the same source against the fictional workflow.',
  };
  const forbiddenReview = await api.request(`/api/team/jobs/${source.id}/review`, {
    method: 'POST',
    cookie: approver.cookie,
    key: 'approver-review',
    data: body,
  });
  assert.equal(forbiddenReview.status, 403);
  const review = await api.request(`/api/team/jobs/${source.id}/review`, {
    method: 'POST',
    cookie: analyst.cookie,
    key: 'analyst-review',
    data: body,
  });
  assert.equal(review.status, 200);
  const reviewed = (await review.json()).jobs[0];
  const approveBody = {
    expectedRevision: reviewed.revision,
    reason: 'Independent approval of the checked fictional record.',
  };
  const selfApproval = await api.request(`/api/team/jobs/${source.id}/approve`, {
    method: 'POST',
    cookie: analyst.cookie,
    key: 'analyst-approve',
    data: approveBody,
    headers: { 'X-Role': 'approver' },
  });
  assert.equal(selfApproval.status, 403);
  const approve = await api.request(`/api/team/jobs/${source.id}/approve`, {
    method: 'POST',
    cookie: approver.cookie,
    key: 'independent-approve',
    data: approveBody,
  });
  assert.equal(approve.status, 200);
  await api.worker.runOnce();
  const final = await api.snapshot(analyst.cookie);
  const job = final.jobs[0];
  assert.equal(job.status, 'delivered');
  assert.notEqual(job.submittedBy, job.approvedBy);
  assert.equal(final.metrics.destinationWrites, 1);
  assert.ok(job.receipt);
  assert.match(job.receipt.payloadSha256, /^[a-f0-9]{64}$/);
  assert.ok(
    job.attempts.some((attempt) => attempt.phase === 'source' && attempt.outcome === 'success'),
  );
  assert.ok(
    job.attempts.some((attempt) => attempt.phase === 'delivery' && attempt.outcome === 'success'),
  );
  assert.ok(final.events.some((event) => event.actorRole === 'analyst'));
  assert.ok(final.events.some((event) => event.actorRole === 'approver'));
  const trace = await api.request(`/api/team/jobs/${job.id}/trace.json`, {
    cookie: analyst.cookie,
  });
  assert.equal(trace.status, 200);
  const traceBody = await trace.json();
  assert.equal(traceBody.author, 'Dhruba Poudel');
  assert.equal(traceBody.creator, 'Dhruba Poudel');
  assert.equal(traceBody.job.id, job.id);
});

test('team mutations reject missing/foreign origins, unexpected fields and wrong body formats', async (t) => {
  const api = await running(t);
  const analyst = await api.login(await api.demo(), 'analyst');
  for (const originHeader of ['https://foreign.example.invalid', 'null']) {
    assert.equal(
      (
        await api.request('/api/team/jobs', {
          method: 'POST',
          cookie: analyst.cookie,
          key: 'bad-origin',
          data: { scenario: 'healthy' },
          originHeader,
        })
      ).status,
      403,
    );
  }
  assert.equal(
    (
      await api.request('/api/team/jobs', {
        method: 'POST',
        cookie: analyst.cookie,
        key: 'missing-origin',
        data: { scenario: 'healthy' },
        omitOrigin: true,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await api.request('/api/team/jobs', {
        method: 'POST',
        cookie: analyst.cookie,
        key: 'foreign-url',
        data: { scenario: 'healthy', url: 'https://arbitrary.example.invalid' },
      })
    ).status,
    422,
  );
  assert.equal(
    (
      await api.request('/api/team/jobs', {
        method: 'POST',
        cookie: analyst.cookie,
        key: 'bad-content',
        raw: '{}',
        contentType: 'text/plain',
      })
    ).status,
    415,
  );
  assert.equal(
    (
      await api.request('/api/team/jobs', {
        method: 'POST',
        cookie: analyst.cookie,
        key: 'bad-json',
        raw: '{broken',
      })
    ).status,
    400,
  );
  assert.equal((await api.snapshot(analyst.cookie)).jobs.length, 0);
});

test('forged classic and actor cookies cannot rotate past the peer mutation limit', async (t) => {
  const api = await running(t, { appOptions: { mutationsPerMinute: 2 } });
  for (let index = 0; index < 3; index++) {
    const response = await api.request('/api/team/not-a-route', {
      method: 'POST',
      data: {},
      cookie: `es_session=forged-classic-${index}; est_actor=forged-actor-${index}`,
    });
    assert.equal(response.status, index < 2 ? 404 : 429);
    if (index === 2) {
      assert.equal((await response.json()).error.code, 'RATE_LIMIT');
      assert.equal(response.headers.get('retry-after'), '60');
    }
  }
  const withoutCookies = await api.request('/api/team/not-a-route', { method: 'POST', data: {} });
  assert.equal(
    withoutCookies.status,
    429,
    'Removing forged cookies does not create a new peer bucket.',
  );
  assert.equal(
    (await api.request('/api/health')).status,
    200,
    'Read-only health checks remain available.',
  );
});

test('team cookies are Secure on configured HTTPS origins and logout revokes the actor session', async (t) => {
  const api = await running(t, { appOptions: { publicOrigin: 'https://studio.example.invalid' } });
  const analyst = await api.login(await api.demo(), 'analyst');
  const cookieHeader = analyst.response.headers.get('set-cookie');
  assert.match(cookieHeader, /^__Host-/);
  assert.match(cookieHeader, /; Secure/);
  assert.match(cookieHeader, /; HttpOnly/);
  assert.ok(!/Domain=/i.test(cookieHeader));
  const logout = await api.request('/api/team/logout', {
    method: 'POST',
    cookie: analyst.cookie,
    data: {},
  });
  assert.equal(logout.status, 200);
  assert.equal((await api.request('/api/team/workspace', { cookie: analyst.cookie })).status, 401);
});

test('team idempotency replays exact requests and rejects changed bodies without extra jobs', async (t) => {
  const api = await running(t);
  const analyst = await api.login(await api.demo(), 'analyst');
  const options = {
    method: 'POST',
    cookie: analyst.cookie,
    key: 'same-job',
    data: { scenario: 'healthy' },
  };
  const first = await api.request('/api/team/jobs', options);
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  const again = await api.request('/api/team/jobs', options);
  assert.equal(again.status, 200);
  assert.equal(again.headers.get('idempotency-replayed'), 'true');
  assert.equal((await again.json()).jobs[0].id, firstBody.jobs[0].id);
  const changed = await api.request('/api/team/jobs', {
    ...options,
    data: { scenario: 'timeout' },
  });
  assert.equal(changed.status, 409);
  assert.equal((await api.snapshot(analyst.cookie)).jobs.length, 1);
});

test('concurrent human decisions use the expected revision so only one review commits', async (t) => {
  const api = await running(t);
  const analyst = await api.login(await api.demo(), 'analyst');
  await api.enqueue(analyst.cookie);
  await api.worker.runOnce();
  const original = (await api.snapshot(analyst.cookie)).jobs[0];
  const decisions = await Promise.all(
    [45, 60].map((minutes) =>
      api.request(`/api/team/jobs/${original.id}/review`, {
        method: 'POST',
        cookie: analyst.cookie,
        key: `competing-review-${minutes}`,
        data: {
          expectedRevision: original.revision,
          payload: { ...original.payload, minutes },
          reason: 'Checked the fictional record using the current source.',
        },
      }),
    ),
  );
  assert.deepEqual(decisions.map((response) => response.status).sort(), [200, 409]);
  const conflict = decisions.find((response) => response.status === 409);
  assert.equal((await conflict.json()).error.code, 'STALE_TEAM_JOB');
  const current = await api.snapshot(analyst.cookie);
  assert.equal(current.jobs[0].status, 'awaiting_approval');
  assert.equal(current.jobs[0].revision, original.revision + 1);
  assert.equal(current.events.filter((event) => event.type === 'review.submitted').length, 1);
});

test('team tenant scoping protects job traces and commands even with an otherwise valid approver', async (t) => {
  const api = await running(t);
  const first = await api.login(await api.demo(), 'analyst');
  const second = await api.login(await api.demo(), 'approver');
  const created = await api.enqueue(first.cookie);
  const job = created.jobs[0];
  assert.equal(
    (await api.request(`/api/team/jobs/${job.id}/trace.json`, { cookie: second.cookie })).status,
    404,
  );
  assert.equal(
    (
      await api.request(`/api/team/jobs/${job.id}/approve`, {
        method: 'POST',
        cookie: second.cookie,
        key: 'foreign-approve',
        data: { expectedRevision: job.revision, reason: 'This belongs to a different workspace.' },
      })
    ).status,
    404,
  );
  assert.equal((await api.snapshot(second.cookie)).jobs.length, 0);
});

test('unsigned loopback source and destination requests are refused before any destination write', async (t) => {
  const api = await running(t);
  const analyst = await api.login(await api.demo(), 'analyst');
  const created = await api.enqueue(analyst.cookie);
  const job = created.jobs[0];
  assert.equal((await api.request(`/api/team/sandbox/${job.id}/source`)).status, 403);
  assert.equal(
    (
      await api.request(`/api/team/sandbox/${job.id}/source`, {
        headers: { 'X-Team-Sandbox-Secret': 'a-different-private-key' },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await api.request(`/api/team/sandbox/${job.id}/destination`, {
        method: 'POST',
        data: {
          eventId: job.eventId,
          payload: { reference: 'WO-1042', team: 'North', minutes: 45 },
        },
      })
    ).status,
    403,
  );
  assert.equal((await api.snapshot(analyst.cookie)).metrics.destinationWrites, 0);
});

test('actual HTTP rate limits are persisted, retried and visibly recovered', async (t) => {
  let clock = Date.parse('2026-10-28T01:00:00Z');
  const api = await running(t, { storeOptions: { now: () => new Date(clock) } });
  const analyst = await api.login(await api.demo(), 'analyst');
  await api.enqueue(analyst.cookie, 'rate_limit');
  for (let index = 0; index < 2; index++) {
    assert.equal(await api.worker.runOnce(), true);
    const job = (await api.snapshot(analyst.cookie)).jobs[0];
    assert.equal(job.status, 'retry_source');
    assert.equal(job.attempts.at(-1).outcome, 'rate_limit');
    assert.equal(job.attempts.at(-1).httpStatus, 429);
    assert.ok(
      Date.parse(job.nextAttemptAt) >= clock + 1000,
      'The worker respects the actual Retry-After header.',
    );
    clock += 999;
    assert.equal(
      await api.worker.runOnce(),
      false,
      'Retry is not claimed before the upstream permits it.',
    );
    clock += 1;
  }
  await api.worker.runOnce();
  const job = (await api.snapshot(analyst.cookie)).jobs[0];
  assert.equal(job.status, 'awaiting_review');
  assert.equal(job.sourceAttempts, 3);
  assert.equal(job.attempts.length, 3);
});

test('two concurrent HTTP workers cannot claim or execute the same source job twice', async (t) => {
  const api = await running(t);
  const analyst = await api.login(await api.demo(), 'analyst');
  await api.enqueue(analyst.cookie);
  const second = createTeamWorker({
    store: api.teamStore,
    baseUrl: api.origin,
    secret: SECRET,
    timeoutMs: 500,
  });
  t.after(async () => second.stop());
  const claims = await Promise.all([api.worker.runOnce(), second.runOnce()]);
  assert.equal(claims.filter(Boolean).length, 1);
  const job = (await api.snapshot(analyst.cookie)).jobs[0];
  assert.equal(job.status, 'awaiting_review');
  assert.equal(job.sourceAttempts, 1);
  assert.equal(job.attempts.length, 1);
  assert.equal(job.attempts[0].httpStatus, 200);
});

test('an actual source HTTP timeout preserves the event and recovers only when the retry is due', async (t) => {
  let clock = Date.parse('2026-10-28T01:00:00Z');
  const api = await running(t, { storeOptions: { now: () => new Date(clock) } });
  const analyst = await api.login(await api.demo(), 'analyst');
  const queued = await api.enqueue(analyst.cookie, 'timeout');
  const eventId = queued.jobs[0].eventId;
  await api.worker.runOnce();
  const uncertain = (await api.snapshot(analyst.cookie)).jobs[0];
  assert.equal(uncertain.status, 'retry_source');
  assert.equal(uncertain.eventId, eventId);
  assert.equal(uncertain.sourceRaw, null);
  assert.equal(uncertain.attempts[0].outcome, 'timeout');
  assert.equal(uncertain.attempts[0].httpStatus, null);
  assert.equal(await api.worker.runOnce(), false);
  clock = Date.parse(uncertain.nextAttemptAt);
  await api.worker.runOnce();
  const recovered = (await api.snapshot(analyst.cookie)).jobs[0];
  assert.equal(recovered.status, 'awaiting_review');
  assert.equal(recovered.eventId, eventId);
  assert.equal(recovered.sourceAttempts, 2);
  assert.deepEqual(
    recovered.attempts.map((attempt) => attempt.outcome),
    ['timeout', 'success'],
  );
  assert.match(recovered.sourceSha256, /^[a-f0-9]{64}$/);
});

test('lost delivery responses retry the same event without writing twice to the HTTP destination', async (t) => {
  let clock = Date.parse('2026-10-28T01:00:00Z');
  const api = await running(t, { storeOptions: { now: () => new Date(clock) } });
  const access = await api.demo();
  const analyst = await api.login(access, 'analyst');
  const approver = await api.login(access, 'approver');
  await api.prepareApproval(analyst, approver, 'delivery_timeout');
  await api.worker.runOnce();
  const uncertain = await api.snapshot(analyst.cookie);
  assert.equal(uncertain.jobs[0].status, 'retry_delivery');
  assert.equal(uncertain.jobs[0].attempts.at(-1).outcome, 'timeout');
  assert.equal(uncertain.metrics.destinationWrites, 1);
  clock += 60_000;
  await api.worker.runOnce();
  const recovered = await api.snapshot(analyst.cookie);
  assert.equal(recovered.jobs[0].status, 'delivered');
  assert.equal(recovered.metrics.destinationWrites, 1);
  assert.equal(recovered.jobs[0].deliveryAttempts, 2);
  assert.ok(recovered.jobs[0].receipt);
  const deliveries = recovered.jobs[0].attempts.filter((attempt) => attempt.phase === 'delivery');
  assert.deepEqual(
    deliveries.map((attempt) => attempt.outcome),
    ['timeout', 'success'],
  );
});

test('schema drift is held for explicit analyst repair and preserves original source evidence', async (t) => {
  const api = await running(t);
  const analyst = await api.login(await api.demo(), 'analyst');
  await api.enqueue(analyst.cookie, 'schema_drift');
  await api.worker.runOnce();
  const held = (await api.snapshot(analyst.cookie)).jobs[0];
  assert.equal(held.status, 'schema_error');
  assert.ok(held.sourceRaw);
  assert.match(held.sourceSha256, /^[a-f0-9]{64}$/);
  const original = JSON.stringify(held.sourceRaw);
  const response = await api.request(`/api/team/jobs/${held.id}/review`, {
    method: 'POST',
    cookie: analyst.cookie,
    key: 'repair-schema',
    data: {
      expectedRevision: held.revision,
      payload: { reference: 'WO-1042', team: 'North operations', minutes: 45 },
      reason: 'Confirmed the fictional changed source fields and documented their mapping.',
    },
  });
  assert.equal(response.status, 200);
  const repaired = (await response.json()).jobs[0];
  assert.equal(repaired.status, 'awaiting_approval');
  assert.equal(JSON.stringify(repaired.sourceRaw), original);
  assert.equal(repaired.sourceSha256, held.sourceSha256);
});

test('exhausted upstream jobs require an explicit restore and replay and keep attempt history', async (t) => {
  let clock = Date.parse('2026-10-28T01:00:00Z');
  const api = await running(t, { storeOptions: { now: () => new Date(clock) } });
  const analyst = await api.login(await api.demo(), 'analyst');
  await api.enqueue(analyst.cookie, 'upstream_down');
  for (let count = 0; count < 3; count++) {
    await api.worker.runOnce();
    clock += 60_000;
  }
  const failed = (await api.snapshot(analyst.cookie)).jobs[0];
  assert.equal(failed.status, 'dead_letter');
  assert.equal(failed.attempts.length, 3);
  const replay = await api.request(`/api/team/jobs/${failed.id}/replay`, {
    method: 'POST',
    cookie: analyst.cookie,
    key: 'restore-replay',
    data: {
      expectedRevision: failed.revision,
      reason: 'Restored the fictional endpoint and authorised a new attempt generation.',
      restoreConnector: true,
    },
  });
  assert.equal(replay.status, 200);
  const replayed = (await replay.json()).jobs[0];
  assert.equal(replayed.generation, failed.generation + 1);
  await api.worker.runOnce();
  const recovered = (await api.snapshot(analyst.cookie)).jobs[0];
  assert.equal(recovered.status, 'awaiting_review');
  assert.equal(recovered.attempts.length, 4);
});
