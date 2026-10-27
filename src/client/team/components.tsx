// Author, creator and maintainer: Dhruba Poudel.
import { useId, useState, type FormEvent } from 'react';
import type {
  ConnectorPayload,
  ConnectorScenario,
  DemoAccess,
  DemoCredential,
  TeamJob,
  TeamJobStatus,
  TeamSnapshot,
} from '../../shared/team-contracts.js';
import {
  displayTime,
  isInFlight,
  SCENARIOS,
  scenarioLabel,
  shortId,
  STATUS_LABELS,
  statusTone,
} from './view';

export function TeamBrand() {
  return (
    <a className="team-brand" href="/" aria-label="Exception Studio team edition home">
      <span className="team-brand-mark" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>
        Exception Studio<small>TEAM EDITION</small>
      </span>
    </a>
  );
}

export function EntryScreen({
  busy,
  access,
  onCreate,
  onLogin,
  onRecover,
  uncertain,
}: {
  busy: boolean;
  access: DemoAccess | null;
  uncertain: boolean;
  onCreate: () => void;
  onLogin: (workspaceId: string, username: string, password: string) => void;
  onRecover: () => void;
}) {
  const [manual, setManual] = useState(false);
  const id = useId();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    onLogin(
      String(values.get('workspaceId') || '').trim(),
      String(values.get('username') || '').trim(),
      String(values.get('password') || ''),
    );
  }
  return (
    <main className="team-entry" id="team-main">
      <header className="team-entry-header">
        <TeamBrand />
        <a href="/classic">
          Original workbench <span aria-hidden="true">↗</span>
        </a>
      </header>
      <div className="team-entry-grid">
        <section className="team-entry-copy">
          <p className="team-eyebrow">
            <span /> A WORKING INTEGRATION DEMONSTRATION
          </p>
          <h1>
            A failed handoff.
            <br />
            <em>A clear way forward.</em>
          </h1>
          <p className="team-lead">
            Receive a work order, inspect what arrived, and let a second account approve delivery.
            When the source fails, the job stays visible.
          </p>
          <div className="team-entry-actions">
            <button className="team-button primary" onClick={onCreate} disabled={busy || uncertain}>
              {busy ? 'Opening workspace…' : 'Start a private demo'}
              <span aria-hidden="true"> →</span>
            </button>
            <button
              className="team-button quiet"
              onClick={() => setManual(!manual)}
              disabled={busy || uncertain}
            >
              {manual ? 'Hide sign in' : 'Use demo account access'}
            </button>
          </div>
          <p className="team-entry-note">
            Fictional data. Two demo accounts. Your isolated workspace expires after 24 hours. No
            registration or real business information needed.
          </p>
          {uncertain ? (
            <div className="team-inline-warning">
              <strong>The account state needs checking.</strong>
              <p>
                The previous request may have reached the server. Check the current session before
                making another change.
              </p>
              <button className="team-button secondary" onClick={onRecover} disabled={busy}>
                Check current session
              </button>
            </div>
          ) : null}
          {access ? (
            <div className="team-access-callout">
              <strong>Your workspace has been created.</strong>
              <p>
                Sign in using an account below. Keep the access details if you want to open this
                workspace in a second browser.
              </p>
              {access.credentials.map((credential) => (
                <button
                  className="team-button secondary"
                  key={credential.username}
                  disabled={busy || uncertain}
                  onClick={() =>
                    onLogin(access.workspaceId, credential.username, credential.password)
                  }
                >
                  Sign in as {credential.role}
                </button>
              ))}
            </div>
          ) : null}
          {manual ? (
            <form className="team-manual-login" onSubmit={submit}>
              <h2>Sign in to a demo workspace</h2>
              <label htmlFor={id + '-workspace'}>Workspace ID</label>
              <input
                id={id + '-workspace'}
                name="workspaceId"
                defaultValue={access?.workspaceId}
                required
                autoComplete="off"
                maxLength={80}
              />
              <label htmlFor={id + '-username'}>Username</label>
              <input
                id={id + '-username'}
                name="username"
                required
                autoComplete="username"
                maxLength={80}
              />
              <label htmlFor={id + '-password'}>Password</label>
              <input
                id={id + '-password'}
                name="password"
                type="password"
                required
                autoComplete="current-password"
                maxLength={160}
              />
              <button className="team-button primary" disabled={busy || uncertain}>
                Sign in
              </button>
            </form>
          ) : null}
        </section>
        <section className="team-system-preview" aria-label="How the demonstration works">
          <div className="team-preview-top">
            <span className="team-tag">THE HANDOFF</span>
            <span className="team-preview-live">
              <i /> SERVER + PERSISTENT STORE
            </span>
          </div>
          <div className="team-preview-card source">
            <span className="team-node-number">01</span>
            <div>
              <small>SOURCE CONNECTOR</small>
              <strong>Work order received</strong>
              <span>Original payload retained</span>
            </div>
            <span className="team-node-icon" aria-hidden="true">
              ↗
            </span>
          </div>
          <div className="team-preview-line">
            <span>Rate limit? Wait and retry.</span>
          </div>
          <div className="team-preview-card review">
            <span className="team-node-number">02</span>
            <div>
              <small>ANALYST</small>
              <strong>Check the work order</strong>
              <span>Correct fields with a reason</span>
            </div>
            <span className="team-node-icon" aria-hidden="true">
              ✓
            </span>
          </div>
          <div className="team-preview-line">
            <span>A different account approves.</span>
          </div>
          <div className="team-preview-card approve">
            <span className="team-node-number">03</span>
            <div>
              <small>APPROVER</small>
              <strong>Authorise delivery</strong>
              <span>Permission checked on the server</span>
            </div>
            <span className="team-node-icon" aria-hidden="true">
              ✓
            </span>
          </div>
          <div className="team-preview-line">
            <span>Lost response? Reuse the receipt.</span>
          </div>
          <div className="team-preview-card destination">
            <span className="team-node-number">04</span>
            <div>
              <small>DESTINATION SANDBOX</small>
              <strong>One confirmed delivery</strong>
              <span>Trace every attempt and decision</span>
            </div>
            <span className="team-node-icon" aria-hidden="true">
              ↗
            </span>
          </div>
          <div className="team-preview-caption">
            <span>Built by Dhruba Poudel</span>
            <span>React · TypeScript · Node.js · SQLite</span>
          </div>
        </section>
      </div>
      <div className="team-entry-evidence">
        <div>
          <b>Separate accounts</b>
          <span>Analyst reviews. Approver authorises.</span>
        </div>
        <div>
          <b>Recoverable jobs</b>
          <span>Retries, failures and replay stay inspectable.</span>
        </div>
        <div>
          <b>Evidence preserved</b>
          <span>Original source, audit history and delivery receipt.</span>
        </div>
      </div>
      <TeamFooter />
    </main>
  );
}

