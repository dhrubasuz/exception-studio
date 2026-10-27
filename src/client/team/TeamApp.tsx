// Author, creator and maintainer: Dhruba Poudel.
import { useEffect, useRef, useState } from 'react';
import type {
  ConnectorPayload,
  ConnectorScenario,
  DemoAccess,
  DemoCredential,
  TeamJob,
  TeamSnapshot,
} from '../../shared/team-contracts.js';
import {
  createTeamDemo,
  executeTeamMutation,
  getTeamWorkspace,
  loginTeam,
  logoutTeam,
  TeamRequestError,
  teamMutation,
  type TeamMutation,
} from './api';
import {
  AccountPanel,
  AuditPanel,
  EntryScreen,
  JobInspector,
  JobQueue,
  MetricStrip,
  TeamBrand,
  TeamFooter,
} from './components';
import { displayTime, isInFlight, shortId } from './view';
import './team.css';

type Feedback = { tone: 'success' | 'error' | 'info'; message: string };
type Page = 'operations' | 'activity' | 'guide';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The request could not be completed.';
}

export default function TeamApp() {
  const [snapshot, setSnapshot] = useState<TeamSnapshot | null>(null);
  const [access, setAccess] = useState<DemoAccess | null>(null);
  const [booting, setBooting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [pending, setPending] = useState<TeamMutation | null>(null);
  const [identityUncertain, setIdentityUncertain] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [page, setPage] = useState<Page>('operations');
  const [syncTime, setSyncTime] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const epoch = useRef(0);

  function applySnapshot(next: TeamSnapshot) {
    setSnapshot(next);
    setSyncTime(new Date().toISOString());
    setStale(false);
    setSelectedId((current) =>
      current && next.jobs.some((job) => job.id === current) ? current : next.jobs[0]?.id || null,
    );
  }

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void getTeamWorkspace(controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        applySnapshot(next);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (!(error instanceof TeamRequestError && error.status === 401)) {
          setFeedback({
            tone: 'error',
            message: 'The workspace could not be loaded. ' + errorMessage(error),
          });
          setIdentityUncertain(true);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setBooting(false);
      });
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, []);

  const inFlight = snapshot?.jobs.some(isInFlight) ?? false;
  const actorId = snapshot?.actor.id;
  useEffect(() => {
    if (!inFlight || busy || pending || identityUncertain || !actorId) return;
    let cancelled = false;
    let fetching = false;
    const controller = new AbortController();
    const activeEpoch = epoch.current;
    const timer = window.setInterval(() => {
      if (fetching || busyRef.current) return;
      fetching = true;
      void getTeamWorkspace(controller.signal)
        .then((next) => {
          if (cancelled || activeEpoch !== epoch.current || busyRef.current) return;
          if (next.actor.id !== actorId) {
            setIdentityUncertain(true);
            setStale(true);
            setFeedback({
              tone: 'error',
              message:
                'The signed-in account changed in another tab. Check the current session before continuing.',
            });
            return;
          }
          applySnapshot(next);
        })
        .catch((error: unknown) => {
          if (cancelled || activeEpoch !== epoch.current) return;
          setStale(true);
          if (error instanceof TeamRequestError && error.status === 401) {
            setIdentityUncertain(true);
            setFeedback({
              tone: 'error',
              message: 'This session has ended. Check the current session to sign in again.',
            });
          } else {
            setFeedback({
              tone: 'error',
              message:
                'Live updates are unavailable. The displayed data may be out of date. Use Refresh to check again.',
            });
          }
        })
        .finally(() => {
          fetching = false;
        });
    }, 1000);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [inFlight, busy, pending, identityUncertain, actorId]);

  function begin(): boolean {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    epoch.current += 1;
    return true;
  }

  function finish() {
    busyRef.current = false;
    if (mounted.current) setBusy(false);
  }

  async function refresh() {
    if (!begin()) return;
    try {
      const next = await getTeamWorkspace();
      if (!mounted.current) return;
      applySnapshot(next);
      setIdentityUncertain(false);
      setAccess((current) => (current?.workspaceId === next.workspace.id ? current : null));
      setFeedback({
        tone: 'info',
        message: pending
          ? 'Current state loaded. The unconfirmed change still needs its original retry.'
          : 'Current server state loaded.',
      });
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof TeamRequestError && error.status === 401) {
        setSnapshot(null);
        setPending(null);
        setIdentityUncertain(false);
        setStale(false);
        setFeedback({
          tone: 'info',
          message:
            'No account is signed in. Use your saved demo access or explicitly start a new workspace.',
        });
      } else {
        setStale(true);
        setFeedback({
          tone: 'error',
          message: 'The current session could not be confirmed. ' + errorMessage(error),
        });
      }
    } finally {
      finish();
    }
  }

  async function signIn(workspaceId: string, username: string, password: string) {
    if (pending || identityUncertain || !begin()) return;
    try {
      const next = await loginTeam({ workspaceId, username, password });
      if (!mounted.current) return;
      applySnapshot(next);
      setAccess((current) => (current?.workspaceId === next.workspace.id ? current : null));
      setFeedback({
        tone: 'success',
        message: 'Signed in as ' + next.actor.displayName + ' (' + next.actor.role + ').',
      });
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof TeamRequestError && error.uncertain) setIdentityUncertain(true);
      setFeedback({ tone: 'error', message: errorMessage(error) });
    } finally {
      finish();
    }
  }

  async function createDemo() {
    if (pending || identityUncertain || !begin()) return;
    try {
      const kit = await createTeamDemo();
      if (!mounted.current) return;
      setAccess(kit);
      const analyst = kit.credentials.find((credential) => credential.role === 'analyst');
      if (!analyst) throw new Error('Demo access was returned without an analyst account.');
      const next = await loginTeam({
        workspaceId: kit.workspaceId,
        username: analyst.username,
        password: analyst.password,
      });
      if (!mounted.current) return;
      applySnapshot(next);
      setPage('operations');
      setFeedback({
        tone: 'success',
        message:
          'Your isolated workspace is ready. Start with a healthy handoff, then try a failure scenario.',
      });
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof TeamRequestError && error.uncertain) setIdentityUncertain(true);
      setFeedback({ tone: 'error', message: errorMessage(error) });
    } finally {
      finish();
    }
  }

  async function signOut() {
    if (pending || identityUncertain || !begin()) return;
    try {
      await logoutTeam();
      if (!mounted.current) return;
      setSnapshot(null);
      setSelectedId(null);
      setFeedback({
        tone: 'info',
        message:
          'Signed out. Your workspace remains available until its expiry using the saved demo account access.',
      });
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof TeamRequestError && error.uncertain) setIdentityUncertain(true);
      setFeedback({ tone: 'error', message: errorMessage(error) });
    } finally {
      finish();
    }
  }

  async function run(command: TeamMutation, retry = false) {
    if (identityUncertain || (pending && !retry) || !begin()) return;
    const beforeIds = new Set(snapshot?.jobs.map((job) => job.id));
    try {
      const next = await executeTeamMutation(command);
      if (!mounted.current) return;
      applySnapshot(next);
      const added = next.jobs.find((job) => !beforeIds.has(job.id));
      if (added) setSelectedId(added.id);
      setPending(null);
      setFeedback({ tone: 'success', message: command.label + ' confirmed by the server.' });
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof TeamRequestError && error.uncertain) {
        setPending(command);
        setStale(true);
        setFeedback({
          tone: 'error',
          message:
            'The result is unconfirmed. Retry the original change below; its original key and content will be reused.',
        });
      } else if (error instanceof TeamRequestError && error.status === 409) {
        setPending(null);
        setStale(true);
        setFeedback({
          tone: 'error',
          message:
            'This job changed before the request completed. Refresh, review its current state and try again. ' +
            errorMessage(error),
        });
      } else if (error instanceof TeamRequestError && error.status === 401) {
        setIdentityUncertain(true);
        setFeedback({
          tone: 'error',
          message: 'Your account session has ended. Check the current session before continuing.',
        });
      } else {
        setPending(null);
        setFeedback({ tone: 'error', message: errorMessage(error) });
      }
    } finally {
      finish();
    }
  }

  function enqueue(scenario: ConnectorScenario) {
    void run(teamMutation('/api/team/jobs', { scenario }, 'Source event'));
  }
  function review(job: TeamJob, payload: ConnectorPayload, reason: string) {
    void run(
      teamMutation(
        '/api/team/jobs/' + encodeURIComponent(job.id) + '/review',
        { expectedRevision: job.revision, payload, reason },
        'Review',
      ),
    );
  }
  function approve(job: TeamJob, reason: string) {
    void run(
      teamMutation(
        '/api/team/jobs/' + encodeURIComponent(job.id) + '/approve',
        { expectedRevision: job.revision, reason },
        'Approval',
      ),
    );
  }
  function replay(job: TeamJob, reason: string) {
    void run(
      teamMutation(
        '/api/team/jobs/' + encodeURIComponent(job.id) + '/replay',
        { expectedRevision: job.revision, reason, restoreConnector: true },
        'Recovery replay',
      ),
    );
  }
  function switchAccount(credential: DemoCredential) {
    if (access) void signIn(access.workspaceId, credential.username, credential.password);
  }

  const locked = busy || pending !== null || identityUncertain || stale;
  const selected = snapshot?.jobs.find((job) => job.id === selectedId) || null;
  const expiresAt = snapshot ? new Date(snapshot.workspace.expiresAt) : null;
  const expiry =
    expiresAt && !Number.isNaN(expiresAt.valueOf())
      ? expiresAt.toLocaleString([], {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      : 'Unavailable';

  const remainingMinutes = expiresAt
    ? Math.max(0, Math.ceil((expiresAt.valueOf() - Date.now()) / 60000))
    : 0;
  const remainingLifetime =
    remainingMinutes > 60
      ? Math.ceil(remainingMinutes / 60) + 'h remaining'
      : remainingMinutes > 0
        ? remainingMinutes + 'm remaining'
        : 'expired';
  return (
    <div className="team-app">
      <a className="team-skip-link" href="#team-main">
        Skip to main content
      </a>
      <div className="team-feedback-region" role="status" aria-live="polite" aria-atomic="true">
        {feedback ? (
          <div className={'team-feedback ' + feedback.tone}>
            <span>{feedback.message}</span>
            <button aria-label="Dismiss notification" onClick={() => setFeedback(null)}>
              ×
            </button>
          </div>
        ) : null}
      </div>
      {booting ? (
        <main className="team-loading" id="team-main">
          <TeamBrand />
          <div className="team-loading-symbol" aria-hidden="true" />
          <h1>Checking your workspace</h1>
          <p>Connecting to the server. No demo is created automatically.</p>
        </main>
      ) : !snapshot ? (
        <EntryScreen
          busy={busy}
          access={access}
          onCreate={() => void createDemo()}
          onLogin={(workspaceId, username, password) =>
            void signIn(workspaceId, username, password)
          }
          onRecover={() => void refresh()}
          uncertain={identityUncertain}
        />
      ) : (
        <>
          <header className="team-topbar">
            <TeamBrand />
            <nav className="team-primary-nav" aria-label="Workspace sections">
              {(
                [
                  ['operations', 'Operations'],
                  ['activity', 'Activity'],
                  ['guide', 'How it works'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  aria-current={page === id ? 'page' : undefined}
                  onClick={() => setPage(id)}
                >
                  {label}
                </button>
              ))}
            </nav>
            <a className="team-source-link" href="https://github.com/dhrubasuz/exception-studio">
              View source <span aria-hidden="true">↗</span>
            </a>
          </header>
          <div className="team-demo-banner">
            <span className="team-demo-pill">FICTIONAL DEMO</span>
            <span>
              Two accounts, one isolated workspace. You can try both roles; this does not verify
              independent people.
            </span>
            <span className="team-expiry">
              Expires {expiry} · {remainingLifetime}
            </span>
          </div>
          <main className="team-workspace" id="team-main">
            <div className="team-workspace-heading">
              <div>
                <p className="team-eyebrow">WORKSPACE / {shortId(snapshot.workspace.id)}</p>
                <h1>
                  {page === 'operations'
                    ? 'Every handoff, accounted for.'
                    : page === 'activity'
                      ? 'A record of every decision.'
                      : 'Built for the difficult handoff.'}
                </h1>
                <p>
                  {page === 'operations'
                    ? 'Bring the work in. Check it. Get approval. Confirm delivery.'
                    : page === 'activity'
                      ? 'Inspect the actors, attempts and reasons behind the outcome.'
                      : 'A small, inspectable system for safe retries and human review.'}
                </p>
              </div>
              <div className="team-sync">
                <span className={inFlight ? 'active' : ''}>
                  {stale
                    ? 'Data may be out of date'
                    : inFlight
                      ? 'Live updates while jobs run'
                      : 'Server state loaded'}
                </span>
                <small>{syncTime ? 'Checked ' + displayTime(syncTime) : 'Not yet checked'}</small>
                <button
                  className="team-button secondary compact"
                  disabled={busy}
                  onClick={() => void refresh()}
                >
                  ↻ Refresh
                </button>
              </div>
            </div>
            {pending ? (
              <section className="team-recovery-banner" role="alert">
                <div>
                  <strong>One change needs confirmation</strong>
                  <p>
                    Other changes are paused. Retrying uses the same request and key, so a confirmed
                    server result can be returned safely.
                  </p>
                </div>
                <button
                  className="team-button primary"
                  disabled={busy || identityUncertain}
                  onClick={() => void run(pending, true)}
                >
                  {busy ? 'Confirming…' : 'Retry original change'}
                </button>
              </section>
            ) : null}
            {identityUncertain ? (
              <section className="team-recovery-banner" role="alert">
                <div>
                  <strong>Check the signed-in account</strong>
                  <p>
                    The account state is uncertain. Confirm the current server session before
                    continuing.
                  </p>
                </div>
                <button
                  className="team-button primary"
                  disabled={busy}
                  onClick={() => void refresh()}
                >
                  Check current session
                </button>
              </section>
            ) : null}
            {stale && !pending && !identityUncertain ? (
              <div className="team-stale-banner" role="alert">
                The view may be out of date. Changes are paused until a successful refresh.
              </div>
            ) : null}
            <AccountPanel
              snapshot={snapshot}
              access={access}
              busy={locked}
              onSwitch={switchAccount}
              onLogout={() => void signOut()}
            />
            {page === 'operations' ? (
              <>
                <MetricStrip snapshot={snapshot} />
                <div className="team-operations-grid">
                  <JobQueue
                    snapshot={snapshot}
                    selectedId={selectedId}
                    busy={locked}
                    onSelect={setSelectedId}
                    onEnqueue={enqueue}
                  />
                  <JobInspector
                    job={selected}
                    snapshot={snapshot}
                    busy={locked}
                    onReview={review}
                    onApprove={approve}
                    onReplay={replay}
                  />
                </div>
                <div className="team-bottom-metrics">
                  <span>
                    <b>{snapshot.metrics.duplicateEvents}</b> repeated events recognised
                  </span>
                  <span>
                    <b>{snapshot.metrics.retries}</b> retry attempts recorded
                  </span>
                  <span>
                    <b>{snapshot.metrics.attempts}</b> connector attempts
                  </span>
                  <span>
                    <b>
                      {snapshot.metrics.p95AttemptMs === null
                        ? '—'
                        : snapshot.metrics.p95AttemptMs + ' ms'}
                    </b>{' '}
                    p95 attempt duration
                  </span>
                </div>
              </>
            ) : page === 'activity' ? (
              <AuditPanel snapshot={snapshot} />
            ) : (
              <SystemGuide />
            )}
            <TeamFooter />
          </main>
        </>
      )}
    </div>
  );
}

function SystemGuide() {
  return (
    <section className="team-guide">
      <div className="team-guide-intro">
        <span className="team-tag">THE SYSTEM, EXPLAINED</span>
        <h2>A retry should not become a duplicate.</h2>
        <p>
          Exception Studio connects a fictional source and destination over authenticated local
          HTTP. Source failures, schema changes and uncertain delivery responses are deliberate
          sandbox scenarios.
        </p>
      </div>
      <div className="team-guide-grid">
        <article>
          <span>01 / RECEIVE</span>
          <h3>Preserve what arrived</h3>
          <p>
            The worker keeps the original source response and its SHA-256 hash. A changed schema
            goes to correction instead of being silently accepted.
          </p>
        </article>
        <article>
          <span>02 / REVIEW</span>
          <h3>Make the decision visible</h3>
          <p>
            An analyst checks the work order and records a reason. The review contains the exact job
            revision, so an old page cannot quietly replace a newer decision.
          </p>
        </article>
        <article>
          <span>03 / APPROVE</span>
          <h3>Separate the permission</h3>
          <p>
            A second server-authenticated account authorises delivery. In this demonstration both
            credentials belong to your session; it is a role-boundary demonstration, not enterprise
            identity verification.
          </p>
        </article>
        <article>
          <span>04 / DELIVER</span>
          <h3>Keep a durable receipt</h3>
          <p>
            The destination recognises the event ID and returns the original receipt after a lost
            response. Inspect the payload hash, write count and attempt history to verify the
            result.
          </p>
        </article>
      </div>
      <div className="team-guide-boundaries">
        <h3>Deliberately bounded</h3>
        <p>
          A workspace expires after 24 hours, accepts up to 40 jobs, and permits 3 attempts per
          phase. It cannot call arbitrary URLs. Use fictional data only. The demo does not connect
          to real business systems.
        </p>
        <details>
          <summary>Implementation details</summary>
          <p>
            React and TypeScript client. Node.js HTTP API and SQLite storage. Account sessions use
            HttpOnly cookies; command keys support safe retry, optimistic revisions reject stale
            decisions, and a persistent worker performs connector requests. JSON trace downloads
            include the original payload, all attempts and the server-recorded audit events for a
            job.
          </p>
        </details>
      </div>
    </section>
  );
}
