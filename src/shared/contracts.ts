// Author, creator and maintainer: Dhruba Poudel.
export const RECORD_FIELDS = ['reference', 'team', 'opened', 'due', 'status', 'minutes'] as const;
export type RecordField = (typeof RECORD_FIELDS)[number];
export type OperationalRecord = Record<RecordField, string>;
export type RecordStatus = 'open' | 'in_progress' | 'resolved';
export type RowDecision = 'accepted' | 'unreviewed' | 'excluded';
export type FixtureId = 'mixed' | 'clean';

export interface ValidationIssue {
  code:
    | 'REQUIRED'
    | 'INVALID_REFERENCE'
    | 'DUPLICATE_REFERENCE'
    | 'INVALID_DATE'
    | 'DATE_ORDER'
    | 'INVALID_STATUS'
    | 'INVALID_MINUTES'
    | 'FIELD_TOO_LONG';
  field: RecordField;
  message: string;
}
export interface RowView {
  id: string;
  lineNumber: number;
  original: OperationalRecord;
  current: OperationalRecord;
  decision: RowDecision;
  issues: ValidationIssue[];
  changedFields: RecordField[];
  lastReason: string | null;
  reviewed: boolean;
}
export interface WorkspaceSummary {
  total: number;
  accepted: number;
  held: number;
  excluded: number;
  changed: number;
  acceptedMinutes: number;
}
export interface ImportSummary {
  id: string;
  name: string;
  fixtureId: FixtureId | null;
  createdAt: string;
  sourceSha256: string;
  sourceRows: number;
}
export interface WorkspaceEvent {
  id: number;
  type:
    'sandbox.created' | 'import.created' | 'row.accepted' | 'row.excluded' | 'dataset.published';
  createdAt: string;
  revision: number;
  message: string;
  rowId: string | null;
  changes: Partial<Record<RecordField, { before: string; after: string }>> | null;
  reason: string | null;
}
export interface PublicationManifest {
  formatVersion: 1;
  author: 'Dhruba Poudel';
  creator: 'Dhruba Poudel';
  publicationId: string;
  importId: string;
  datasetRevision: number;
  createdAt: string;
  sourceSha256: string;
  dataSha256: string;
  csvBytes: number;
  counts: WorkspaceSummary;
  columns: RecordField[];
  scope: 'Fictional educational sandbox. No verified organisational approval identity.';
}
export interface PublicationView {
  id: string;
  revision: number;
  createdAt: string;
  dataSha256: string;
  acceptedRows: number;
  excludedRows: number;
  csvUrl: string;
  manifestUrl: string;
}
export interface WorkspaceSnapshot {
  session: { id: string; createdAt: string; expiresAt: string };
  mode: 'fictional-demo' | 'local';
  revision: number;
  activeImport: ImportSummary | null;
  rows: RowView[];
  summary: WorkspaceSummary;
  events: WorkspaceEvent[];
  publications: PublicationView[];
  limits: {
    maxRows: 200;
    requestBytes: 65536;
    lifetimeHours: 24;
    maxPublications: 20;
    maxImports: 20;
  };
}
export interface ImportCommand {
  fixtureId: FixtureId;
  // New import becomes active; original earlier imports/publications remain stored until expiry.
}
export interface DecisionCommand {
  expectedRevision: number;
  action: 'accept' | 'exclude';
  reason: string;
  changes?: Partial<OperationalRecord>;
}
export interface PublishCommand {
  expectedRevision: number;
}
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    currentRevision?: number;
    issues?: ValidationIssue[];
  };
}

/** Same-origin JSON API, no external identity or production-approval claims.
 * GET /api/session -> snapshot, creates a sandbox if no valid cookie.
 * POST /api/session -> fresh sandbox + cookie (previous sandbox expires normally).
 * GET /api/workspace -> snapshot; requires existing sandbox.
 * POST /api/imports {fixtureId:'mixed'|'clean'} -> snapshot (Idempotency-Key required).
 * PATCH /api/rows/:id/decision DecisionCommand -> snapshot (Idempotency-Key required).
 * POST /api/publications PublishCommand -> snapshot (Idempotency-Key required).
 * GET /api/publications/:id.csv -> exact frozen CSV attachment.
 * GET /api/publications/:id.json -> exact frozen manifest attachment.
 * All errors: ApiErrorBody. Stale revision/key-body mismatch=409; validation=422.
 * Publication leaves dataset revision unchanged; re-publishing it returns its existing publication.
 * An import/decision changes revision. Clean imported rows start accepted; imported exceptions
 * require explicit review even when another correction clears their last validation issue.
 */
