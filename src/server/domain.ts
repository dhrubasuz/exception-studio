// Author, creator and maintainer: Dhruba Poudel.
import { createHash } from 'node:crypto';
import {
  RECORD_FIELDS,
  type FixtureId,
  type OperationalRecord,
  type RecordField,
  type RowView,
  type ValidationIssue,
  type WorkspaceSummary,
} from '../shared/contracts.js';
import { HttpError } from './errors.js';

export const MAX_ROWS = 200;
export const MAX_REQUEST_BYTES = 65_536;
export const MAX_REASON = 280;

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => JSON.stringify(key) + ':' + canonicalJson(item))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}

export function normalizeRecord(value: OperationalRecord): OperationalRecord {
  return Object.fromEntries(
    RECORD_FIELDS.map((field) => [field, value[field].trim()]),
  ) as OperationalRecord;
}

function calendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function validateRecords(
  records: { id: string; current: OperationalRecord; excluded?: boolean }[],
): Map<string, ValidationIssue[]> {
  const result = new Map<string, ValidationIssue[]>();
  const references = new Map<string, string[]>();
  for (const row of records) {
    if (!row.excluded) {
      const key = row.current.reference.trim().toLowerCase();
      if (key) references.set(key, [...(references.get(key) || []), row.id]);
    }
  }
  for (const row of records) {
    const issues: ValidationIssue[] = [];
    const value = row.current;
    const add = (code: ValidationIssue['code'], field: RecordField, message: string) =>
      issues.push({ code, field, message });
    for (const field of RECORD_FIELDS) {
      if (!value[field].trim()) add('REQUIRED', field, `${field} is required.`);
      if (value[field].length > (field === 'team' || field === 'reference' ? 80 : 24))
        add('FIELD_TOO_LONG', field, `${field} exceeds the field limit.`);
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value[field]))
        add('FIELD_TOO_LONG', field, `${field} contains an unsupported control character.`);
    }
    if (value.reference && !/^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(value.reference))
      add(
        'INVALID_REFERENCE',
        'reference',
        'Use a letter followed by letters, numbers, dots, colons, underscores or hyphens.',
      );
    if (!row.excluded && (references.get(value.reference.toLowerCase())?.length || 0) > 1)
      add(
        'DUPLICATE_REFERENCE',
        'reference',
        'Every occurrence of a duplicate reference is held for review.',
      );
    if (value.opened && !calendarDate(value.opened))
      add(
        'INVALID_DATE',
        'opened',
        'Use a real calendar date in YYYY-MM-DD format, from 1900 to 2100.',
      );
    if (value.due && !calendarDate(value.due))
      add(
        'INVALID_DATE',
        'due',
        'Use a real calendar date in YYYY-MM-DD format, from 1900 to 2100.',
      );
    if (calendarDate(value.opened) && calendarDate(value.due) && value.due < value.opened)
      add('DATE_ORDER', 'due', 'The due date cannot be before the opened date.');
    if (value.status && !['open', 'in_progress', 'resolved'].includes(value.status))
      add('INVALID_STATUS', 'status', 'Use open, in_progress or resolved.');
    if (value.minutes && (!/^\d{1,6}$/.test(value.minutes) || Number(value.minutes) > 100_000))
      add('INVALID_MINUTES', 'minutes', 'Minutes must be a whole number from 0 to 100000.');
    result.set(row.id, issues);
  }
  return result;
}

export function summarise(rows: RowView[]): WorkspaceSummary {
  const summary: WorkspaceSummary = {
    total: rows.length,
    accepted: 0,
    held: 0,
    excluded: 0,
    changed: 0,
    acceptedMinutes: 0,
  };
  for (const row of rows) {
    if (row.decision === 'excluded') summary.excluded += 1;
    else if (row.decision === 'accepted' && row.issues.length === 0) {
      summary.accepted += 1;
      summary.acceptedMinutes += Number(row.current.minutes);
    } else summary.held += 1;
    if (row.changedFields.length) summary.changed += 1;
  }
  return summary;
}

