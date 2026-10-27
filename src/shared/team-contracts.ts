// Author, creator and maintainer: Dhruba Poudel.
export type TeamRole = 'analyst' | 'approver';
export type ConnectorScenario =
  | 'healthy'
  | 'rate_limit'
  | 'timeout'
  | 'schema_drift'
  | 'duplicate'
  | 'upstream_down'
  | 'delivery_timeout';
export type TeamJobStatus =
  | 'queued_source'
  | 'running_source'
  | 'retry_source'
  | 'schema_error'
  | 'awaiting_review'
  | 'awaiting_approval'
  | 'queued_delivery'
  | 'running_delivery'
  | 'retry_delivery'
  | 'delivered'
  | 'dead_letter';
export interface ConnectorPayload {
  reference: string;
  team: string;
  minutes: number;
}
export interface TeamActor {
  id: string;
  username: string;
  displayName: string;
  role: TeamRole;
}
export interface DemoCredential {
  username: string;
  password: string;
  displayName: string;
  role: TeamRole;
}
export interface DemoAccess {
  workspaceId: string;
  expiresAt: string;
  credentials: DemoCredential[];
}
export interface TeamAttempt {
  id: number;
  phase: 'source' | 'delivery';
  attempt: number;
  generation: number;
  startedAt: string;
  durationMs: number;
  outcome: 'success' | 'rate_limit' | 'timeout' | 'upstream_error' | 'schema_error';
  httpStatus: number | null;
  message: string;
  traceId: string;
  spanId: string;
}
export interface TeamJob {
  id: string;
  eventId: string;
  scenario: ConnectorScenario;
  status: TeamJobStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt: string | null;
  sourceAttempts: number;
  deliveryAttempts: number;
  generation: number;
  sourceRecovered: boolean;
  sourceRaw: unknown;
  sourceSha256: string | null;
  payload: ConnectorPayload | null;
  submittedBy: string | null;
  submittedByName: string | null;
  approvedBy: string | null;
  approvedByName: string | null;
  reviewReason: string | null;
  approvalReason: string | null;
  error: string | null;
  traceId: string;
  attempts: TeamAttempt[];
  receipt: TeamReceipt | null;
}
export interface TeamReceipt {
  id: string;
  eventId: string;
  reference: string;
  payloadSha256: string;
  createdAt: string;
}
export interface TeamAuditEvent {
  id: number;
  type: string;
  jobId: string | null;
  actorName: string;
  actorRole: string;
  message: string;
  createdAt: string;
  traceId: string | null;
}
export interface TeamSnapshot {
  workspace: { id: string; name: string; createdAt: string; expiresAt: string };
  actor: TeamActor;
  jobs: TeamJob[];
  events: TeamAuditEvent[];
  metrics: {
    total: number;
    awaitingReview: number;
    awaitingApproval: number;
    inFlight: number;
    delivered: number;
    deadLetter: number;
    duplicateEvents: number;
    destinationWrites: number;
    attempts: number;
    retries: number;
    p95AttemptMs: number | null;
  };
  limits: { lifetimeHours: 24; maxJobs: number; maxAttempts: number };
}
export interface TeamCommandResult {
  snapshot: TeamSnapshot;
  replayed: boolean;
  jobId?: string;
}
export interface EnqueueCommand {
  scenario: ConnectorScenario;
}
export interface ReviewCommand {
  expectedRevision: number;
  payload: ConnectorPayload;
  reason: string;
}
export interface ApproveCommand {
  expectedRevision: number;
  reason: string;
}
export interface ReplayCommand {
  expectedRevision: number;
  reason: string;
  restoreConnector: boolean;
}

/** Team API: separate server-authenticated demo accounts, fictional workspace only.
 * POST /api/team/demo {} -> DemoAccess (no actor session until login).
 * POST /api/team/login {workspaceId,username,password} -> TeamSnapshot + HttpOnly actor cookie.
 * POST /api/team/logout {} -> {ok:true}, invalidates cookie/session.
 * GET /api/team/workspace -> TeamSnapshot; needs actor cookie.
 * POST /api/team/jobs EnqueueCommand -> TeamSnapshot (analyst; Idempotency-Key).
 * POST /api/team/jobs/:id/review ReviewCommand -> TeamSnapshot (analyst; Idempotency-Key).
 * POST /api/team/jobs/:id/approve ApproveCommand -> TeamSnapshot (approver; Idempotency-Key).
 * POST /api/team/jobs/:id/replay ReplayCommand -> TeamSnapshot (analyst; Idempotency-Key).
 * GET /api/team/jobs/:id/trace.json -> {author,creator,job,events}; scoped to actor workspace.
 * The worker calls authenticated HTTP sandbox source/destination routes; never arbitrary URLs.
 * GET /api/team/sandbox/:id/source; POST /api/team/sandbox/:id/destination {eventId,payload}.
 * No external identity verification, arbitrary uploads, real clients, financial data or external API keys.
 */
