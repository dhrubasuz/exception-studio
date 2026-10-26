// Author, creator and maintainer: Dhruba Poudel.
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { RECORD_FIELDS } from '../shared/contracts.js';
import type {
  DecisionCommand,
  OperationalRecord,
  RowView,
  WorkspaceEvent,
  WorkspaceSnapshot,
} from '../shared/contracts.js';
import {
  changedValues,
  dateTime,
  downloadPath,
  FIELD_LABELS,
  filterRows,
  rowState,
  shortId,
  summaryWidths,
} from './view';
import type { RowFilter, WorkspaceView } from './view';

export function StudioMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 32 32" className="studio-mark">
      <path d="M12 4H5v24h7M20 4h7v24h-7M12 16h8" />
      <path d="m12 11 5 5-5 5" />
    </svg>
  );
}

export function Masthead({
  workspace,
  busy,
  onNew,
}: {
  workspace: WorkspaceSnapshot | null;
  busy: boolean;
  onNew: () => void;
}) {
  return (
    <header className="masthead">
      <a className="studio-brand" href="#main">
        <StudioMark />
        <span>
          Exception <strong>Studio</strong>
          <small>by Dhruba Poudel</small>
        </span>
      </a>
      <div className="masthead-actions">
        <span className="sandbox-badge">
          <span /> Fictional sandbox
        </span>
        <a className="portfolio-link" href="https://about.dhrub.com.np/">
          Portfolio <span aria-hidden="true">↗</span>
        </a>
        {workspace ? (
          <button className="button button-quiet compact" onClick={onNew} disabled={busy}>
            New sandbox
          </button>
        ) : null}
      </div>
    </header>
  );
}

export function Welcome({ busy, onImport }: { busy: boolean; onImport: () => void }) {
  return (
    <section className="welcome" aria-labelledby="welcome-title">
      <div className="welcome-copy">
        <span className="eyebrow">A working system, with the evidence attached</span>
        <h1 id="welcome-title">
          Resolve the exception.
          <br />
          <em>Preserve the evidence.</em>
        </h1>
        <p className="lead">
          Follow an imperfect service-data import through review, correction and a frozen export.
          Every source row stays in view. Every decision belongs to a revision.
        </p>
        <button className="button" onClick={onImport} disabled={busy}>
          {busy ? 'Preparing your workspace…' : 'Open the fictional import'}{' '}
          <span aria-hidden="true">↗</span>
        </button>
        <p className="welcome-note">
          No sign-up. No real records. An isolated sandbox lasting up to 24 hours.
        </p>
      </div>
      <div className="welcome-system" aria-label="The workflow: source, review, frozen revision">
        <div className="mini-title">THE WORKFLOW</div>
        <div className="workflow-block">
          <span className="step-index">01</span>
          <div>
            <strong>Original source</strong>
            <small>Stored separately from corrections</small>
          </div>
          <span className="workflow-symbol" aria-hidden="true">
            ↳
          </span>
        </div>
        <div className="workflow-block emphasized">
          <span className="step-index">02</span>
          <div>
            <strong>Human review</strong>
            <small>Rules, reasons and revision checks</small>
          </div>
          <span className="workflow-symbol" aria-hidden="true">
            ↳
          </span>
        </div>
        <div className="workflow-block">
          <span className="step-index">03</span>
          <div>
            <strong>Exact export</strong>
            <small>Frozen CSV + SHA-256 manifest</small>
          </div>
          <span className="workflow-symbol" aria-hidden="true">
            ✓
          </span>
        </div>
        <div className="system-foot">
          <span>React / TypeScript</span>
          <span>Node / SQL</span>
          <span>Real API</span>
        </div>
      </div>
      <div className="welcome-caption">
        <span>ONE GUIDED SCENARIO</span>
        <p>
          Load the sample. Inspect a held row. Correct or exclude it with a reason. Publish when
          every exception has a decision.
        </p>
      </div>
    </section>
  );
}