export function AccountPanel({
  snapshot,
  access,
  busy,
  onSwitch,
  onLogout,
}: {
  snapshot: TeamSnapshot;
  access: DemoAccess | null;
  busy: boolean;
  onSwitch: (credential: DemoCredential) => void;
  onLogout: () => void;
}) {
  const [copied, setCopied] = useState(false);
  async function copyAccess() {
    if (!access) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(access, null, 2));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  const other = access?.credentials.find((credential) => credential.role !== snapshot.actor.role);
  return (
    <div className="team-account-panel">
      <div className="team-person">
        <span aria-hidden="true">{snapshot.actor.displayName.slice(0, 1)}</span>
        <div>
          <strong>{snapshot.actor.displayName}</strong>
          <small>{snapshot.actor.role} account</small>
        </div>
      </div>
      <div className="team-account-actions">
        {other ? (
          <button
            className="team-button secondary compact"
            disabled={busy}
            onClick={() => onSwitch(other)}
          >
            Sign in as {other.role}
          </button>
        ) : null}
        <button className="team-button quiet compact" disabled={busy} onClick={onLogout}>
          Sign out
        </button>
      </div>
      {access ? (
        <details className="team-access-details">
          <summary>Demo account access</summary>
          <p>
            These are fictional accounts for this workspace, not verified organisational identities.
            Access is shown only while this page keeps the creation response in memory.
          </p>
          <code className="team-workspace-code">Workspace: {access.workspaceId}</code>
          {access.credentials.map((credential) => (
            <div className="team-credential" key={credential.username}>
              <b>{credential.role}</b>
              <code>{credential.username}</code>
              <code>{credential.password}</code>
            </div>
          ))}
          <button className="team-button secondary compact" onClick={() => void copyAccess()}>
            {copied ? 'Access copied' : 'Copy demo access'}
          </button>
        </details>
      ) : (
        <p className="team-account-hint">
          To use another account, sign out and enter the access details saved when this workspace
          was created.
        </p>
      )}
    </div>
  );
}

