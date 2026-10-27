// Author, creator and maintainer: Dhruba Poudel.
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson, sha256 } from './domain.js';
import { assertKeys, assertObject, HttpError } from './errors.js';
import type {
  ConnectorPayload,
  ConnectorScenario,
  DemoAccess,
  DemoCredential,
  TeamActor,
  TeamAttempt,
  TeamAuditEvent,
  TeamCommandResult,
  TeamJob,
  TeamJobStatus,
  TeamReceipt,
  TeamRole,
  TeamSnapshot,
} from '../shared/team-contracts.js';

type SqlRow = Record<string, string | number | null>;
interface JobRow extends SqlRow {
  id: string;
  workspace_id: string;
  event_id: string;
  scenario: ConnectorScenario;
  status: TeamJobStatus;
  revision: number;
  created_at: string;
  updated_at: string;
  next_attempt_at: string | null;
  source_attempts: number;
  delivery_attempts: number;
  generation: number;
  source_recovered: number;
  source_raw: string | null;
  source_sha256: string | null;
  payload: string | null;
  submitted_by: string | null;
  approved_by: string | null;
  review_reason: string | null;
  approval_reason: string | null;
  error: string | null;
  trace_id: string;
  lease_token: string | null;
  lease_until: string | null;
  lease_started_at: string | null;
}
interface AuthContext {
  actor: TeamActor;
  workspaceId: string;
  expiresAt: string;
}
export interface ClaimedTeamJob {
  id: string;
  eventId: string;
  phase: 'source' | 'delivery';
  scenario: ConnectorScenario;
  sourceAttempts: number;
  deliveryAttempts: number;
  generation: number;
  traceId: string;
  leaseToken: string;
  payload: ConnectorPayload | null;
  sourceRecovered: boolean;
}
export interface TeamAttemptResult {
  outcome: TeamAttempt['outcome'];
  httpStatus: number | null;
  durationMs: number;
  message: string;
  data?: unknown;
  retryAfterMs?: number;
}
export interface TeamStoreOptions {
  databasePath?: string;
  now?: () => Date;
  retryBaseMs?: number;
  leaseMs?: number;
  maxWorkspaces?: number;
}
export interface SandboxResponse {
  status: number;
  body: unknown;
  delayMs: number;
}
const SCENARIOS: ConnectorScenario[] = [
  'healthy',
  'rate_limit',
  'timeout',
  'schema_drift',
  'duplicate',
  'upstream_down',
  'delivery_timeout',
];
const MAX_JOBS = 40,
  MAX_ATTEMPTS = 3,
  MAX_GENERATIONS = 3,
  MAX_COMMANDS = 1000,
  MAX_LOGINS = 100;
const LIFETIME = 24 * 60 * 60 * 1000;
const randomToken = () => randomBytes(32).toString('base64url');
const parse = <T>(value: string | null): T | null =>
  value === null ? null : (JSON.parse(value) as T);
const invalid = (message: string) => new HttpError(422, 'INVALID_TEAM_INPUT', message);
function text(value: unknown, name: string, min = 1, max = 240): string {
  if (
    typeof value !== 'string' ||
    value.trim().length < min ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
  )
    throw invalid(`${name} must contain ${min}–${max} readable characters.`);
  return value.trim();
}
function payload(value: unknown): ConnectorPayload {
  assertObject(value);
  assertKeys(value, ['reference', 'team', 'minutes']);
  const reference = text(value.reference, 'Reference', 3, 40),
    team = text(value.team, 'Team', 2, 60);
  if (!/^[A-Z0-9][A-Z0-9-]{2,39}$/.test(reference))
    throw invalid('Reference must use uppercase letters, numbers and hyphens.');
  if (
    !Number.isInteger(value.minutes) ||
    Number(value.minutes) < 0 ||
    Number(value.minutes) > 10080
  )
    throw invalid('Minutes must be a whole number from 0 to 10,080.');
  return { reference, team, minutes: Number(value.minutes) };
}

