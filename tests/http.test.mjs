// Author, creator and maintainer: Dhruba Poudel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, sep, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../dist/server/app.js';
import { createStore } from '../dist/server/store.js';

function removeTestDirectory(directory) {
  const target = resolve(directory), parent = resolve(tmpdir());
  assert.ok(target.startsWith(parent + sep) && basename(target).startsWith('exception-studio-'), 'Cleanup stays in the named temporary test directory.');
  rmSync(target, { recursive: true, force: true });
}

async function running(t, options = {}) {
  const store = createStore();
  const server = createApp({ store, sessionCreationsPerMinute: 100, mutationsPerMinute: 1000, ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); store.close(); });
  const request = (path, { method = 'GET', cookie, data, key, originHeader = origin, contentType = 'application/json', raw } = {}) => fetch(origin + path, {
    method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method !== 'GET' && method !== 'HEAD' ? { Origin: originHeader, 'Content-Type': contentType } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
    ...(data !== undefined || raw !== undefined ? { body: raw ?? JSON.stringify(data) } : {}),
  });
  const session = async () => { const response = await request('/api/session'); return { response, cookie: response.headers.get('set-cookie').split(';')[0], snapshot: await response.json() }; };
  return { store, server, request, session, origin };
}

test('HTTP sessions set a private cookie and resume the same persistent sandbox', async t => {
  const api = await running(t), first = await api.session();
  assert.equal(first.response.status, 201);
  assert.match(first.response.headers.get('set-cookie'), /HttpOnly; SameSite=Lax; Path=\//);
  assert.ok(!first.response.headers.get('access-control-allow-origin'));
  const resumed = await api.request('/api/session', { cookie: first.cookie });
  assert.equal(resumed.status, 200);
  assert.deepEqual(await resumed.json(), first.snapshot);
  assert.equal((await api.request('/api/workspace')).status, 401);
});
test('a configured HTTPS origin produces Secure cookies and strict origin comparison', async t => {
  const api = await running(t, { publicOrigin: 'https://studio.example.invalid' }), first = await api.session();
  assert.match(first.response.headers.get('set-cookie'), /; Secure/);
  assert.match(first.response.headers.get('set-cookie'), /^__Host-es_session=/);
  const rejected = await api.request('/api/imports', { method: 'POST', cookie: first.cookie, data: { fixtureId: 'clean' }, key: 'import-https' });
  assert.equal(rejected.status, 403);
  const allowed = await api.request('/api/imports', { method: 'POST', cookie: first.cookie, data: { fixtureId: 'clean' }, key: 'import-https', originHeader: 'https://studio.example.invalid' });
  assert.equal(allowed.status, 200);
});
test('missing or foreign origins, non-JSON bodies and malformed JSON fail without import', async t => {
  const api = await running(t), session = await api.session();
  for (const originHeader of ['https://attacker.example.invalid', 'null']) {
    assert.equal((await api.request('/api/imports', { method: 'POST', cookie: session.cookie, data: { fixtureId: 'mixed' }, key: 'import-foreign', originHeader })).status, 403);
  }
  const absent = await fetch(api.origin + '/api/imports', { method: 'POST', headers: { Cookie: session.cookie, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(absent.status, 403);
  assert.equal((await api.request('/api/imports', { method: 'POST', cookie: session.cookie, data: {}, key: 'import-form', contentType: 'text/plain' })).status, 415);
  assert.equal((await api.request('/api/imports', { method: 'POST', cookie: session.cookie, raw: '{ broken', key: 'import-json' })).status, 400);
  const snapshot = await (await api.request('/api/workspace', { cookie: session.cookie })).json();
  assert.equal(snapshot.revision, 0);
});
test('request size and fictional fixture boundaries fail explicitly', async t => {
  const api = await running(t), session = await api.session();
  const huge = await api.request('/api/imports', { method: 'POST', cookie: session.cookie, key: 'huge-body', data: { fixtureId: 'mixed', data: 'x'.repeat(65_537) } });
  assert.equal(huge.status, 413);
  const upload = await api.request('/api/imports', { method: 'POST', cookie: session.cookie, key: 'no-upload', data: { csv: 'arbitrary private text' } });
  assert.equal(upload.status, 403);
  assert.equal((await upload.json()).error.code, 'FICTIONAL_FIXTURES_ONLY');
});
test('concurrent decisions from one revision produce exactly one success and one conflict', async t => {
  const api = await running(t), session = await api.session();
  const imported = await (await api.request('/api/imports', { method: 'POST', cookie: session.cookie, key: 'concurrent-import', data: { fixtureId: 'clean' } })).json();
  const row = imported.rows[0];
  const responses = await Promise.all(['first', 'second'].map(name => api.request(`/api/rows/${row.id}/decision`, { method: 'PATCH', cookie: session.cookie, key: 'review-' + name,
    data: { expectedRevision: 1, action: 'accept', changes: { team: name === 'first' ? 'Web operations' : 'Infrastructure' }, reason: 'Fictional concurrent ' + name + ' review.' } })));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const snapshot = await (await api.request('/api/workspace', { cookie: session.cookie })).json();
  assert.equal(snapshot.revision, 2);
  assert.equal(snapshot.events.filter(event => event.type === 'row.accepted').length, 1);
  assert.ok(['Web operations', 'Infrastructure'].includes(snapshot.rows[0].current.team));
});
test('HTTP retries expose replay status, and changed retry content does not mutate state', async t => {
  const api = await running(t), session = await api.session();
  const options = { method: 'POST', cookie: session.cookie, key: 'same-import-retry', data: { fixtureId: 'clean' } };
  const first = await api.request('/api/imports', options), firstBody = await first.json();
  const replay = await api.request('/api/imports', options);
  assert.equal(first.headers.get('idempotency-replayed'), 'false');
  assert.equal(replay.headers.get('idempotency-replayed'), 'true');
  assert.deepEqual(await replay.json(), firstBody);
  const mismatch = await api.request('/api/imports', { ...options, data: { fixtureId: 'mixed' } });
  assert.equal(mismatch.status, 409);
  assert.equal((await mismatch.json()).error.code, 'IDEMPOTENCY_CONFLICT');
});
test('frozen publication downloads have exact bytes, metadata and cross-sandbox protection', async t => {
  const api = await running(t), session = await api.session(), second = await api.session();
  await api.request('/api/imports', { method: 'POST', cookie: session.cookie, key: 'publish-import', data: { fixtureId: 'clean' } });
  const published = await (await api.request('/api/publications', { method: 'POST', cookie: session.cookie, key: 'publish-request', data: { expectedRevision: 1 } })).json();
  const item = published.publications[0];
  const csv = await api.request(item.csvUrl, { cookie: session.cookie });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /^text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /^attachment; filename="exception-studio-/);
  const text = await csv.text();
  assert.ok(text.startsWith('reference,team,opened,due,status,minutes\r\n'));
  assert.equal(text.trim().split('\r\n').length, 23);
  const manifest = await (await api.request(item.manifestUrl, { cookie: session.cookie })).json();
  assert.equal(manifest.counts.total, 22);
  assert.equal(manifest.csvBytes, Buffer.byteLength(text));
  assert.equal((await api.request(item.csvUrl, { cookie: second.cookie })).status, 404);
});
test('new-sandbox creation is rate limited without blocking an existing sandbox', async t => {
  const api = await running(t, { sessionCreationsPerMinute: 2 });
  const first = await api.session(); await api.session();
  const refused = await api.request('/api/session');
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get('retry-after'), '60');
  assert.equal((await api.request('/api/session', { cookie: first.cookie })).status, 200);
});
test('fresh sandbox POST does not delete the previous sandbox or accept extra input', async t => {
  const api = await running(t), first = await api.session();
  const invalid = await api.request('/api/session', { method: 'POST', cookie: first.cookie, data: { token: 'not accepted' } });
  assert.equal(invalid.status, 422);
  const fresh = await api.request('/api/session', { method: 'POST', cookie: first.cookie, data: {} });
  assert.equal(fresh.status, 201);
  assert.notEqual((await fresh.json()).session.id, first.snapshot.session.id);
  assert.equal((await api.request('/api/workspace', { cookie: first.cookie })).status, 200);
});
test('static assets are same-origin, API misses never return HTML, and private paths are unavailable', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'exception-studio-static-'));
  mkdirSync(join(directory, 'assets'));
  writeFileSync(join(directory, 'index.html'), '<!doctype html><title>Fixture client</title>');
  writeFileSync(join(directory, 'assets', 'app.js'), 'console.log("fixture");');
  writeFileSync(join(directory, '.env'), 'A fixture that must not be served.');
  writeFileSync(join(directory, 'misplaced.sqlite'), 'A fixture that must not be served.');
  t.after(() => removeTestDirectory(directory));
  const api = await running(t, { clientDirectory: directory });
  const home = await api.request('/');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  const asset = await api.request('/assets/app.js');
  assert.match(asset.headers.get('content-type'), /^text\/javascript/);
  assert.equal((await api.request('/api/absent')).status, 404);
  assert.equal((await api.request('/.env')).status, 404);
  assert.equal((await api.request('/misplaced.sqlite')).status, 404);
  assert.equal((await api.request('/%2e%2e%5cprivate.sqlite')).status, 400);
  const health = await (await api.request('/api/health')).json();
  assert.equal(health.storage, 'sqlite');
  assert.ok(!JSON.stringify(health).includes(directory));
});
