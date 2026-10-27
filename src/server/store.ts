// Author, creator and maintainer: Dhruba Poudel.
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import {
  RECORD_FIELDS,
  type DecisionCommand,
  type FixtureId,
  type ImportSummary,
  type OperationalRecord,
  type PublicationManifest,
  type PublicationView,
  type PublishCommand,
  type RecordField,
  type RowView,
  type WorkspaceEvent,
  type WorkspaceSnapshot,
} from '../shared/contracts.js';
import {
  canonicalJson,
  fixtureSource,
  MAX_REASON,
  normalizeRecord,
  parseCsv,
  recordsCsv,
  sha256,
  summarise,
  validateRecords,
} from './domain.js';
import { assertKeys, assertObject, HttpError } from './errors.js';

type SqlRow = Record<string, string | number | null | Uint8Array>;
interface SandboxRow extends SqlRow {
  id: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
  revision: number;
  active_import: string | null;
}
interface StoredRow extends SqlRow {
  id: string;
  import_id: string;
  line_number: number;
  original_json: string;
  current_json: string;
  decision: 'accepted' | 'unreviewed' | 'excluded';
  last_reason: string | null;
  reviewed: number;
}
export interface StoreOptions {
  databasePath?: string;
  now?: () => Date;
  publicMode?: boolean;
  maxSandboxes?: number;
}
export interface MutationResult {
  snapshot: WorkspaceSnapshot;
  replayed: boolean;
}

const LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAX_IMPORTS = 20;
const MAX_PUBLICATIONS = 20;
const MAX_EVENTS = 400;
const MAX_IDEMPOTENCY = 200;