export function csvCell(value: string, spreadsheetSafe = false): string {
  const safe = spreadsheetSafe && /^[\s]*[=+\-@\t\r]/.test(value) ? "'" + value : value;
  return /[",\r\n]/.test(safe) ? '"' + safe.replaceAll('"', '""') + '"' : safe;
}
export function recordsCsv(records: OperationalRecord[], spreadsheetSafe = false): string {
  return (
    [
      RECORD_FIELDS.join(','),
      ...records.map((record) =>
        RECORD_FIELDS.map((field) => csvCell(record[field], spreadsheetSafe)).join(','),
      ),
    ].join('\r\n') + '\r\n'
  );
}

/** Bounded RFC4180-style parser; line references survive quoted multiline fields. */
export function parseCsv(source: string): { record: OperationalRecord; lineNumber: number }[] {
  if (Buffer.byteLength(source, 'utf8') > MAX_REQUEST_BYTES)
    throw new HttpError(413, 'SOURCE_TOO_LARGE', 'The source exceeds 64 KiB.');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(source))
    throw new HttpError(422, 'INVALID_CSV', 'CSV contains an unsupported control character.');
  const input = source.replace(/^\ufeff/, '');
  const rows: { cells: string[]; lineNumber: number }[] = [];
  let cells: string[] = [],
    field = '',
    quoted = false,
    closed = false,
    line = 1,
    rowLine = 1;
  const commitField = () => {
    cells.push(field);
    field = '';
    closed = false;
  };
  const commitRow = () => {
    commitField();
    if (cells.some((cell) => cell.trim())) rows.push({ cells, lineNumber: rowLine });
    cells = [];
    rowLine = line + 1;
  };
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          closed = true;
        }
      } else {
        field += char;
        if (char === '\n') line += 1;
      }
    } else if (char === '"') {
      if (field || closed)
        throw new HttpError(422, 'INVALID_CSV', 'A quote appears inside an unquoted field.');
      quoted = true;
    } else if (char === ',') commitField();
    else if (char === '\r' || char === '\n') {
      commitRow();
      if (char === '\r' && input[index + 1] === '\n') index += 1;
      line += 1;
    } else {
      if (closed)
        throw new HttpError(422, 'INVALID_CSV', 'Unexpected text follows a quoted field.');
      field += char;
    }
    if (rows.length > MAX_ROWS + 1)
      throw new HttpError(422, 'ROW_LIMIT', 'Provide between 1 and 200 records.');
    if (field.length > 1000 || cells.length > 6)
      throw new HttpError(422, 'SOURCE_LIMIT', 'The CSV exceeds its field or column limit.');
  }
  if (quoted) throw new HttpError(422, 'INVALID_CSV', 'A quoted field is not closed.');
  if (field || cells.length || closed) {
    commitField();
    if (cells.some((cell) => cell.trim())) rows.push({ cells, lineNumber: rowLine });
  }
  const header = rows.shift();
  if (!header || header.cells.join(',') !== RECORD_FIELDS.join(','))
    throw new HttpError(
      422,
      'INVALID_HEADER',
      'Use the six documented columns in the documented order.',
    );
  if (!rows.length || rows.length > MAX_ROWS)
    throw new HttpError(422, 'ROW_LIMIT', 'Provide between 1 and 200 records.');
  return rows.map((row) => {
    if (row.cells.length !== RECORD_FIELDS.length)
      throw new HttpError(
        422,
        'COLUMN_COUNT',
        `Source line ${row.lineNumber} has a different number of fields.`,
      );
    return {
      record: Object.fromEntries(
        RECORD_FIELDS.map((key, index) => [key, row.cells[index]]),
      ) as OperationalRecord,
      lineNumber: row.lineNumber,
    };
  });
}

export function fixtureSource(id: FixtureId): { name: string; csv: string } {
  if (!['mixed', 'clean'].includes(id))
    throw new HttpError(422, 'UNKNOWN_FIXTURE', 'Choose the mixed or clean fictional sample.');
  const teams = ['Service desk', 'Web operations', 'Business systems', 'Infrastructure'];
  const rows: OperationalRecord[] = Array.from({ length: 22 }, (_, index) => ({
    reference: `DEMO-${String(index + 1).padStart(3, '0')}`,
    team: teams[index % teams.length]!,
    opened: `2026-10-${String(1 + (index % 18)).padStart(2, '0')}`,
    due: `2026-10-${String(5 + (index % 18)).padStart(2, '0')}`,
    status: ['open', 'in_progress', 'resolved'][index % 3]!,
    minutes: String(15 + index * 5),
  }));
  if (id === 'mixed') {
    rows[1]!.reference = rows[0]!.reference;
    rows[4]!.team = '';
    rows[7]!.due = '2026-02-30';
    rows[10]!.minutes = '-15';
    rows[13]!.status = 'waiting';
  }
  return {
    name:
      id === 'mixed'
        ? 'Fictional operations - review sample'
        : 'Fictional operations - clean sample',
    csv: recordsCsv(rows),
  };
}