/** Independent fictional team workspaces; no global roles or production identity claims. */
export class TeamStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;
  private readonly retryBaseMs: number;
  private readonly leaseMs: number;
  private readonly maxWorkspaces: number;
  private readonly dummySalt = randomBytes(16).toString('hex');
  private readonly dummyHash: Buffer;
  constructor(options: TeamStoreOptions = {}) {
    const filename = options.databasePath || ':memory:';
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.now = options.now || (() => new Date());
    this.retryBaseMs = options.retryBaseMs ?? 1000;
    this.leaseMs = options.leaseMs ?? 10000;
    this.maxWorkspaces = options.maxWorkspaces ?? 200;
    this.dummyHash = scryptSync(randomToken(), this.dummySalt, 32);
    this.db.exec(`
      PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS team_workspaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
        duplicate_events INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS team_workspace_expiry ON team_workspaces(expires_at);
      CREATE TABLE IF NOT EXISTS team_users (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
        username TEXT NOT NULL, display_name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('analyst','approver')),
        salt TEXT NOT NULL, password_hash TEXT NOT NULL, UNIQUE(workspace_id,username)
      );
      CREATE TABLE IF NOT EXISTS team_sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES team_users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS team_session_users ON team_sessions(user_id,created_at);
      CREATE TABLE IF NOT EXISTS team_jobs (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
        event_id TEXT NOT NULL, scenario TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, next_attempt_at TEXT,
        source_attempts INTEGER NOT NULL DEFAULT 0, delivery_attempts INTEGER NOT NULL DEFAULT 0,
        generation INTEGER NOT NULL DEFAULT 1, source_recovered INTEGER NOT NULL DEFAULT 0,
        source_raw TEXT, source_sha256 TEXT, payload TEXT, submitted_by TEXT REFERENCES team_users(id),
        approved_by TEXT REFERENCES team_users(id), review_reason TEXT, approval_reason TEXT, error TEXT,
        trace_id TEXT NOT NULL, lease_token TEXT, lease_until TEXT, lease_started_at TEXT,
        UNIQUE(workspace_id,event_id)
      );
      CREATE INDEX IF NOT EXISTS team_job_queue ON team_jobs(status,next_attempt_at,created_at);
      CREATE INDEX IF NOT EXISTS team_job_scope ON team_jobs(workspace_id,created_at);
      CREATE TRIGGER IF NOT EXISTS team_source_immutable
        BEFORE UPDATE OF source_raw,source_sha256 ON team_jobs
        WHEN OLD.source_raw IS NOT NULL AND (NEW.source_raw IS NOT OLD.source_raw OR NEW.source_sha256 IS NOT OLD.source_sha256)
        BEGIN SELECT RAISE(ABORT,'Original connector source is immutable'); END;
      CREATE TABLE IF NOT EXISTS team_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES team_jobs(id) ON DELETE CASCADE,
        phase TEXT NOT NULL, attempt INTEGER NOT NULL, generation INTEGER NOT NULL, started_at TEXT NOT NULL,
        duration_ms REAL NOT NULL, outcome TEXT NOT NULL, http_status INTEGER, message TEXT NOT NULL,
        trace_id TEXT NOT NULL, span_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS team_receipts (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
        job_id TEXT NOT NULL UNIQUE REFERENCES team_jobs(id) ON DELETE CASCADE,
        event_id TEXT NOT NULL, reference TEXT NOT NULL, payload_sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(workspace_id,event_id)
      );
      CREATE TABLE IF NOT EXISTS team_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
        job_id TEXT REFERENCES team_jobs(id) ON DELETE CASCADE, type TEXT NOT NULL,
        actor_name TEXT NOT NULL, actor_role TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL, trace_id TEXT
      );
      CREATE INDEX IF NOT EXISTS team_events_scope ON team_events(workspace_id,id);
      CREATE TABLE IF NOT EXISTS team_commands (
        workspace_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES team_users(id) ON DELETE CASCADE,
        command_key TEXT NOT NULL, fingerprint TEXT NOT NULL, job_id TEXT NOT NULL REFERENCES team_jobs(id) ON DELETE CASCADE,
        PRIMARY KEY(user_id,command_key)
      );
    `);
  }
  private time() {
    return this.now().toISOString();
  }
  private transact<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private audit(
    workspaceId: string,
    type: string,
    message: string,
    actor?: TeamActor,
    job?: JobRow,
  ) {
    this.db
      .prepare(
        'INSERT INTO team_events(workspace_id,job_id,type,actor_name,actor_role,message,created_at,trace_id) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        workspaceId,
        job?.id || null,
        type,
        actor?.displayName || 'Connector worker',
        actor?.role || 'system',
        message,
        this.time(),
        job?.trace_id || null,
      );
  }
  private auth(token?: string): AuthContext {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new HttpError(401, 'TEAM_LOGIN_REQUIRED', 'Sign in with a demo account.');
    const row = this.db
      .prepare(
        `SELECT u.id,u.username,u.display_name,u.role,u.workspace_id,w.expires_at
      FROM team_sessions s JOIN team_users u ON u.id=s.user_id JOIN team_workspaces w ON w.id=u.workspace_id
      WHERE s.token_hash=? AND s.expires_at>? AND w.expires_at>?`,
      )
      .get(sha256(token), this.time(), this.time()) as SqlRow | undefined;
    if (!row)
      throw new HttpError(
        401,
        'TEAM_LOGIN_REQUIRED',
        'The account session has expired. Start a new fictional workspace.',
      );
    return {
      actor: {
        id: String(row.id),
        username: String(row.username),
        displayName: String(row.display_name),
        role: row.role as TeamRole,
      },
      workspaceId: String(row.workspace_id),
      expiresAt: String(row.expires_at),
    };
  }
  private role(ctx: AuthContext, role: TeamRole) {
    if (ctx.actor.role !== role)
      throw new HttpError(403, 'ROLE_REQUIRED', `This action requires an ${role} account.`);
  }
  private job(id: string, workspaceId?: string): JobRow {
    const row = (
      workspaceId
        ? this.db
            .prepare('SELECT * FROM team_jobs WHERE id=? AND workspace_id=?')
            .get(id, workspaceId)
        : this.db
            .prepare(
              'SELECT j.* FROM team_jobs j JOIN team_workspaces w ON w.id=j.workspace_id WHERE j.id=? AND w.expires_at>?',
            )
            .get(id, this.time())
    ) as JobRow | undefined;
    if (!row)
      throw new HttpError(
        404,
        'TEAM_JOB_NOT_FOUND',
        'That connector job is not available in this workspace.',
      );
    return row;
  }
  private revise(job: JobRow, changes: Record<string, string | number | null>) {
    const fields = Object.keys(changes);
    this.db
      .prepare(
        `UPDATE team_jobs SET ${fields.map((k) => `${k}=?`).join(',')},revision=revision+1,updated_at=? WHERE id=?`,
      )
      .run(...fields.map((k) => changes[k]!), this.time(), job.id);
  }
  private expected(job: JobRow, value: unknown) {
    if (!Number.isInteger(value) || Number(value) < 1)
      throw invalid('A valid expectedRevision is required.');
    if (value !== job.revision)
      throw new HttpError(
        409,
        'STALE_TEAM_JOB',
        'This job changed. Refresh it before making another decision.',
        { currentRevision: job.revision },
      );
  }
  private command(
    ctx: AuthContext,
    key: string | undefined,
    route: string,
    input: unknown,
    action: () => string,
  ): TeamCommandResult {
    if (!key || !/^[A-Za-z0-9_-]{8,100}$/.test(key))
      throw new HttpError(400, 'IDEMPOTENCY_REQUIRED', 'Use an 8–100 character idempotency key.');
    const fingerprint = sha256(canonicalJson({ route, input }));
    let replayed = false;
    const jobId = this.transact(() => {
      const old = this.db
        .prepare('SELECT fingerprint,job_id FROM team_commands WHERE user_id=? AND command_key=?')
        .get(ctx.actor.id, key) as SqlRow | undefined;
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new HttpError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'That request key was already used with a different command.',
          );
        replayed = true;
        return String(old.job_id);
      }
      const count = this.db
        .prepare('SELECT COUNT(*) AS n FROM team_commands WHERE workspace_id=?')
        .get(ctx.workspaceId) as SqlRow;
      if (Number(count.n) >= MAX_COMMANDS)
        throw new HttpError(
          429,
          'TEAM_CAPACITY',
          'This fictional workspace has reached its command limit.',
        );
      const id = action();
      this.db
        .prepare(
          'INSERT INTO team_commands(workspace_id,user_id,command_key,fingerprint,job_id) VALUES(?,?,?,?,?)',
        )
        .run(ctx.workspaceId, ctx.actor.id, key, fingerprint, id);
      return id;
    });
    return { snapshot: this.getSnapshotFor(ctx), replayed, jobId };
  }
  createDemo(): DemoAccess {
    this.cleanupExpired();
    const workspaceId = randomUUID(),
      createdAt = this.time(),
      expiresAt = new Date(Date.parse(createdAt) + LIFETIME).toISOString();
    const credentials: DemoCredential[] = [
      {
        username: 'avery.analyst',
        displayName: 'Avery Chen',
        role: 'analyst',
        password: randomBytes(18).toString('base64url'),
      },
      {
        username: 'sam.approver',
        displayName: 'Sam Rivera',
        role: 'approver',
        password: randomBytes(18).toString('base64url'),
      },
    ];
    const users = credentials.map((c) => {
      const salt = randomBytes(16).toString('hex');
      return {
        ...c,
        id: randomUUID(),
        salt,
        hash: scryptSync(c.password, salt, 32).toString('hex'),
      };
    });
    this.transact(() => {
      const n = Number(
        (this.db.prepare('SELECT COUNT(*) AS n FROM team_workspaces').get() as SqlRow).n,
      );
      if (n >= this.maxWorkspaces)
        throw new HttpError(
          429,
          'TEAM_CAPACITY',
          'The public demo is at capacity. Try again later.',
        );
      this.db
        .prepare('INSERT INTO team_workspaces(id,name,created_at,expires_at) VALUES(?,?,?,?)')
        .run(workspaceId, 'Northstar Service Operations', createdAt, expiresAt);
      const insert = this.db.prepare(
        'INSERT INTO team_users(id,workspace_id,username,display_name,role,salt,password_hash) VALUES(?,?,?,?,?,?,?)',
      );
      for (const u of users)
        insert.run(u.id, workspaceId, u.username, u.displayName, u.role, u.salt, u.hash);
      this.audit(
        workspaceId,
        'workspace.created',
        'Created an isolated fictional workspace with two distinct demo accounts.',
      );
    });
    return { workspaceId, expiresAt, credentials };
  }
  login(input: unknown): { token: string; snapshot: TeamSnapshot } {
    assertObject(input);
    assertKeys(input, ['workspaceId', 'username', 'password']);
    const workspaceId = text(input.workspaceId, 'Workspace ID', 36, 36),
      username = text(input.username, 'Username', 1, 80);
    if (typeof input.password !== 'string' || input.password.length > 200)
      throw new HttpError(
        401,
        'INVALID_CREDENTIALS',
        'The demo account credentials did not match.',
      );
    const row = this.db
      .prepare(
        `SELECT u.*,w.expires_at FROM team_users u JOIN team_workspaces w ON w.id=u.workspace_id
      WHERE u.workspace_id=? AND u.username=? AND w.expires_at>?`,
      )
      .get(workspaceId, username, this.time()) as SqlRow | undefined;
    const computed = scryptSync(input.password, row ? String(row.salt) : this.dummySalt, 32);
    const matched = timingSafeEqual(
      computed,
      row ? Buffer.from(String(row.password_hash), 'hex') : this.dummyHash,
    );
    if (!row || !matched)
      throw new HttpError(
        401,
        'INVALID_CREDENTIALS',
        'The demo account credentials did not match.',
      );
    const token = randomToken();
    this.transact(() => {
      const logins = Number(
        (
          this.db
            .prepare(
              "SELECT COUNT(*) AS n FROM team_events WHERE workspace_id=? AND type='account.signed_in'",
            )
            .get(workspaceId) as SqlRow
        ).n,
      );
      if (logins >= MAX_LOGINS)
        throw new HttpError(
          429,
          'TEAM_LOGIN_LIMIT',
          'This fictional workspace has reached its 100-sign-in limit. Start a new workspace.',
        );
      this.db.prepare('DELETE FROM team_sessions WHERE expires_at<=?').run(this.time());
      const sessions = this.db
        .prepare('SELECT token_hash FROM team_sessions WHERE user_id=? ORDER BY created_at DESC')
        .all(String(row.id)) as SqlRow[];
      for (const old of sessions.slice(19))
        this.db.prepare('DELETE FROM team_sessions WHERE token_hash=?').run(String(old.token_hash));
      this.db
        .prepare(
          'INSERT INTO team_sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)',
        )
        .run(sha256(token), String(row.id), this.time(), String(row.expires_at));
      this.audit(workspaceId, 'account.signed_in', 'Signed in with a fictional demo account.', {
        id: String(row.id),
        username,
        displayName: String(row.display_name),
        role: row.role as TeamRole,
      });
    });
    return { token, snapshot: this.getSnapshot(token) };
  }
  logout(token?: string): void {
    if (token) this.db.prepare('DELETE FROM team_sessions WHERE token_hash=?').run(sha256(token));
  }
  getSnapshot(token?: string): TeamSnapshot {
    return this.getSnapshotFor(this.auth(token));
  }
  private jobView(row: JobRow): TeamJob {
    const attempts = (
      this.db
        .prepare('SELECT * FROM team_attempts WHERE job_id=? ORDER BY id')
        .all(row.id) as SqlRow[]
    ).map((a) => ({
      id: Number(a.id),
      phase: a.phase as TeamAttempt['phase'],
      attempt: Number(a.attempt),
      generation: Number(a.generation),
      startedAt: String(a.started_at),
      durationMs: Number(a.duration_ms),
      outcome: a.outcome as TeamAttempt['outcome'],
      httpStatus: a.http_status === null ? null : Number(a.http_status),
      message: String(a.message),
      traceId: String(a.trace_id),
      spanId: String(a.span_id),
    }));
    const receipt = this.db.prepare('SELECT * FROM team_receipts WHERE job_id=?').get(row.id) as
      SqlRow | undefined;
    const userName = (id: string | null) =>
      id
        ? String(
            (
              this.db.prepare('SELECT display_name FROM team_users WHERE id=?').get(id) as
                SqlRow | undefined
            )?.display_name || 'Unknown account',
          )
        : null;
    return {
      id: row.id,
      eventId: row.event_id,
      scenario: row.scenario,
      status: row.status,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      nextAttemptAt: row.next_attempt_at,
      sourceAttempts: row.source_attempts,
      deliveryAttempts: row.delivery_attempts,
      generation: row.generation,
      sourceRecovered: !!row.source_recovered,
      sourceRaw: parse(row.source_raw),
      sourceSha256: row.source_sha256,
      payload: parse<ConnectorPayload>(row.payload),
      submittedBy: row.submitted_by,
      submittedByName: userName(row.submitted_by),
      approvedBy: row.approved_by,
      approvedByName: userName(row.approved_by),
      reviewReason: row.review_reason,
      approvalReason: row.approval_reason,
      error: row.error,
      traceId: row.trace_id,
      attempts,
      receipt: receipt ? this.receiptView(receipt) : null,
    };
  }
  private receiptView(r: SqlRow): TeamReceipt {
    return {
      id: String(r.id),
      eventId: String(r.event_id),
      reference: String(r.reference),
      payloadSha256: String(r.payload_sha256),
      createdAt: String(r.created_at),
    };
  }
  private events(workspaceId: string, jobId?: string): TeamAuditEvent[] {
    const rows = (
      jobId
        ? this.db
            .prepare(
              'SELECT * FROM team_events WHERE workspace_id=? AND job_id=? ORDER BY id DESC LIMIT 500',
            )
            .all(workspaceId, jobId)
        : this.db
            .prepare('SELECT * FROM team_events WHERE workspace_id=? ORDER BY id DESC LIMIT 500')
            .all(workspaceId)
    ) as SqlRow[];
    return rows.map((e) => ({
      id: Number(e.id),
      type: String(e.type),
      jobId: e.job_id === null ? null : String(e.job_id),
      actorName: String(e.actor_name),
      actorRole: String(e.actor_role),
      message: String(e.message),
      createdAt: String(e.created_at),
      traceId: e.trace_id === null ? null : String(e.trace_id),
    }));
  }
  private getSnapshotFor(ctx: AuthContext): TeamSnapshot {
    const w = this.db
      .prepare('SELECT * FROM team_workspaces WHERE id=?')
      .get(ctx.workspaceId) as SqlRow;
    const jobs = (
      this.db
        .prepare('SELECT * FROM team_jobs WHERE workspace_id=? ORDER BY created_at DESC,id')
        .all(ctx.workspaceId) as JobRow[]
    ).map((j) => this.jobView(j));
    const durations = jobs
      .flatMap((j) => j.attempts.map((a) => a.durationMs))
      .sort((a, b) => a - b);
    return {
      workspace: {
        id: String(w.id),
        name: String(w.name),
        createdAt: String(w.created_at),
        expiresAt: String(w.expires_at),
      },
      actor: ctx.actor,
      jobs,
      events: this.events(ctx.workspaceId),
      metrics: {
        total: jobs.length,
        awaitingReview: jobs.filter((j) => ['awaiting_review', 'schema_error'].includes(j.status))
          .length,
        awaitingApproval: jobs.filter((j) => j.status === 'awaiting_approval').length,
        inFlight: jobs.filter((j) => /^(queued|running|retry)_/.test(j.status)).length,
        delivered: jobs.filter((j) => j.status === 'delivered').length,
        deadLetter: jobs.filter((j) => j.status === 'dead_letter').length,
        duplicateEvents: Number(w.duplicate_events),
        destinationWrites: Number(
          (
            this.db
              .prepare('SELECT COUNT(*) AS n FROM team_receipts WHERE workspace_id=?')
              .get(ctx.workspaceId) as SqlRow
          ).n,
        ),
        attempts: durations.length,
        retries: jobs.reduce((n, j) => n + j.attempts.filter((a) => a.attempt > 1).length, 0),
        p95AttemptMs: durations.length ? durations[Math.ceil(durations.length * 0.95) - 1]! : null,
      },
      limits: { lifetimeHours: 24, maxJobs: MAX_JOBS, maxAttempts: MAX_ATTEMPTS },
    };
  }
  enqueue(token: string | undefined, key: string | undefined, input: unknown): TeamCommandResult {
    const ctx = this.auth(token);
    this.role(ctx, 'analyst');
    assertObject(input);
    assertKeys(input, ['scenario']);
    if (!SCENARIOS.includes(input.scenario as ConnectorScenario))
      throw invalid('Choose a supported fictional connector scenario.');
    const scenario = input.scenario as ConnectorScenario;
    return this.command(ctx, key, 'enqueue', input, () => {
      const eventId = scenario === 'duplicate' ? 'DEMO-REPEATED-EVENT' : `EVT-${randomUUID()}`;
      const old = this.db
        .prepare('SELECT * FROM team_jobs WHERE workspace_id=? AND event_id=?')
        .get(ctx.workspaceId, eventId) as JobRow | undefined;
      if (old) {
        this.db
          .prepare('UPDATE team_workspaces SET duplicate_events=duplicate_events+1 WHERE id=?')
          .run(ctx.workspaceId);
        this.audit(
          ctx.workspaceId,
          'event.duplicate',
          'Duplicate source event matched the existing job. No new destination work was created.',
          ctx.actor,
          old,
        );
        return old.id;
      }
      const count = Number(
        (
          this.db
            .prepare('SELECT COUNT(*) AS n FROM team_jobs WHERE workspace_id=?')
            .get(ctx.workspaceId) as SqlRow
        ).n,
      );
      if (count >= MAX_JOBS)
        throw new HttpError(
          429,
          'TEAM_JOB_LIMIT',
          'This fictional workspace has reached its 40-job limit.',
        );
      const id = randomUUID(),
        time = this.time();
      this.db
        .prepare(
          `INSERT INTO team_jobs(id,workspace_id,event_id,scenario,status,created_at,updated_at,next_attempt_at,trace_id) VALUES(?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          ctx.workspaceId,
          eventId,
          scenario,
          'queued_source',
          time,
          time,
          time,
          randomBytes(16).toString('hex'),
        );
      this.audit(
        ctx.workspaceId,
        'job.enqueued',
        'Queued a fictional source request.',
        ctx.actor,
        this.job(id, ctx.workspaceId),
      );
      return id;
    });
  }
  review(
    token: string | undefined,
    id: string,
    key: string | undefined,
    input: unknown,
  ): TeamCommandResult {
    const ctx = this.auth(token);
    this.role(ctx, 'analyst');
    assertObject(input);
    assertKeys(input, ['expectedRevision', 'payload', 'reason']);
    const next = payload(input.payload),
      reason = text(input.reason, 'Review reason', 8, 400);
    return this.command(ctx, key, `review:${id}`, input, () => {
      const j = this.job(id, ctx.workspaceId);
      this.expected(j, input.expectedRevision);
      if (!['awaiting_review', 'schema_error'].includes(j.status))
        throw new HttpError(
          409,
          'REVIEW_NOT_READY',
          'Only a received source record can be reviewed.',
        );
      this.revise(j, {
        status: 'awaiting_approval',
        payload: canonicalJson(next),
        submitted_by: ctx.actor.id,
        review_reason: reason,
        error: null,
      });
      this.audit(
        ctx.workspaceId,
        'review.submitted',
        'Analyst reviewed the current record and submitted it for a separate approval.',
        ctx.actor,
        j,
      );
      return id;
    });
  }
  approve(
    token: string | undefined,
    id: string,
    key: string | undefined,
    input: unknown,
  ): TeamCommandResult {
    const ctx = this.auth(token);
    this.role(ctx, 'approver');
    assertObject(input);
    assertKeys(input, ['expectedRevision', 'reason']);
    const reason = text(input.reason, 'Approval reason', 8, 400);
    return this.command(ctx, key, `approve:${id}`, input, () => {
      const j = this.job(id, ctx.workspaceId);
      this.expected(j, input.expectedRevision);
      if (j.status !== 'awaiting_approval' || !j.payload || !j.submitted_by)
        throw new HttpError(
          409,
          'APPROVAL_NOT_READY',
          'This record must be reviewed before approval.',
        );
      if (j.submitted_by === ctx.actor.id)
        throw new HttpError(
          403,
          'SELF_APPROVAL',
          'A different account must approve the submitted record.',
        );
      this.revise(j, {
        status: 'queued_delivery',
        approved_by: ctx.actor.id,
        approval_reason: reason,
        next_attempt_at: this.time(),
        error: null,
      });
      this.audit(
        ctx.workspaceId,
        'review.approved',
        'Separate approver authorised delivery of the reviewed record.',
        ctx.actor,
        j,
      );
      return id;
    });
  }
  replay(
    token: string | undefined,
    id: string,
    key: string | undefined,
    input: unknown,
  ): TeamCommandResult {
    const ctx = this.auth(token);
    this.role(ctx, 'analyst');
    assertObject(input);
    assertKeys(input, ['expectedRevision', 'reason', 'restoreConnector']);
    const reason = text(input.reason, 'Replay reason', 8, 400);
    if (typeof input.restoreConnector !== 'boolean')
      throw invalid('restoreConnector must explicitly be true or false.');
    return this.command(ctx, key, `replay:${id}`, input, () => {
      const j = this.job(id, ctx.workspaceId);
      this.expected(j, input.expectedRevision);
      if (j.status !== 'dead_letter' || j.approved_by)
        throw new HttpError(
          409,
          'REPLAY_NOT_READY',
          'Only a source job in the failed queue can be replayed.',
        );
      if (j.generation >= MAX_GENERATIONS)
        throw new HttpError(
          429,
          'REPLAY_LIMIT',
          'This fictional job has reached its three-generation replay limit.',
        );
      this.revise(j, {
        status: 'queued_source',
        source_attempts: 0,
        generation: j.generation + 1,
        source_recovered: input.restoreConnector ? 1 : j.source_recovered,
        next_attempt_at: this.time(),
        error: null,
      });
      this.audit(
        ctx.workspaceId,
        input.restoreConnector ? 'connector.restored' : 'job.replayed',
        `${input.restoreConnector ? 'Restored the fictional source and replayed' : 'Replayed'} the failed request. Reason: ${reason}`,
        ctx.actor,
        j,
      );
      return id;
    });
  }
  trace(token: string | undefined, id: string) {
    const ctx = this.auth(token),
      j = this.job(id, ctx.workspaceId);
    return {
      author: 'Dhruba Poudel' as const,
      creator: 'Dhruba Poudel' as const,
      job: this.jobView(j),
      events: this.events(ctx.workspaceId, id),
    };
  }
  private recordAttempt(j: JobRow, phase: 'source' | 'delivery', result: TeamAttemptResult) {
    this.db
      .prepare(
        `INSERT INTO team_attempts(job_id,phase,attempt,generation,started_at,duration_ms,outcome,http_status,message,trace_id,span_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        j.id,
        phase,
        phase === 'source' ? j.source_attempts : j.delivery_attempts,
        j.generation,
        j.lease_started_at || this.time(),
        Math.max(0, Math.min(result.durationMs, 60000)),
        result.outcome,
        result.httpStatus,
        String(result.message).slice(0, 240),
        j.trace_id,
        randomBytes(8).toString('hex'),
      );
  }
  claimNext(): ClaimedTeamJob | null {
    return this.transact(() => {
      const time = this.time();
      const abandoned = this.db
        .prepare(
          `SELECT j.* FROM team_jobs j JOIN team_workspaces w ON w.id=j.workspace_id
        WHERE j.status IN ('running_source','running_delivery') AND j.lease_until<=? AND w.expires_at>?`,
        )
        .all(time, time) as JobRow[];
      for (const j of abandoned) {
        const phase = j.status === 'running_source' ? 'source' : 'delivery';
        const receipt = this.db.prepare('SELECT id FROM team_receipts WHERE job_id=?').get(j.id);
        this.recordAttempt(j, phase, {
          outcome: 'timeout',
          httpStatus: null,
          durationMs: this.leaseMs,
          message:
            'Worker lease expired; the interrupted attempt was recovered from durable state.',
        });
        const attempts = phase === 'source' ? j.source_attempts : j.delivery_attempts;
        const status: TeamJobStatus =
          phase === 'delivery' && receipt
            ? 'delivered'
            : attempts >= MAX_ATTEMPTS
              ? 'dead_letter'
              : phase === 'source'
                ? 'retry_source'
                : 'retry_delivery';
        this.revise(j, {
          status,
          next_attempt_at: status === 'delivered' || status === 'dead_letter' ? null : time,
          lease_token: null,
          lease_until: null,
          lease_started_at: null,
          error: status === 'delivered' ? null : 'Interrupted worker lease recovered.',
        });
        this.audit(
          j.workspace_id,
          'worker.recovered',
          status === 'delivered'
            ? 'Recovered the committed destination receipt without another write.'
            : 'Recovered an interrupted attempt from the durable queue.',
          undefined,
          j,
        );
      }
      const j = this.db
        .prepare(
          `SELECT j.* FROM team_jobs j JOIN team_workspaces w ON w.id=j.workspace_id
        WHERE j.status IN ('queued_source','retry_source','queued_delivery','retry_delivery')
          AND j.next_attempt_at<=? AND w.expires_at>? ORDER BY j.next_attempt_at,j.created_at,j.id LIMIT 1`,
        )
        .get(time, time) as JobRow | undefined;
      if (!j) return null;
      const phase = j.status.endsWith('source') ? 'source' : 'delivery',
        leaseToken = randomToken();
      this.revise(j, {
        status: phase === 'source' ? 'running_source' : 'running_delivery',
        [phase === 'source' ? 'source_attempts' : 'delivery_attempts']:
          (phase === 'source' ? j.source_attempts : j.delivery_attempts) + 1,
        lease_token: leaseToken,
        lease_started_at: time,
        lease_until: new Date(this.now().getTime() + this.leaseMs).toISOString(),
        next_attempt_at: null,
      });
      const claimed = this.job(j.id, j.workspace_id);
      this.audit(
        j.workspace_id,
        'attempt.started',
        `Claimed ${phase} attempt ${phase === 'source' ? claimed.source_attempts : claimed.delivery_attempts}.`,
        undefined,
        j,
      );
      return {
        id: j.id,
        eventId: j.event_id,
        phase,
        scenario: j.scenario,
        sourceAttempts: claimed.source_attempts,
        deliveryAttempts: claimed.delivery_attempts,
        generation: j.generation,
        traceId: j.trace_id,
        leaseToken,
        payload: parse<ConnectorPayload>(j.payload),
        sourceRecovered: !!j.source_recovered,
      };
    });
  }
  completeAttempt(id: string, leaseToken: string, result: TeamAttemptResult): void {
    if (!Number.isFinite(result.durationMs) || result.durationMs < 0)
      throw invalid('Attempt duration must be a non-negative number.');
    this.transact(() => {
      let j: JobRow;
      try {
        j = this.job(id);
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) return;
        throw error;
      }
      if (
        j.lease_token !== leaseToken ||
        !['running_source', 'running_delivery'].includes(j.status)
      )
        return;
      const phase = j.status === 'running_source' ? 'source' : 'delivery';
      let outcome = result.outcome,
        nextPayload: string | null = null;
      if (outcome === 'success' && phase === 'source') {
        try {
          nextPayload = canonicalJson(payload(result.data));
        } catch {
          outcome = 'schema_error';
        }
      }
      if (outcome === 'success' && phase === 'delivery') {
        const receipt = this.db.prepare('SELECT * FROM team_receipts WHERE job_id=?').get(j.id) as
          SqlRow | undefined;
        if (
          !receipt ||
          !result.data ||
          typeof result.data !== 'object' ||
          (result.data as Record<string, unknown>).id !== receipt.id
        )
          outcome = 'upstream_error';
      }
      const effective = {
        ...result,
        outcome,
        message:
          outcome === 'schema_error'
            ? 'Source schema changed. A reviewer must explicitly map and validate the current record.'
            : outcome === 'success' && phase === 'delivery'
              ? 'Destination receipt verified.'
              : result.message,
      };
      this.recordAttempt(j, phase, effective);
      const changes: Record<string, string | number | null> = {
        lease_token: null,
        lease_until: null,
        lease_started_at: null,
        next_attempt_at: null,
        error: null,
      };
      if (outcome === 'success') {
        changes.status = phase === 'source' ? 'awaiting_review' : 'delivered';
        if (phase === 'source') {
          const raw = canonicalJson(result.data);
          if (j.source_raw === null) {
            changes.source_raw = raw;
            changes.source_sha256 = sha256(raw);
          }
          changes.payload = nextPayload;
        }
      } else if (outcome === 'schema_error' && phase === 'source') {
        const raw = canonicalJson(result.data ?? null);
        if (j.source_raw === null) {
          changes.source_raw = raw;
          changes.source_sha256 = sha256(raw);
        }
        changes.status = 'schema_error';
        changes.payload = null;
        changes.error = effective.message;
      } else {
        const attempts = phase === 'source' ? j.source_attempts : j.delivery_attempts;
        changes.status =
          attempts >= MAX_ATTEMPTS
            ? 'dead_letter'
            : phase === 'source'
              ? 'retry_source'
              : 'retry_delivery';
        changes.error = String(effective.message).slice(0, 240);
        if (attempts < MAX_ATTEMPTS) {
          const retryAfter = Number.isFinite(result.retryAfterMs)
            ? Math.max(0, Math.min(result.retryAfterMs!, 60000))
            : 0;
          const wait = Math.max(this.retryBaseMs * 2 ** (attempts - 1), retryAfter);
          changes.next_attempt_at = new Date(this.now().getTime() + wait).toISOString();
        }
      }
      this.revise(j, changes);
      this.audit(
        j.workspace_id,
        changes.status === 'dead_letter'
          ? 'job.dead_letter'
          : outcome === 'success'
            ? `${phase}.completed`
            : outcome === 'schema_error'
              ? 'source.schema_error'
              : 'attempt.retry',
        effective.message,
        undefined,
        j,
      );
    });
  }
  sandboxSource(id: string): SandboxResponse {
    const j = this.job(id);
    if (j.status !== 'running_source' || !j.lease_token)
      throw new HttpError(
        409,
        'SANDBOX_NOT_CLAIMED',
        'The source request must belong to an active worker lease.',
      );
    const good: ConnectorPayload = {
      reference: `WO-${j.id.slice(0, 8).toUpperCase()}`,
      team: 'North region',
      minutes: 45,
    };
    if (j.scenario === 'upstream_down' && !j.source_recovered)
      return { status: 503, body: { error: 'Fictional source is unavailable.' }, delayMs: 0 };
    if (j.scenario === 'rate_limit' && j.source_attempts <= 2)
      return {
        status: 429,
        body: { error: 'Fictional source rate limit; retry after one second.' },
        delayMs: 0,
      };
    if (j.scenario === 'schema_drift')
      return {
        status: 200,
        body: { workOrder: good.reference, region: good.team, minutes: good.minutes },
        delayMs: 0,
      };
    return {
      status: 200,
      body: good,
      delayMs: j.scenario === 'timeout' && j.source_attempts === 1 ? 1500 : 0,
    };
  }
  sandboxDestination(id: string, input: unknown): SandboxResponse {
    assertObject(input);
    assertKeys(input, ['eventId', 'payload']);
    const current = payload(input.payload);
    return this.transact(() => {
      const j = this.job(id);
      if (
        j.status !== 'running_delivery' ||
        !j.lease_token ||
        !j.approved_by ||
        !j.submitted_by ||
        j.approved_by === j.submitted_by
      )
        throw new HttpError(
          403,
          'DESTINATION_NOT_APPROVED',
          'A current worker lease and separate approval are required.',
        );
      if (input.eventId !== j.event_id || canonicalJson(current) !== j.payload)
        throw new HttpError(
          409,
          'DESTINATION_PAYLOAD_MISMATCH',
          'The destination request does not match the approved record.',
        );
      const hash = sha256(canonicalJson(current));
      let row = this.db
        .prepare('SELECT * FROM team_receipts WHERE workspace_id=? AND event_id=?')
        .get(j.workspace_id, j.event_id) as SqlRow | undefined;
      if (row && row.payload_sha256 !== hash)
        throw new HttpError(
          409,
          'DESTINATION_EVENT_CONFLICT',
          'The destination event already has different content.',
        );
      if (!row) {
        this.db
          .prepare(
            'INSERT INTO team_receipts(id,workspace_id,job_id,event_id,reference,payload_sha256,created_at) VALUES(?,?,?,?,?,?,?)',
          )
          .run(
            randomUUID(),
            j.workspace_id,
            j.id,
            j.event_id,
            current.reference,
            hash,
            this.time(),
          );
        row = this.db.prepare('SELECT * FROM team_receipts WHERE job_id=?').get(j.id) as SqlRow;
        this.audit(
          j.workspace_id,
          'destination.committed',
          'The sandbox destination committed one approved event.',
          undefined,
          j,
        );
      }
      return {
        status: 200,
        body: this.receiptView(row),
        delayMs: j.scenario === 'delivery_timeout' && j.delivery_attempts === 1 ? 1500 : 0,
      };
    });
  }
  cleanupExpired(): void {
    this.db.prepare('DELETE FROM team_workspaces WHERE expires_at<=?').run(this.time());
  }
  close(): void {
    this.db.close();
  }
}