export class StudioStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;
  readonly publicMode: boolean;
  private readonly maxSandboxes: number;

  constructor(options: StoreOptions = {}) {
    const path = options.databasePath || ':memory:';
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.now = options.now || (() => new Date());
    this.publicMode = options.publicMode !== false;
    this.maxSandboxes = options.maxSandboxes ?? 200;
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS sandboxes (
        id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0), active_import TEXT
      );
      CREATE TABLE IF NOT EXISTS imports (
        id TEXT PRIMARY KEY, sandbox_id TEXT NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
        name TEXT NOT NULL, fixture_id TEXT, created_at TEXT NOT NULL,
        source_csv TEXT NOT NULL, source_sha256 TEXT NOT NULL, source_rows INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS imports_sandbox ON imports(sandbox_id);
      CREATE TABLE IF NOT EXISTS source_rows (
        id TEXT PRIMARY KEY, import_id TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
        line_number INTEGER NOT NULL, original_json TEXT NOT NULL,
        current_json TEXT NOT NULL, decision TEXT NOT NULL CHECK(decision IN ('accepted','unreviewed','excluded')),
        last_reason TEXT, reviewed INTEGER NOT NULL DEFAULT 0 CHECK(reviewed IN (0,1))
      );
      CREATE INDEX IF NOT EXISTS rows_import ON source_rows(import_id, line_number);
      CREATE TRIGGER IF NOT EXISTS keep_original_source_row
      BEFORE UPDATE OF original_json, import_id, line_number ON source_rows
      BEGIN SELECT RAISE(ABORT, 'Original source rows are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS keep_original_import
      BEFORE UPDATE ON imports BEGIN SELECT RAISE(ABORT, 'Imported sources are immutable'); END;
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, sandbox_id TEXT NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
        type TEXT NOT NULL, created_at TEXT NOT NULL, revision INTEGER NOT NULL,
        message TEXT NOT NULL, row_id TEXT, changes_json TEXT, reason TEXT
      );
      CREATE INDEX IF NOT EXISTS events_sandbox ON events(sandbox_id, id);
      CREATE TABLE IF NOT EXISTS publications (
        id TEXT PRIMARY KEY, sandbox_id TEXT NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
        import_id TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE, revision INTEGER NOT NULL,
        created_at TEXT NOT NULL, csv BLOB NOT NULL, manifest_json TEXT NOT NULL,
        UNIQUE(import_id, revision)
      );
      CREATE TRIGGER IF NOT EXISTS keep_publication_snapshot
      BEFORE UPDATE ON publications BEGIN SELECT RAISE(ABORT, 'Publication snapshots are immutable'); END;
      CREATE INDEX IF NOT EXISTS publications_sandbox ON publications(sandbox_id, created_at);
      CREATE TABLE IF NOT EXISTS idempotency (
        sandbox_id TEXT NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
        scope TEXT NOT NULL, key TEXT NOT NULL, body_sha256 TEXT NOT NULL,
        response_gzip BLOB NOT NULL, PRIMARY KEY(sandbox_id, scope, key)
      );
    `);
  }

  close(): void {
    this.db.close();
  }
  private timestamp(): string {
    return this.now().toISOString();
  }
  private one(
    sql: string,
    ...parameters: (string | number | null | Uint8Array)[]
  ): SqlRow | undefined {
    return this.db.prepare(sql).get(...parameters) as SqlRow | undefined;
  }
  private all(sql: string, ...parameters: (string | number | null | Uint8Array)[]): SqlRow[] {
    return this.db.prepare(sql).all(...parameters) as SqlRow[];
  }
  private count(sql: string, ...parameters: (string | number | null)[]): number {
    return Number(this.one(sql, ...parameters)?.count || 0);
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = operation();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  cleanupExpired(): number {
    return Number(
      this.db.prepare('DELETE FROM sandboxes WHERE expires_at <= ?').run(this.timestamp()).changes,
    );
  }
  private sandbox(token: string | undefined): SandboxRow {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new HttpError(401, 'SESSION_REQUIRED', 'Start a fresh demonstration sandbox.');
    const row = this.one(
      'SELECT * FROM sandboxes WHERE token_hash = ? AND expires_at > ?',
      sha256(token),
      this.timestamp(),
    ) as SandboxRow | undefined;
    if (!row)
      throw new HttpError(
        401,
        'SESSION_REQUIRED',
        'This demonstration sandbox has expired. Start a fresh one.',
      );
    return row;
  }
  private addEvent(
    sandbox: SandboxRow,
    type: WorkspaceEvent['type'],
    message: string,
    details: { rowId?: string; changes?: WorkspaceEvent['changes']; reason?: string } = {},
  ): void {
    if (
      this.count('SELECT COUNT(*) AS count FROM events WHERE sandbox_id = ?', sandbox.id) >=
      MAX_EVENTS
    )
      throw new HttpError(
        429,
        'SANDBOX_LIMIT',
        'This sandbox has reached its demonstration history limit. Start a fresh sandbox.',
      );
    this.db
      .prepare(
        'INSERT INTO events (sandbox_id,type,created_at,revision,message,row_id,changes_json,reason) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(
        sandbox.id,
        type,
        this.timestamp(),
        sandbox.revision,
        message,
        details.rowId || null,
        details.changes ? JSON.stringify(details.changes) : null,
        details.reason || null,
      );
  }

  createSession(): { token: string; snapshot: WorkspaceSnapshot } {
    return this.transaction(() => {
      this.cleanupExpired();
      if (this.count('SELECT COUNT(*) AS count FROM sandboxes') >= this.maxSandboxes)
        throw new HttpError(
          429,
          'CAPACITY',
          'The demonstration is temporarily at capacity. Existing sandboxes remain available; try again later.',
        );
      const token = randomBytes(32).toString('base64url');
      const id = randomUUID(),
        createdAt = this.timestamp(),
        expiresAt = new Date(Date.parse(createdAt) + LIFETIME_MS).toISOString();
      this.db
        .prepare('INSERT INTO sandboxes (id,token_hash,created_at,expires_at) VALUES (?,?,?,?)')
        .run(id, sha256(token), createdAt, expiresAt);
      const row = this.sandbox(token);
      this.addEvent(
        row,
        'sandbox.created',
        'An isolated fictional-data sandbox was created. Its actor is not an authenticated organisational identity.',
      );
      return { token, snapshot: this.snapshotFor(row) };
    });
  }

  getSnapshot(token: string | undefined): WorkspaceSnapshot {
    return this.snapshotFor(this.sandbox(token));
  }
  private storedRows(importId: string): StoredRow[] {
    return this.all(
      'SELECT * FROM source_rows WHERE import_id = ? ORDER BY line_number',
      importId,
    ) as StoredRow[];
  }
  private rowViews(importId: string | null): RowView[] {
    if (!importId) return [];
    const stored = this.storedRows(importId);
    const validation = validateRecords(
      stored.map((row) => ({
        id: row.id,
        current: JSON.parse(row.current_json) as OperationalRecord,
        excluded: row.decision === 'excluded',
      })),
    );
    return stored.map((row) => {
      const original = JSON.parse(row.original_json) as OperationalRecord,
        current = JSON.parse(row.current_json) as OperationalRecord;
      const issues = validation.get(row.id) || [];
      return {
        id: row.id,
        lineNumber: row.line_number,
        original,
        current,
        decision: row.decision === 'accepted' && issues.length ? 'unreviewed' : row.decision,
        issues,
        changedFields: RECORD_FIELDS.filter((field) => current[field] !== original[field]),
        lastReason: row.last_reason,
        reviewed: row.reviewed === 1,
      };
    });
  }
  private snapshotFor(sandbox: SandboxRow): WorkspaceSnapshot {
    const imported = sandbox.active_import
      ? this.one(
          'SELECT * FROM imports WHERE id = ? AND sandbox_id = ?',
          sandbox.active_import,
          sandbox.id,
        )
      : undefined;
    const activeImport: ImportSummary | null = imported
      ? {
          id: String(imported.id),
          name: String(imported.name),
          fixtureId: imported.fixture_id as FixtureId | null,
          createdAt: String(imported.created_at),
          sourceSha256: String(imported.source_sha256),
          sourceRows: Number(imported.source_rows),
        }
      : null;
    const rows = this.rowViews(sandbox.active_import);
    const events: WorkspaceEvent[] = this.all(
      'SELECT * FROM events WHERE sandbox_id = ? ORDER BY id',
      sandbox.id,
    ).map((row) => ({
      id: Number(row.id),
      type: row.type as WorkspaceEvent['type'],
      createdAt: String(row.created_at),
      revision: Number(row.revision),
      message: String(row.message),
      rowId: row.row_id as string | null,
      changes: row.changes_json ? JSON.parse(String(row.changes_json)) : null,
      reason: row.reason as string | null,
    }));
    const publications: PublicationView[] = this.all(
      'SELECT id,revision,created_at,manifest_json FROM publications WHERE sandbox_id = ? ORDER BY created_at DESC, rowid DESC',
      sandbox.id,
    ).map((row) => {
      const manifest = JSON.parse(String(row.manifest_json)) as PublicationManifest;
      return {
        id: String(row.id),
        revision: Number(row.revision),
        createdAt: String(row.created_at),
        dataSha256: manifest.dataSha256,
        acceptedRows: manifest.counts.accepted,
        excludedRows: manifest.counts.excluded,
        csvUrl: `/api/publications/${row.id}.csv`,
        manifestUrl: `/api/publications/${row.id}.json`,
      };
    });
    return {
      session: { id: sandbox.id, createdAt: sandbox.created_at, expiresAt: sandbox.expires_at },
      mode: this.publicMode ? 'fictional-demo' : 'local',
      revision: sandbox.revision,
      activeImport,
      rows,
      summary: summarise(rows),
      events,
      publications,
      limits: {
        maxRows: 200,
        requestBytes: 65536,
        lifetimeHours: 24,
        maxPublications: 20,
        maxImports: 20,
      },
    };
  }

  private mutate(
    token: string | undefined,
    scope: string,
    key: string | undefined,
    command: unknown,
    operation: (sandbox: SandboxRow) => void,
  ): MutationResult {
    if (!key || !/^[A-Za-z0-9_.:-]{8,100}$/.test(key))
      throw new HttpError(
        400,
        'IDEMPOTENCY_REQUIRED',
        'Provide an Idempotency-Key of 8 to 100 safe characters.',
      );
    const bodySha = sha256(canonicalJson(command));
    return this.transaction(() => {
      const sandbox = this.sandbox(token);
      const replay = this.one(
        'SELECT body_sha256,response_gzip FROM idempotency WHERE sandbox_id = ? AND scope = ? AND key = ?',
        sandbox.id,
        scope,
        key,
      );
      if (replay) {
        if (replay.body_sha256 !== bodySha)
          throw new HttpError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This retry key was already used with different request content.',
          );
        return {
          snapshot: JSON.parse(
            gunzipSync(replay.response_gzip as Uint8Array).toString('utf8'),
          ) as WorkspaceSnapshot,
          replayed: true,
        };
      }
      if (
        this.count('SELECT COUNT(*) AS count FROM idempotency WHERE sandbox_id = ?', sandbox.id) >=
        MAX_IDEMPOTENCY
      )
        throw new HttpError(
          429,
          'SANDBOX_LIMIT',
          'This sandbox has reached its request history limit. Start a fresh one.',
        );
      operation(sandbox);
      const snapshot = this.snapshotFor(this.sandbox(token));
      this.db
        .prepare(
          'INSERT INTO idempotency (sandbox_id,scope,key,body_sha256,response_gzip) VALUES (?,?,?,?,?)',
        )
        .run(sandbox.id, scope, key, bodySha, gzipSync(JSON.stringify(snapshot)));
      return { snapshot, replayed: false };
    });
  }

  importFixture(
    token: string | undefined,
    key: string | undefined,
    input: unknown,
  ): MutationResult {
    assertObject(input);
    if ('csv' in input || 'rows' in input || 'file' in input)
      throw new HttpError(
        403,
        'FICTIONAL_FIXTURES_ONLY',
        'This public demonstration imports only its bundled fictional samples.',
      );
    assertKeys(input, ['fixtureId']);
    if (input.fixtureId !== 'mixed' && input.fixtureId !== 'clean')
      throw new HttpError(422, 'UNKNOWN_FIXTURE', 'Choose the mixed or clean fictional sample.');
    const fixtureId = input.fixtureId;
    return this.mutate(token, 'imports', key, input, (sandbox) => {
      if (
        this.count('SELECT COUNT(*) AS count FROM imports WHERE sandbox_id = ?', sandbox.id) >=
        MAX_IMPORTS
      )
        throw new HttpError(
          429,
          'IMPORT_LIMIT',
          'This sandbox has reached its twenty-import limit. Start a fresh sandbox.',
        );
      const fixture = fixtureSource(fixtureId),
        sourceRows = parseCsv(fixture.csv),
        id = randomUUID();
      this.db
        .prepare(
          'INSERT INTO imports (id,sandbox_id,name,fixture_id,created_at,source_csv,source_sha256,source_rows) VALUES (?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          sandbox.id,
          fixture.name,
          fixtureId,
          this.timestamp(),
          fixture.csv,
          sha256(fixture.csv),
          sourceRows.length,
        );
      const prepared = sourceRows.map((item) => ({
        id: randomUUID(),
        original: item.record,
        current: normalizeRecord(item.record),
        lineNumber: item.lineNumber,
      }));
      const validation = validateRecords(prepared);
      const insert = this.db.prepare(
        'INSERT INTO source_rows (id,import_id,line_number,original_json,current_json,decision) VALUES (?,?,?,?,?,?)',
      );
      for (const row of prepared)
        insert.run(
          row.id,
          id,
          row.lineNumber,
          JSON.stringify(row.original),
          JSON.stringify(row.current),
          validation.get(row.id)?.length ? 'unreviewed' : 'accepted',
        );
      sandbox.revision += 1;
      sandbox.active_import = id;
      this.db
        .prepare('UPDATE sandboxes SET revision = ?, active_import = ? WHERE id = ?')
        .run(sandbox.revision, id, sandbox.id);
      const held = [...validation.values()].filter((issues) => issues.length).length;
      this.addEvent(
        sandbox,
        'import.created',
        `${prepared.length} fictional source rows imported; ${prepared.length - held} accepted and ${held} held. Original source and SHA-256 retained.`,
      );
    });
  }

  private expectedRevision(value: unknown, sandbox: SandboxRow): void {
    if (!Number.isSafeInteger(value) || Number(value) < 0)
      throw new HttpError(
        422,
        'INVALID_REVISION',
        'Provide a non-negative integer expectedRevision.',
      );
    if (value !== sandbox.revision)
      throw new HttpError(
        409,
        'REVISION_CONFLICT',
        'The dataset changed after you loaded it. Refresh and review the current revision before deciding.',
        { currentRevision: sandbox.revision },
      );
  }

  decide(
    token: string | undefined,
    rowId: string,
    key: string | undefined,
    input: unknown,
  ): MutationResult {
    assertObject(input);
    assertKeys(input, ['expectedRevision', 'action', 'reason', 'changes']);
    if (input.action !== 'accept' && input.action !== 'exclude')
      throw new HttpError(422, 'INVALID_ACTION', 'Choose accept or exclude.');
    if (
      typeof input.reason !== 'string' ||
      !input.reason.trim() ||
      input.reason.length > MAX_REASON ||
      /[\u0000-\u001f\u007f]/.test(input.reason)
    )
      throw new HttpError(
        422,
        'REASON_REQUIRED',
        'Provide a plain-text reason from 1 to 280 characters. Use fictional information.',
      );
    const changes: Partial<OperationalRecord> = {};
    if (input.changes !== undefined) {
      assertObject(input.changes);
      assertKeys(input.changes, RECORD_FIELDS);
      for (const [field, value] of Object.entries(input.changes)) {
        if (typeof value !== 'string' || value.length > 1000)
          throw new HttpError(
            422,
            'INVALID_CHANGE',
            'Changed field values must be bounded strings.',
          );
        changes[field as RecordField] = value.trim();
      }
    }
    if (input.action === 'exclude' && Object.keys(changes).length)
      throw new HttpError(
        422,
        'EXCLUSION_WITH_CHANGE',
        'Exclude a record with a reason, or correct and accept it; do not combine both.',
      );
    const command = input as unknown as DecisionCommand;
    return this.mutate(token, `rows/${rowId}/decision`, key, input, (sandbox) => {
      const row = this.one(
        'SELECT r.* FROM source_rows r JOIN imports i ON r.import_id = i.id WHERE r.id = ? AND i.sandbox_id = ? AND i.id = ?',
        rowId,
        sandbox.id,
        sandbox.active_import,
      ) as StoredRow | undefined;
      if (!row)
        throw new HttpError(
          404,
          'NOT_FOUND',
          'That record is not in this sandbox’s active import.',
        );
      this.expectedRevision(command.expectedRevision, sandbox);
      const before = JSON.parse(row.current_json) as OperationalRecord,
        after = { ...before, ...changes };
      const candidates = this.storedRows(String(sandbox.active_import)).map((item) => ({
        id: item.id,
        current: item.id === rowId ? after : (JSON.parse(item.current_json) as OperationalRecord),
        excluded: item.id === rowId ? command.action === 'exclude' : item.decision === 'excluded',
      }));
      const validation = validateRecords(candidates),
        ownIssues = validation.get(rowId) || [];
      if (command.action === 'accept' && ownIssues.length)
        throw new HttpError(
          422,
          'RECORD_INVALID',
          'Resolve every validation issue on this record before accepting it.',
          { issues: ownIssues },
        );
      this.db
        .prepare(
          'UPDATE source_rows SET current_json = ?, decision = ?, last_reason = ?, reviewed = 1 WHERE id = ?',
        )
        .run(
          JSON.stringify(after),
          command.action === 'accept' ? 'accepted' : 'excluded',
          command.reason.trim(),
          rowId,
        );
      // A new duplicate can invalidate an earlier accepted record. Its hold is sticky until reviewed.
      for (const candidate of candidates) {
        if (
          candidate.id !== rowId &&
          !candidate.excluded &&
          (validation.get(candidate.id)?.length || 0) > 0
        ) {
          this.db
            .prepare(
              "UPDATE source_rows SET decision = 'unreviewed' WHERE id = ? AND decision = 'accepted'",
            )
            .run(candidate.id);
        }
      }
      sandbox.revision += 1;
      this.db
        .prepare('UPDATE sandboxes SET revision = ? WHERE id = ?')
        .run(sandbox.revision, sandbox.id);
      const delta = Object.fromEntries(
        RECORD_FIELDS.filter((field) => before[field] !== after[field]).map((field) => [
          field,
          { before: before[field], after: after[field] },
        ]),
      ) as NonNullable<WorkspaceEvent['changes']>;
      this.addEvent(
        sandbox,
        command.action === 'accept' ? 'row.accepted' : 'row.excluded',
        `Source line ${row.line_number} ${command.action === 'accept' ? 'was explicitly accepted' : 'was excluded'} with a recorded review reason.`,
        { rowId, changes: delta, reason: command.reason.trim() },
      );
    });
  }

  publish(token: string | undefined, key: string | undefined, input: unknown): MutationResult {
    assertObject(input);
    assertKeys(input, ['expectedRevision']);
    return this.mutate(token, 'publications', key, input, (sandbox) => {
      this.expectedRevision((input as unknown as PublishCommand).expectedRevision, sandbox);
      if (!sandbox.active_import)
        throw new HttpError(
          422,
          'IMPORT_REQUIRED',
          'Import a fictional sample before publishing a dataset.',
        );
      const rows = this.rowViews(sandbox.active_import),
        counts = summarise(rows);
      if (counts.held)
        throw new HttpError(
          422,
          'UNRESOLVED_RECORDS',
          `${counts.held} source records still need an explicit valid acceptance or exclusion.`,
        );
      if (!counts.accepted)
        throw new HttpError(
          422,
          'NO_ACCEPTED_RECORDS',
          'A publication needs at least one accepted record.',
        );
      if (
        this.one(
          'SELECT id FROM publications WHERE import_id = ? AND revision = ?',
          sandbox.active_import,
          sandbox.revision,
        )
      )
        return;
      if (
        this.count('SELECT COUNT(*) AS count FROM publications WHERE sandbox_id = ?', sandbox.id) >=
        MAX_PUBLICATIONS
      )
        throw new HttpError(
          429,
          'PUBLICATION_LIMIT',
          'This sandbox has reached its twenty-publication limit. Start a fresh sandbox.',
        );
      const imported = this.one(
        'SELECT source_sha256 FROM imports WHERE id = ?',
        sandbox.active_import,
      )!;
      const id = randomUUID(),
        createdAt = this.timestamp(),
        csv = Buffer.from(
          recordsCsv(
            rows.filter((row) => row.decision === 'accepted').map((row) => row.current),
            true,
          ),
          'utf8',
        );
      const manifest: PublicationManifest = {
        formatVersion: 1,
        author: 'Dhruba Poudel',
        creator: 'Dhruba Poudel',
        publicationId: id,
        importId: sandbox.active_import,
        datasetRevision: sandbox.revision,
        createdAt,
        sourceSha256: String(imported.source_sha256),
        dataSha256: sha256(csv),
        csvBytes: csv.length,
        counts,
        columns: [...RECORD_FIELDS],
        scope: 'Fictional educational sandbox. No verified organisational approval identity.',
      };
      this.db
        .prepare(
          'INSERT INTO publications (id,sandbox_id,import_id,revision,created_at,csv,manifest_json) VALUES (?,?,?,?,?,?,?)',
        )
        .run(
          id,
          sandbox.id,
          sandbox.active_import,
          sandbox.revision,
          createdAt,
          csv,
          JSON.stringify(manifest, null, 2),
        );
      this.addEvent(
        sandbox,
        'dataset.published',
        `Revision ${sandbox.revision} frozen as ${counts.accepted} accepted records, with ${counts.excluded} exclusions recorded in its manifest.`,
      );
    });
  }

  publication(token: string | undefined, id: string): { csv: Uint8Array; manifestJson: string } {
    const sandbox = this.sandbox(token);
    const row = this.one(
      'SELECT csv,manifest_json FROM publications WHERE id = ? AND sandbox_id = ?',
      id,
      sandbox.id,
    );
    if (!row) throw new HttpError(404, 'NOT_FOUND', 'That publication is not in this sandbox.');
    return { csv: new Uint8Array(row.csv as Uint8Array), manifestJson: String(row.manifest_json) };
  }
}

export function createStore(options: StoreOptions = {}): StudioStore {
  return new StudioStore(options);
}