export function Overview({
  workspace,
  busy,
  onPublish,
}: {
  workspace: WorkspaceSnapshot;
  busy: boolean;
  onPublish: () => void;
}) {
  const summary = workspace.summary;
  const widths = summaryWidths(summary);
  const canPublish = summary.total > 0 && summary.held === 0;
  return (
    <section className="overview" aria-labelledby="workspace-title">
      <div className="section-top">
        <div>
          <span className="eyebrow">Import workspace / {shortId(workspace.session.id)}</span>
          <h1 id="workspace-title">
            Make the exception <em>explainable.</em>
          </h1>
          <p>{workspace.activeImport?.name ?? 'A separate space for fictional records.'}</p>
        </div>
        <div className="revision-stamp">
          <span>DATASET REVISION</span>
          <strong>{String(workspace.revision).padStart(2, '0')}</strong>
          <small>Checked on every decision</small>
        </div>
      </div>
      <div className="metric-grid">
        <div className="metric">
          <span>Source rows</span>
          <strong>{summary.total}</strong>
          <small>Original input retained</small>
        </div>
        <div className="metric accepted">
          <span>Accepted</span>
          <strong>{summary.accepted}</strong>
          <small>Eligible for export</small>
        </div>
        <div className="metric held">
          <span>Held for review</span>
          <strong>{summary.held}</strong>
          <small>{summary.held ? 'A decision is still needed' : 'No unresolved exceptions'}</small>
        </div>
        <div className="metric excluded">
          <span>Excluded</span>
          <strong>{summary.excluded}</strong>
          <small>Kept in reconciliation</small>
        </div>
      </div>
      <div className="reconciliation">
        <div className="reconciliation-copy">
          <span className="micro-label">ROW RECONCILIATION</span>
          <strong>
            {summary.total} source <span aria-hidden="true">=</span> {summary.accepted} accepted{' '}
            <span aria-hidden="true">+</span> {summary.held} held <span aria-hidden="true">+</span>{' '}
            {summary.excluded} excluded
          </strong>
        </div>
        <div
          className="reconciliation-bar"
          role="img"
          aria-label={`${summary.accepted} accepted, ${summary.held} held, ${summary.excluded} excluded, out of ${summary.total} source rows.`}
        >
          <span className="bar-accepted" style={{ width: `${widths[0]}%` }} />
          <span className="bar-held" style={{ width: `${widths[1]}%` }} />
          <span className="bar-excluded" style={{ width: `${widths[2]}%` }} />
        </div>
        <div className="publish-action">
          <p>
            {canPublish
              ? 'Every source row is accounted for. Freeze this revision when you are ready.'
              : `Resolve the ${summary.held} held ${summary.held === 1 ? 'row' : 'rows'} before publishing.`}
          </p>
          <button className="button compact" onClick={onPublish} disabled={busy || !canPublish}>
            Freeze &amp; publish <span aria-hidden="true">↗</span>
          </button>
        </div>
      </div>
    </section>
  );
}

export function WorkspaceNavigation({
  view,
  onView,
  workspace,
}: {
  view: WorkspaceView;
  onView: (view: WorkspaceView) => void;
  workspace: WorkspaceSnapshot;
}) {
  return (
    <nav className="workspace-nav" aria-label="Workspace views">
      <button
        onClick={() => onView('review')}
        aria-current={view === 'review' ? 'page' : undefined}
      >
        Review queue <span>{workspace.summary.held}</span>
      </button>
      <button
        onClick={() => onView('history')}
        aria-current={view === 'history' ? 'page' : undefined}
      >
        Decision history <span>{workspace.events.length}</span>
      </button>
      <button
        onClick={() => onView('publications')}
        aria-current={view === 'publications' ? 'page' : undefined}
      >
        Frozen exports <span>{workspace.publications.length}</span>
      </button>
    </nav>
  );
}