export function MetricStrip({ snapshot }: { snapshot: TeamSnapshot }) {
  const m = snapshot.metrics;
  return (
    <section className="team-metric-strip" aria-label="Workspace metrics">
      <div>
        <span>To review</span>
        <b>{m.awaitingReview}</b>
        <small>Analyst action</small>
      </div>
      <div>
        <span>To approve</span>
        <b>{m.awaitingApproval}</b>
        <small>Second account</small>
      </div>
      <div>
        <span>Delivered</span>
        <b>{m.delivered}</b>
        <small>
          {m.destinationWrites} destination {m.destinationWrites === 1 ? 'write' : 'writes'}
        </small>
      </div>
      <div>
        <span>Attempts exhausted</span>
        <b className={m.deadLetter ? 'warning' : ''}>{m.deadLetter}</b>
        <small>Explicit replay needed</small>
      </div>
    </section>
  );
}

type QueueFilter = 'all' | 'review' | 'approval' | 'active' | 'delivered' | 'failed';
const FILTERS: { id: QueueFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'review', label: 'Review' },
  { id: 'approval', label: 'Approval' },
  { id: 'active', label: 'In progress' },
  { id: 'delivered', label: 'Delivered' },
  { id: 'failed', label: 'Failed' },
];
function matchesFilter(job: TeamJob, filter: QueueFilter): boolean {
  return (
    filter === 'all' ||
    (filter === 'review' && ['awaiting_review', 'schema_error'].includes(job.status)) ||
    (filter === 'approval' && job.status === 'awaiting_approval') ||
    (filter === 'active' && isInFlight(job)) ||
    (filter === 'delivered' && job.status === 'delivered') ||
    (filter === 'failed' && job.status === 'dead_letter')
  );
}

