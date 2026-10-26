// Author, creator and maintainer: Dhruba Poudel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureSource, parseCsv, recordsCsv, validateRecords, csvCell, canonicalJson } from '../dist/server/domain.js';

const valid = () => ({ reference: 'DEMO-001', team: 'Service desk', opened: '2026-10-01', due: '2026-10-05', status: 'open', minutes: '15' });
const issuesFor = record => validateRecords([{ id: 'a', current: record }]).get('a');

test('the fixed mixed sample reconciles to 22 records with six held records', () => {
  const records = parseCsv(fixtureSource('mixed').csv);
  const validation = validateRecords(records.map((row, index) => ({ id: String(index), current: row.record })));
  assert.equal(records.length, 22);
  assert.equal([...validation.values()].filter(value => value.length > 0).length, 6);
  assert.equal(records[0].lineNumber, 2);
  assert.equal(records.at(-1).lineNumber, 23);
});
test('the clean sample has the same row count without validation issues', () => {
  const rows = parseCsv(fixtureSource('clean').csv).map((row, index) => ({ id: String(index), current: row.record }));
  assert.equal([...validateRecords(rows).values()].flat().length, 0);
});
test('quoted commas, escaped quotes, multiline values and physical source lines round-trip', () => {
  const first = valid(), second = { ...valid(), reference: 'DEMO-002', team: 'Web, "ops"\nsecond line' };
  const parsed = parseCsv(recordsCsv([first, second, { ...valid(), reference: 'DEMO-003' }]));
  assert.deepEqual(parsed[1].record, second);
  assert.equal(parsed[2].lineNumber, 5);
});
test('BOM, LF, blank physical rows and final unterminated record preserve correct context', () => {
  const source = '\ufeffreference,team,opened,due,status,minutes\n\nDEMO-001,Ops,2026-10-01,2026-10-02,open,0';
  const parsed = parseCsv(source);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].lineNumber, 3);
  assert.equal(parsed[0].record.minutes, '0');
});
test('malformed quotes, headers and column counts fail the whole import', () => {
  const head = 'reference,team,opened,due,status,minutes\n';
  for (const source of [head + 'DEMO-1,"Ops,2026-10-01,2026-10-02,open,0', head + 'DEMO-1,"Ops"x,2026-10-01,2026-10-02,open,0', head + 'DEMO-1,Ops,2026-10-01,open,0', 'reference,team,opened,due,status,status\n']) assert.throws(() => parseCsv(source));
});
test('200 records are accepted at the boundary; empty, oversized and excess records fail', () => {
  const rows = Array.from({ length: 200 }, (_, index) => ({ ...valid(), reference: 'DEMO-' + index }));
  assert.equal(parseCsv(recordsCsv(rows)).length, 200);
  assert.throws(() => parseCsv(recordsCsv([...rows, valid()])), error => error.code === 'ROW_LIMIT');
  assert.throws(() => parseCsv(recordsCsv([])), error => error.code === 'ROW_LIMIT');
  assert.throws(() => parseCsv('x'.repeat(65_537)), error => error.status === 413);
  assert.throws(() => parseCsv(recordsCsv([{ ...valid(), team: 'x'.repeat(1001) }])), error => error.code === 'SOURCE_LIMIT');
});
test('real calendar dates and chronology reject rollover, missing values and inverted dates', () => {
  assert.equal(issuesFor({ ...valid(), opened: '2024-02-29', due: '2024-03-01' }).length, 0);
  assert.ok(issuesFor({ ...valid(), due: '2026-02-30' }).some(issue => issue.code === 'INVALID_DATE'));
  assert.ok(issuesFor({ ...valid(), due: '2026-09-30' }).some(issue => issue.code === 'DATE_ORDER'));
  assert.ok(issuesFor({ ...valid(), opened: '' }).some(issue => issue.code === 'REQUIRED'));
});
test('every case-insensitive duplicate is held, and excluded records leave duplicate matching', () => {
  const rows = [{ id: 'a', current: valid() }, { id: 'b', current: { ...valid(), reference: 'demo-001' } }];
  assert.ok([...validateRecords(rows).values()].every(issues => issues.some(issue => issue.code === 'DUPLICATE_REFERENCE')));
  assert.equal(validateRecords([rows[0], { ...rows[1], excluded: true }]).get('a').length, 0);
});
test('numeric and status boundaries are explicit and finite', () => {
  for (const minutes of ['0', '100000']) assert.equal(issuesFor({ ...valid(), minutes }).length, 0);
  for (const minutes of ['-1', '100001', 'NaN', '1.2', '1e3']) assert.ok(issuesFor({ ...valid(), minutes }).some(issue => issue.code === 'INVALID_MINUTES'));
  assert.ok(issuesFor({ ...valid(), status: 'waiting' }).some(issue => issue.code === 'INVALID_STATUS'));
  assert.ok(issuesFor({ ...valid(), reference: '=1+1' }).some(issue => issue.code === 'INVALID_REFERENCE'));
});
test('spreadsheet formula prefixes are neutralised while quoted CSV remains parseable', () => {
  for (const value of ['=1+1', '+SUM(A1)', '-2', '@command', ' \t=1']) assert.equal(csvCell(value, true), "'" + value);
  const csv = recordsCsv([{ ...valid(), team: '=HYPERLINK("https://example.invalid")' }], true);
  assert.equal(parseCsv(csv)[0].record.team, '\'=HYPERLINK("https://example.invalid")');
  assert.equal(csvCell('Operations', true), 'Operations');
});
test('canonical request fingerprints do not depend on object property order', () => {
  assert.equal(canonicalJson({ changes: { team: 'Ops', minutes: '2' }, reason: 'Checked' }), canonicalJson({ reason: 'Checked', changes: { minutes: '2', team: 'Ops' } }));
});