export function ReviewQueue({
  rows,
  selectedId,
  disabled,
  onSelect,
}: {
  rows: RowView[];
  selectedId: string | null;
  disabled: boolean;
  onSelect: (id: string) => void;
}) {
  const [filter, setFilter] = useState<RowFilter>('held');
  const [query, setQuery] = useState('');
  const visibleRows = filterRows(rows, filter, query);
  const filters: { id: RowFilter; label: string }[] = [
    { id: 'held', label: 'Held' },
    { id: 'all', label: 'All rows' },
    { id: 'accepted', label: 'Accepted' },
    { id: 'excluded', label: 'Excluded' },
  ];
  return (
    <section className="queue-panel" aria-labelledby="queue-title">
      <div className="panel-heading">
        <div>
          <span className="micro-label">01 / INSPECT</span>
          <h2 id="queue-title">The review queue</h2>
        </div>
        <span className="count-note">
          {visibleRows.length} of {rows.length} rows
        </span>
      </div>
      <div className="queue-controls">
        <div className="filter-group" role="group" aria-label="Filter records by decision">
          {filters.map((item) => (
            <button
              key={item.id}
              aria-pressed={filter === item.id}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <label className="search-label">
          <span className="sr-only">Find a reference, team or issue</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a reference, team or issue…"
          />
        </label>
      </div>
      <ul className="queue-list" aria-label="Import records">
        {visibleRows.map((row) => {
          const state = rowState(row);
          return (
            <li key={row.id}>
              <button
                className={`queue-record ${selectedId === row.id ? 'selected' : ''}`}
                disabled={disabled}
                onClick={() => onSelect(row.id)}
                aria-current={selectedId === row.id ? 'true' : undefined}
                aria-label={`Inspect ${row.current.reference || `source line ${row.lineNumber}`}, ${state}${row.issues.length ? `, ${row.issues.length} validation ${row.issues.length === 1 ? 'issue' : 'issues'}` : ''}`}
              >
                <div className="record-top">
                  <strong>
                    {row.current.reference || (
                      <span className="missing-value">Missing reference</span>
                    )}
                  </strong>
                  <span className={`state-pill ${state}`}>
                    {state === 'held' ? 'Review needed' : state}
                  </span>
                </div>
                <div className="record-meta">
                  <span>{row.current.team || 'No team supplied'}</span>
                  <span>Source line {row.lineNumber}</span>
                  {row.changedFields.length ? (
                    <span>
                      {row.changedFields.length}{' '}
                      {row.changedFields.length === 1 ? 'field' : 'fields'} changed
                    </span>
                  ) : null}
                </div>
                {state === 'held' ? (
                  <div className="record-issues">
                    {row.issues.length ? (
                      [...new Set(row.issues.map((issue) => issue.message))]
                        .slice(0, 2)
                        .map((message) => <span key={message}>{message}</span>)
                    ) : (
                      <span>
                        Validation is clear. Confirm the original exception with a review decision.
                      </span>
                    )}
                  </div>
                ) : null}
                <span className="record-arrow" aria-hidden="true">
                  ↗
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {visibleRows.length === 0 ? (
        <div className="empty-state">
          <span className="empty-symbol" aria-hidden="true">
            ✓
          </span>
          <h3>
            {filter === 'held' && !query ? 'The held queue is clear.' : 'No rows in this view.'}
          </h3>
          <p>
            {filter === 'held' && !query
              ? 'Every exception has a decision. Inspect all rows or freeze the current revision.'
              : 'Try another filter or a shorter search.'}
          </p>
          {filter !== 'all' || query ? (
            <button
              className="text-button"
              onClick={() => {
                setFilter('all');
                setQuery('');
              }}
            >
              Show all source rows <span aria-hidden="true">↗</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function RowInspector({
  row,
  revision,
  disabled,
  onDecision,
  onNext,
}: {
  row: RowView | null;
  revision: number;
  disabled: boolean;
  onDecision: (row: RowView, command: DecisionCommand) => Promise<void>;
  onNext: (() => void) | null;
}) {
  const [draft, setDraft] = useState<OperationalRecord | null>(() =>
    row ? { ...row.current } : null,
  );
  const [reason, setReason] = useState('');
  const [formMessage, setFormMessage] = useState('');
  const reasonInput = useRef<HTMLTextAreaElement>(null);
  if (!row || !draft)
    return (
      <aside className="inspector inspector-empty">
        <span className="micro-label">02 / DECIDE</span>
        <h2>Choose a source row.</h2>
        <p>Inspect what arrived, review the current values and record a reason for the decision.</p>
      </aside>
    );
  const currentState = rowState(row);
  const changes = changedValues(row.current, draft);
  async function decide(action: DecisionCommand['action']) {
    if (disabled || !row || !draft) return;
    if (reason.trim().length < 10) {
      setFormMessage('Give a specific reason of at least 10 characters.');
      reasonInput.current?.focus();
      return;
    }
    setFormMessage('');
    await onDecision(row, {
      expectedRevision: revision,
      action,
      reason: reason.trim(),
      ...(action === 'accept' ? { changes } : {}),
    });
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void decide('accept');
  }
  return (
    <aside className="inspector" aria-labelledby="inspector-title">
      <div className="panel-heading">
        <div>
          <span className="micro-label">02 / DECIDE</span>
          <h2 id="inspector-title">{row.current.reference || `Source line ${row.lineNumber}`}</h2>
        </div>
        <span className={`state-pill ${currentState}`}>
          {currentState === 'held' ? 'Review needed' : currentState}
        </span>
      </div>
      <p className="inspector-intro">
        Source line {row.lineNumber} <span aria-hidden="true">·</span> Editing against revision{' '}
        <strong>{revision}</strong>
      </p>
      {row.issues.length ? (
        <div className="validation-note">
          <strong>
            {row.issues.length} validation {row.issues.length === 1 ? 'issue' : 'issues'}
          </strong>
          <ul>
            {row.issues.map((issue, index) => (
              <li key={`${issue.field}-${issue.code}-${index}`}>{issue.message}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="validation-note is-clear">
          <strong>Current values pass the data rules.</strong>
          <p>
            {row.reviewed
              ? 'The saved decision and original values remain available below.'
              : 'An original exception still needs an explicit review decision.'}
          </p>
        </div>
      )}
      <form onSubmit={submit} className="review-form">
        <fieldset disabled={disabled}>
          <legend className="sr-only">
            Review current values for {row.current.reference || `source line ${row.lineNumber}`}
          </legend>
          <div className="field-grid">
            {RECORD_FIELDS.map((field) => (
              <label key={field} className="record-field">
                <span>
                  {FIELD_LABELS[field]}
                  {draft[field] !== row.original[field] ? (
                    <small className="changed-marker">changed</small>
                  ) : null}
                </span>
                <input
                  type="text"
                  inputMode={field === 'minutes' ? 'numeric' : 'text'}
                  name={field}
                  aria-label={FIELD_LABELS[field]}
                  value={draft[field]}
                  onChange={(event) =>
                    setDraft((previous) =>
                      previous ? { ...previous, [field]: event.target.value } : previous,
                    )
                  }
                  maxLength={200}
                  aria-describedby={`source-${field}`}
                  autoComplete="off"
                  spellCheck={false}
                />
                <small id={`source-${field}`} className="original-value">
                  Source: <code>{row.original[field] || '(empty)'}</code>
                </small>
              </label>
            ))}
          </div>
          <label className="reason-label">
            <span>
              Reason for this decision <small>Required</small>
            </span>
            <textarea
              ref={reasonInput}
              aria-label="Reason for this decision"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Explain the correction or why this row should be excluded…"
              maxLength={280}
              minLength={10}
              rows={3}
              aria-describedby="reason-guidance"
            />
          </label>
          <p className="field-guidance" id="reason-guidance">
            Use a fictional review note. This is recorded with the decision; the source values are
            preserved.
          </p>
          {formMessage ? (
            <p className="form-error" role="alert">
              {formMessage}
            </p>
          ) : null}
          <div className="inspector-actions">
            <button className="button" type="submit">
              Save &amp; accept row <span aria-hidden="true">↗</span>
            </button>
            <button
              className="button button-outline"
              type="button"
              onClick={() => void decide('exclude')}
            >
              Exclude with reason
            </button>
          </div>
        </fieldset>
      </form>
      {row.lastReason ? (
        <div className="previous-decision">
          <span className="micro-label">LAST SAVED REASON</span>
          <p>{row.lastReason}</p>
        </div>
      ) : null}
      {onNext ? (
        <button className="next-record" type="button" onClick={onNext} disabled={disabled}>
          Inspect the next held row <span aria-hidden="true">→</span>
        </button>
      ) : null}
      <p className="inspector-footnote">
        A saved decision updates this sandbox. It does not establish an independent approver or
        create a production import.
      </p>
    </aside>
  );
}

export function DecisionHistory({ events }: { events: WorkspaceEvent[] }) {
  return (
    <section className="history-panel" aria-labelledby="history-title">
      <div className="panel-heading">
        <div>
          <span className="micro-label">THE CHANGE, AND THE REASON</span>
          <h2 id="history-title">Decision history</h2>
        </div>
        <span className="count-note">{events.length} ordered events</span>
      </div>
      <p className="panel-intro">
        Follow the import, corrections and publications in this sandbox. Actor identity is not
        independently verified; this is an application history, not a tamper-proof audit service.
      </p>
      <ol className="timeline">
        {events
          .slice()
          .reverse()
          .map((event) => (
            <li key={event.id}>
              <div
                className={`timeline-dot ${event.type === 'dataset.published' ? 'published' : ''}`}
                aria-hidden="true"
              />
              <div className="event-heading">
                <strong>{event.message}</strong>
                <span className="event-revision">Revision {event.revision}</span>
              </div>
              <div className="event-meta">
                <time dateTime={event.createdAt}>{dateTime(event.createdAt)}</time>
                <span>Event {event.id}</span>
              </div>
              {event.reason ? <p className="event-reason">“{event.reason}”</p> : null}
              {event.changes && Object.keys(event.changes).length ? (
                <dl className="event-changes">
                  {RECORD_FIELDS.flatMap((field) => {
                    const change = event.changes?.[field];
                    return change ? (
                      <div key={field}>
                        <dt>{FIELD_LABELS[field]}</dt>
                        <dd>
                          <code>{change.before || '(empty)'}</code>
                          <span aria-hidden="true"> → </span>
                          <code>{change.after || '(empty)'}</code>
                        </dd>
                      </div>
                    ) : (
                      []
                    );
                  })}
                </dl>
              ) : null}
            </li>
          ))}
      </ol>
    </section>
  );
}

export function Publications({
  workspace,
  busy,
  onPublish,
  onReview,
}: {
  workspace: WorkspaceSnapshot;
  busy: boolean;
  onPublish: () => void;
  onReview: () => void;
}) {
  return (
    <section className="publications-panel" aria-labelledby="publications-title">
      <div className="panel-heading">
        <div>
          <span className="micro-label">EXACT BYTES. NAMED REVISION.</span>
          <h2 id="publications-title">Frozen exports</h2>
        </div>
        <span className="count-note">
          {workspace.publications.length}{' '}
          {workspace.publications.length === 1 ? 'publication' : 'publications'}
        </span>
      </div>
      <p className="panel-intro">
        A publication stores the accepted CSV and its manifest together. Later corrections do not
        rewrite an earlier download. Save files you want to retain before the fictional sandbox
        expires.
      </p>
      {workspace.publications.length ? (
        <div className="publication-grid">
          {workspace.publications
            .slice()
            .reverse()
            .map((publication) => (
              <article className="publication-card" key={publication.id}>
                <div className="publication-top">
                  <span className="state-pill accepted">Frozen snapshot</span>
                  <span>{dateTime(publication.createdAt)}</span>
                </div>
                <h3>Revision {String(publication.revision).padStart(2, '0')}</h3>
                <p className="publication-counts">
                  <strong>{publication.acceptedRows}</strong> accepted rows{' '}
                  <span aria-hidden="true">·</span> {publication.excludedRows} excluded
                </p>
                <div className="publication-links">
                  <a className="button compact" href={downloadPath(publication.csvUrl)} download>
                    Download CSV <span aria-hidden="true">↓</span>
                  </a>
                  <a
                    className="button button-outline compact"
                    href={downloadPath(publication.manifestUrl)}
                    download
                  >
                    Manifest JSON <span aria-hidden="true">↓</span>
                  </a>
                </div>
                <details className="digest-details">
                  <summary>Inspect the SHA-256 digest</summary>
                  <code>{publication.dataSha256}</code>
                  <p>
                    The manifest also records the source hash, dataset revision, author, counts and
                    byte length.
                  </p>
                </details>
                <small className="publication-id">Publication {shortId(publication.id, 16)}</small>
              </article>
            ))}
        </div>
      ) : (
        <div className="publication-empty">
          <div>
            <span className="empty-symbol" aria-hidden="true">
              ↗
            </span>
            <h3>One reviewed revision. Two inspectable files.</h3>
            <p>
              {workspace.summary.held
                ? `${workspace.summary.held} rows are still held. Resolve their exceptions to create the first publication.`
                : 'The held queue is clear. Freeze this revision to inspect its CSV and manifest.'}
            </p>
          </div>
          {workspace.summary.held ? (
            <button className="button" onClick={onReview}>
              Return to review queue <span aria-hidden="true">→</span>
            </button>
          ) : (
            <button
              className="button"
              onClick={onPublish}
              disabled={busy || workspace.summary.total === 0}
            >
              Freeze this revision <span aria-hidden="true">↗</span>
            </button>
          )}
        </div>
      )}
    </section>
  );
}

export function UnderTheHood({
  workspace,
  busy,
  onConflictDemo,
  onCleanImport,
}: {
  workspace: WorkspaceSnapshot | null;
  busy: boolean;
  onConflictDemo: () => void;
  onCleanImport: () => void;
}) {
  return (
    <section className="engineering-notes" aria-labelledby="engineering-title">
      <div className="engineering-heading">
        <span className="eyebrow">Built to make the behaviour inspectable</span>
        <h2 id="engineering-title">
          The interface is only <em>one layer.</em>
        </h2>
      </div>
      <details>
        <summary>
          Inspect the architecture and safeguards <span aria-hidden="true">+</span>
        </summary>
        <div
          className="architecture-flow"
          aria-label="React TypeScript client to Node API to SQLite transactions"
        >
          <div>
            <span>01 / PRESENTATION</span>
            <strong>React + TypeScript</strong>
            <p>Review queue, explicit actions and visible failure states.</p>
          </div>
          <span className="architecture-arrow" aria-hidden="true">
            →
          </span>
          <div>
            <span>02 / CONTRACT</span>
            <strong>Node JSON API</strong>
            <p>Session isolation, bounded requests and retry keys.</p>
          </div>
          <span className="architecture-arrow" aria-hidden="true">
            →
          </span>
          <div>
            <span>03 / STATE</span>
            <strong>SQL transactions</strong>
            <p>Separate source values, revisions, decisions and export bytes.</p>
          </div>
        </div>
        <div className="engineering-grid">
          <article>
            <span>01</span>
            <h3>The source stays intact.</h3>
            <p>
              Corrections are stored separately. Reconciliation accounts for accepted, held and
              excluded rows.
            </p>
          </article>
          <article>
            <span>02</span>
            <h3>Stale edits are rejected.</h3>
            <p>
              Each decision includes its expected dataset revision. A conflicting request receives
              HTTP 409.
            </p>
          </article>
          <article>
            <span>03</span>
            <h3>A retry keeps its key.</h3>
            <p>
              Successful mutations are recorded against a request key and body, preventing duplicate
              decisions after a retry.
            </p>
          </article>
          <article>
            <span>04</span>
            <h3>A publication is a snapshot.</h3>
            <p>
              CSV bytes and a SHA-256 manifest are frozen together. New revisions leave older
              downloads unchanged.
            </p>
          </article>
        </div>
        {workspace?.activeImport ? (
          <div className="technical-actions">
            <div>
              <strong>Try the safeguards.</strong>
              <p>
                The stale-request example deliberately sends an older revision; it should be
                rejected without changing a row.
              </p>
            </div>
            <button
              className="button button-outline compact"
              onClick={onConflictDemo}
              disabled={busy || workspace.revision < 1}
            >
              Demonstrate a stale request
            </button>
            <button className="text-button" onClick={onCleanImport} disabled={busy}>
              Load the clean fixture <span aria-hidden="true">↗</span>
            </button>
          </div>
        ) : null}
        <p className="scope-note">
          Public mode accepts bundled fictional fixtures only. This is a portfolio demonstration
          with anonymous sandbox sessions, not enterprise authentication, organisational approval or
          a production data service.
        </p>
      </details>
    </section>
  );
}

export function SandboxDialog({
  busy,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const current = dialog.current;
    current?.showModal();
    return () => {
      current?.close();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="sandbox-dialog"
      aria-labelledby="sandbox-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <span className="eyebrow">A separate fictional workspace</span>
      <h2 id="sandbox-dialog-title">Start a fresh sandbox?</h2>
      <p>
        Your browser will switch to a new empty workspace. Download any files you want to keep
        first; the previous sandbox continues towards its normal expiry.
      </p>
      <div className="dialog-actions">
        <button className="button button-outline" onClick={onCancel} disabled={busy}>
          Keep this workspace
        </button>
        <button className="button" onClick={onConfirm} disabled={busy}>
          {busy ? 'Creating…' : 'Start fresh'}
        </button>
      </div>
    </dialog>
  );
}

export function Footer({ workspace }: { workspace: WorkspaceSnapshot | null }) {
  return (
    <footer className="site-footer">
      <div>
        <strong>Dhruba Poudel</strong>
        <span>Original full-stack portfolio demonstration</span>
      </div>
      <div className="footer-links">
        <a href="https://github.com/dhrubasuz/exception-studio" target="_blank" rel="noreferrer">
          Read the implementation <span aria-hidden="true">↗</span>
        </a>
        <a href="https://about.dhrub.com.np/">
          Selected work <span aria-hidden="true">↗</span>
        </a>
      </div>
      <p>
        {workspace ? <>This sandbox expires {dateTime(workspace.session.expiresAt)}. </> : null}A
        restart or redeployment may reset this demonstration. Use fictional information only. No
        independently verified approval identity is established.
      </p>
    </footer>
  );
}