export function JobQueue({
  snapshot,
  selectedId,
  busy,
  onSelect,
  onEnqueue,
}: {
  snapshot: TeamSnapshot;
  selectedId: string | null;
  busy: boolean;
  onSelect: (id: string) => void;
  onEnqueue: (scenario: ConnectorScenario) => void;
}) {
  const [scenario, setScenario] = useState<ConnectorScenario>('healthy');
  const [filter, setFilter] = useState<QueueFilter>('all');
  const matching = snapshot.jobs.filter((job) => matchesFilter(job, filter));
  const chosen = SCENARIOS.find((item) => item.id === scenario)!;
  const scenarioId = useId();
  return (
    <section className="team-queue-panel">
      <div className="team-section-heading">
        <div>
          <p className="team-eyebrow">CONNECTOR OPERATIONS</p>
          <h2>The handoff queue</h2>
        </div>
        <span className="team-count-label">
          {snapshot.jobs.length} / {snapshot.limits.maxJobs}
        </span>
      </div>
      {snapshot.actor.role === 'analyst' ? (
        <form
          className="team-scenario-form"
          onSubmit={(event) => {
            event.preventDefault();
            onEnqueue(scenario);
          }}
        >
          <label htmlFor={scenarioId}>Choose a demonstration</label>
          <div className="team-scenario-controls">
            <select
              id={scenarioId}
              value={scenario}
              onChange={(event) => setScenario(event.target.value as ConnectorScenario)}
              disabled={busy}
            >
              {SCENARIOS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
            <button
              className="team-button primary"
              disabled={busy || snapshot.jobs.length >= snapshot.limits.maxJobs}
            >
              Run scenario <span aria-hidden="true">→</span>
            </button>
          </div>
          <p>{chosen.description}</p>
        </form>
      ) : (
        <div className="team-role-note">
          <span className="team-role-symbol" aria-hidden="true">
            ✓
          </span>
          <p>
            <strong>You are signed in as an approver.</strong> Review submitted work and authorise
            delivery. Creating and changing work orders belongs to the analyst account.
          </p>
        </div>
      )}
      <div className="team-filters" role="group" aria-label="Filter jobs">
        {FILTERS.map((item) => (
          <button
            key={item.id}
            aria-pressed={filter === item.id}
            onClick={() => setFilter(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {matching.length ? (
        <div className="team-job-list">
          {matching.map((job) => (
            <button
              key={job.id}
              className={'team-job-row ' + (selectedId === job.id ? 'selected' : '')}
              onClick={() => onSelect(job.id)}
              aria-pressed={selectedId === job.id}
            >
              <span className={'team-job-indicator ' + statusTone(job.status)} aria-hidden="true" />
              <span className="team-job-description">
                <strong>{job.payload?.reference || 'Source ' + shortId(job.eventId)}</strong>
                <span>{scenarioLabel(job.scenario)}</span>
              </span>
              <span className="team-job-row-meta">
                <StatusBadge status={job.status} />
                <small>{displayTime(job.createdAt)}</small>
              </span>
              <span className="team-job-arrow" aria-hidden="true">
                ↗
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="team-queue-empty">
          <div className="team-empty-symbol" aria-hidden="true">
            ↗
          </div>
          <h3>
            {snapshot.jobs.length ? 'No jobs in this view' : 'Your first handoff starts here'}
          </h3>
          <p>
            {snapshot.jobs.length
              ? 'Choose another filter to see the other stages.'
              : snapshot.actor.role === 'analyst'
                ? 'Run Healthy handoff above. Inspect the received work order, submit your review, then sign in as the approver.'
                : 'An analyst needs to receive and review a work order before it can be approved.'}
          </p>
        </div>
      )}
      <div className="team-queue-footnote">
        <span>
          <i className="team-small-dot" />
          {snapshot.metrics.inFlight ? 'Worker processing jobs' : 'Worker ready'}
        </span>
        <span>Up to {snapshot.limits.maxAttempts} attempts per phase</span>
      </div>
    </section>
  );
}

export function StatusBadge({ status }: { status: TeamJobStatus }) {
  return <span className={'team-status ' + statusTone(status)}>{STATUS_LABELS[status]}</span>;
}

export function JobInspector({
  job,
  snapshot,
  busy,
  onReview,
  onApprove,
  onReplay,
}: {
  job: TeamJob | null;
  snapshot: TeamSnapshot;
  busy: boolean;
  onReview: (job: TeamJob, payload: ConnectorPayload, reason: string) => void;
  onApprove: (job: TeamJob, reason: string) => void;
  onReplay: (job: TeamJob, reason: string) => void;
}) {
  if (!job)
    return (
      <aside className="team-inspector team-inspector-empty">
        <span className="team-eyebrow">THE REVIEW DESK</span>
        <h2>See the whole handoff.</h2>
        <p>
          Select a job to inspect its source, make a reasoned decision, and follow delivery through
          to its receipt.
        </p>
        <ol>
          <li>
            <span>01</span> Receive and validate
          </li>
          <li>
            <span>02</span> Analyst reviews
          </li>
          <li>
            <span>03</span> Approver authorises
          </li>
          <li>
            <span>04</span> Worker delivers
          </li>
        </ol>
      </aside>
    );
  return (
    <aside className="team-inspector" aria-label="Selected job">
      <div className="team-inspector-heading">
        <div>
          <p className="team-eyebrow">SELECTED HANDOFF</p>
          <h2>{job.payload?.reference || 'Source event'}</h2>
        </div>
        <StatusBadge status={job.status} />
      </div>
      <p className="team-inspector-subtitle">
        {scenarioLabel(job.scenario)} <span>·</span> Revision {job.revision}
      </p>
      <JobProgress job={job} />
      {job.error ? (
        <div className="team-job-error">
          <strong>
            {job.status === 'schema_error'
              ? 'The source needs a correction'
              : job.status === 'dead_letter'
                ? 'The job is retained for recovery'
                : 'The connector reported a problem'}
          </strong>
          <p>{job.error}</p>
          {job.nextAttemptAt ? <p>Next attempt: {displayTime(job.nextAttemptAt)}</p> : null}
        </div>
      ) : null}
      {isInFlight(job) ? (
        <div className="team-running-note" role="status">
          <span className="team-working-dot" />
          <p>
            {job.status.includes('delivery')
              ? 'The worker is delivering the approved work order.'
              : 'The worker is receiving the fictional source.'}{' '}
            You can inspect the attempt history below.
          </p>
        </div>
      ) : null}
      {job.status === 'awaiting_review' || job.status === 'schema_error' ? (
        snapshot.actor.role === 'analyst' ? (
          <ReviewEditor
            key={job.id + ':' + job.revision}
            job={job}
            busy={busy}
            onReview={onReview}
          />
        ) : (
          <div className="team-role-note">
            <p>An analyst must review or correct this source before you can approve delivery.</p>
          </div>
        )
      ) : null}
      {job.status === 'awaiting_approval' ? (
        <>
          <PayloadFacts payload={job.payload} />
          <div className="team-submission">
            <small>SUBMITTED BY</small>
            <strong>{job.submittedByName || 'Analyst'}</strong>
            <p>{job.reviewReason}</p>
          </div>
          {snapshot.actor.role === 'approver' ? (
            <ApprovalEditor
              key={job.id + ':' + job.revision}
              job={job}
              busy={busy}
              onApprove={onApprove}
            />
          ) : (
            <div className="team-role-note">
              <p>
                Your review is saved. Sign in with the approver account to authorise this delivery.
              </p>
            </div>
          )}
        </>
      ) : null}
      {job.status === 'dead_letter' && snapshot.actor.role === 'analyst' && !job.approvedBy ? (
        <ReplayEditor key={job.id + ':' + job.revision} job={job} busy={busy} onReplay={onReplay} />
      ) : null}
      {job.status === 'dead_letter' && job.approvedBy ? (
        <div className="team-role-note">
          <p>
            Delivery attempts have been exhausted. The approved payload and every attempt remain in
            the trace. Start a new fictional scenario to compare behaviour; this demo does not
            discard or silently reissue a failed delivery.
          </p>
        </div>
      ) : null}
      {job.receipt ? (
        <section className="team-receipt">
          <div className="team-receipt-title">
            <span aria-hidden="true">✓</span>
            <div>
              <small>DESTINATION CONFIRMED</small>
              <h3>Delivery receipt</h3>
            </div>
          </div>
          <PayloadFacts payload={job.payload} />
          <dl>
            <div>
              <dt>Approved by</dt>
              <dd>{job.approvedByName || 'Approver'}</dd>
            </div>
            <div>
              <dt>Receipt</dt>
              <dd>
                <code>{shortId(job.receipt.id)}</code>
              </dd>
            </div>
            <div>
              <dt>Confirmed at</dt>
              <dd>{displayTime(job.receipt.createdAt)}</dd>
            </div>
          </dl>
          <details>
            <summary>Payload SHA-256</summary>
            <code className="team-hash">{job.receipt.payloadSha256}</code>
          </details>
        </section>
      ) : null}
      <section className="team-attempts">
        <div className="team-subheading">
          <h3>Attempt history</h3>
          <span>{job.attempts.length} recorded</span>
        </div>
        {job.attempts.length ? (
          <ol>
            {job.attempts.map((attempt) => (
              <li key={attempt.id}>
                <span
                  className={
                    'team-attempt-dot ' + (attempt.outcome === 'success' ? 'success' : 'fault')
                  }
                  aria-hidden="true"
                />
                <div>
                  <strong>
                    {attempt.phase === 'source' ? 'Receive source' : 'Deliver record'}{' '}
                    <small>
                      Attempt {attempt.attempt} · Run {attempt.generation}
                    </small>
                  </strong>
                  <p>{attempt.message}</p>
                  <div className="team-attempt-meta">
                    <span>{displayTime(attempt.startedAt)}</span>
                    <span>{Math.round(attempt.durationMs)} ms</span>
                    <span>
                      {attempt.httpStatus
                        ? 'HTTP ' + attempt.httpStatus
                        : attempt.outcome === 'timeout'
                          ? 'Timed out'
                          : 'No response'}
                    </span>
                  </div>
                  <details className="team-attempt-trace">
                    <summary>Attempt trace</summary>
                    <code className="team-hash">
                      Trace: {attempt.traceId}
                      <br />
                      Span: {attempt.spanId}
                      <br />
                      Outcome: {attempt.outcome}
                    </code>
                  </details>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="team-muted">No completed attempt yet. The queued job is persisted.</p>
        )}
      </section>
      <details className="team-technical">
        <summary>Source and trace evidence</summary>
        <p>Original source is retained separately from the analyst’s reviewed payload.</p>
        <small>TRACE ID</small>
        <code className="team-hash">{job.traceId}</code>
        <CopyEvidence value={job.traceId} label="trace ID" />
        <small>SOURCE SHA-256</small>
        <code className="team-hash">{job.sourceSha256 || 'Not received yet'}</code>
        <small>ORIGINAL SOURCE</small>
        <pre>
          {job.sourceRaw === null ? 'Not received yet' : JSON.stringify(job.sourceRaw, null, 2)}
        </pre>
        <small>EVENT ID</small>
        <code className="team-hash">{job.eventId}</code>
        <a
          className="team-download"
          href={'/api/team/jobs/' + encodeURIComponent(job.id) + '/trace.json'}
          download
        >
          Download job evidence <span aria-hidden="true">↓</span>
        </a>
      </details>
    </aside>
  );
}

function JobProgress({ job }: { job: TeamJob }) {
  const step =
    job.status === 'delivered'
      ? 4
      : job.approvedBy
        ? 3
        : job.submittedBy
          ? 2
          : job.payload || job.status === 'schema_error'
            ? 1
            : 0;
  return (
    <ol className="team-progress" aria-label="Handoff progress">
      {['Receive', 'Review', 'Approve', 'Deliver'].map((label, index) => (
        <li
          className={index < step ? 'complete' : index === step ? 'current' : ''}
          aria-current={index === step ? 'step' : undefined}
          key={label}
        >
          <span aria-hidden="true">{index < step ? '✓' : index + 1}</span>
          <small>{label}</small>
        </li>
      ))}
    </ol>
  );
}

function PayloadFacts({ payload }: { payload: ConnectorPayload | null }) {
  return payload ? (
    <dl className="team-payload-facts">
      <div>
        <dt>Reference</dt>
        <dd>{payload.reference}</dd>
      </div>
      <div>
        <dt>Assigned team</dt>
        <dd>{payload.team}</dd>
      </div>
      <div>
        <dt>Effort</dt>
        <dd>{payload.minutes} minutes</dd>
      </div>
    </dl>
  ) : null;
}

function ReviewEditor({
  job,
  busy,
  onReview,
}: {
  job: TeamJob;
  busy: boolean;
  onReview: (job: TeamJob, payload: ConnectorPayload, reason: string) => void;
}) {
  const [reference, setReference] = useState(job.payload?.reference || '');
  const [team, setTeam] = useState(job.payload?.team || '');
  const [minutes, setMinutes] = useState(job.payload ? String(job.payload.minutes) : '');
  const [reason, setReason] = useState('');
  const id = useId();
  return (
    <form
      className="team-review-form"
      onSubmit={(event) => {
        event.preventDefault();
        onReview(
          job,
          { reference: reference.trim(), team: team.trim(), minutes: Number(minutes) },
          reason.trim(),
        );
      }}
    >
      <h3>{job.status === 'schema_error' ? 'Correct and review' : 'Review the work order'}</h3>
      <p>Check the source below, then record your review. Approval belongs to the other account.</p>
      <label htmlFor={id + '-reference'}>Work order reference</label>
      <input
        id={id + '-reference'}
        value={reference}
        onChange={(event) => setReference(event.target.value)}
        required
        minLength={3}
        maxLength={40}
        pattern={'[A-Z0-9][A-Z0-9\\-]{2,39}'}
        aria-describedby={id + '-reference-hint'}
        disabled={busy}
      />
      <p className="team-field-hint" id={id + '-reference-hint'}>
        3–40 uppercase letters, numbers or hyphens.
      </p>
      <div className="team-field-grid">
        <div>
          <label htmlFor={id + '-team'}>Assigned team</label>
          <input
            id={id + '-team'}
            value={team}
            onChange={(event) => setTeam(event.target.value)}
            required
            minLength={2}
            maxLength={60}
            disabled={busy}
          />
        </div>
        <div>
          <label htmlFor={id + '-minutes'}>Effort in minutes</label>
          <input
            id={id + '-minutes'}
            type="number"
            min="0"
            max="10080"
            step="1"
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
            required
            disabled={busy}
          />
        </div>
      </div>
      <label htmlFor={id + '-reason'}>Review reason</label>
      <textarea
        id={id + '-reason'}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        required
        minLength={8}
        maxLength={400}
        rows={3}
        placeholder="What did you check or correct? Use fictional notes only."
        disabled={busy}
      />
      <button className="team-button primary full" disabled={busy || reason.trim().length < 8}>
        Submit for approval <span aria-hidden="true">→</span>
      </button>
    </form>
  );
}

function ApprovalEditor({
  job,
  busy,
  onApprove,
}: {
  job: TeamJob;
  busy: boolean;
  onApprove: (job: TeamJob, reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const id = useId();
  return (
    <form
      className="team-approval-form"
      onSubmit={(event) => {
        event.preventDefault();
        onApprove(job, reason.trim());
      }}
    >
      <label htmlFor={id}>Approval reason</label>
      <textarea
        id={id}
        rows={3}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        required
        minLength={8}
        maxLength={400}
        placeholder="Describe why this reviewed payload can be delivered."
        disabled={busy}
      />
      <button className="team-button primary full" disabled={busy || reason.trim().length < 8}>
        Approve delivery <span aria-hidden="true">→</span>
      </button>
      <p className="team-small-note">
        The server verifies your role, the current revision and separation from the submitting
        account.
      </p>
    </form>
  );
}

function ReplayEditor({
  job,
  busy,
  onReplay,
}: {
  job: TeamJob;
  busy: boolean;
  onReplay: (job: TeamJob, reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const id = useId();
  return (
    <form
      className="team-replay-form"
      onSubmit={(event) => {
        event.preventDefault();
        onReplay(job, reason.trim());
      }}
    >
      <h3>Restore and replay</h3>
      <p>
        This explicitly restores the fictional source and queues another run. Earlier attempts stay
        in the history.
      </p>
      <label htmlFor={id}>Recovery reason</label>
      <textarea
        id={id}
        rows={3}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        required
        minLength={8}
        maxLength={400}
        placeholder="What changed before this replay?"
        disabled={busy}
      />
      <button className="team-button primary full" disabled={busy || reason.trim().length < 8}>
        Restore sandbox and replay
      </button>
    </form>
  );
}

export function AuditPanel({ snapshot }: { snapshot: TeamSnapshot }) {
  const [visibleCount, setVisibleCount] = useState(12);
  const listId = useId();
  const shown = Math.min(visibleCount, snapshot.events.length);
  const hasMore = shown < snapshot.events.length;
  return (
    <section className="team-audit-panel">
      <div className="team-section-heading">
        <div>
          <p className="team-eyebrow">WHO DID WHAT</p>
          <h2>The decision record</h2>
        </div>
        <span className="team-count-label" aria-live="polite" aria-atomic="true">
          Latest {shown} of {snapshot.events.length} events
        </span>
      </div>
      <div className="team-audit-list" id={listId}>
        {!snapshot.events.length ? (
          <p className="team-audit-empty">
            No decisions yet. Run a scenario to begin the server-recorded history.
          </p>
        ) : null}
        {snapshot.events.slice(0, shown).map((event) => (
          <article key={event.id}>
            <span className="team-audit-time">{displayTime(event.createdAt)}</span>
            <div>
              <p>{event.message}</p>
              <small>
                {event.actorName} <span>·</span> {event.actorRole}
                {event.jobId ? ' · ' + shortId(event.jobId) : ''}
              </small>
            </div>
          </article>
        ))}
      </div>
      {hasMore ? (
        <div className="team-section-heading">
          <button
            className="team-button secondary compact"
            aria-controls={listId}
            onClick={() => setVisibleCount((count) => Math.min(count + 12, 500))}
          >
            Show more events
          </button>
          <span className="team-count-label">
            {snapshot.events.length - shown} older events available
          </span>
        </div>
      ) : null}
      {snapshot.events.length >= 500 ? (
        <p className="team-audit-footnote">
          The server returns at most the latest 500 workspace events. Earlier events may exist
          outside this view.
        </p>
      ) : null}
      <p className="team-audit-footnote">
        Server-recorded actors and timestamps. Fictional demo identities are not independent
        organisational verification.
      </p>
    </section>
  );
}

function CopyEvidence({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<'ready' | 'copied' | 'unavailable'>('ready');
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('unavailable');
    }
  }
  return (
    <div className="team-copy-evidence">
      <button className="team-button secondary compact" onClick={() => void copy()}>
        {state === 'copied' ? 'Copied' : 'Copy ' + label}
      </button>
      {state === 'unavailable' ? (
        <span role="status">Copy unavailable. Select the value above.</span>
      ) : null}
    </div>
  );
}

export function TeamFooter() {
  return (
    <footer className="team-footer">
      <span>
        Designed and developed by <a href="https://about.dhrub.com.np/">Dhruba Poudel</a>
      </span>
      <nav aria-label="Project links">
        <a href="https://github.com/dhrubasuz/exception-studio">Public source ↗</a>
        <a href="/classic">Original workbench ↗</a>
      </nav>
    </footer>
  );
}
