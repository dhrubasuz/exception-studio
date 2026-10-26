// Author, creator and maintainer: Dhruba Poudel.
import { useEffect, useRef, useState } from 'react';
import type {
  DecisionCommand,
  FixtureId,
  RowView,
  WorkspaceSnapshot,
} from '../shared/contracts.js';
import {
  createSandbox,
  loadWorkspace,
  makeMutation,
  refreshWorkspace,
  RequestError,
  sendMutation,
} from './api';
import type { MutationRequest } from './api';
import {
  DecisionHistory,
  Footer,
  Masthead,
  Overview,
  Publications,
  ReviewQueue,
  RowInspector,
  SandboxDialog,
  UnderTheHood,
  Welcome,
  WorkspaceNavigation,
} from './components';
import { held } from './view';
import type { WorkspaceView } from './view';

interface Feedback {
  kind: 'error' | 'conflict' | 'unknown' | 'success';
  title: string;
  message: string;
  details?: string[];
}

export function App() {
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [booting, setBooting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [sessionNeedsReload, setSessionNeedsReload] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [pendingRetry, setPendingRetry] = useState<MutationRequest | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [view, setView] = useState<WorkspaceView>('review');
  const [newSandbox, setNewSandbox] = useState(false);
  const mounted = useRef(true);
  const mutationInFlight = useRef(false);
  const sequence = useRef(0);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    const requestSequence = ++sequence.current;
    void loadWorkspace(controller.signal)
      .then((next) => {
        if (!mounted.current || requestSequence !== sequence.current) return;
        setWorkspace(next);
        setSelectedId(next.rows.find(held)?.id ?? next.rows[0]?.id ?? null);
      })
      .catch((error: unknown) => {
        if (!mounted.current || controller.signal.aborted) return;
        setFeedback({
          kind: 'error',
          title: 'The workspace could not be opened.',
          message: error instanceof Error ? error.message : 'Please try again.',
        });
      })
      .finally(() => {
        if (mounted.current && requestSequence === sequence.current) setBooting(false);
      });
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, []);

  function applySnapshot(next: WorkspaceSnapshot, preserveSelection = true) {
    setWorkspace(next);
    setSelectedId((previous) =>
      preserveSelection && next.rows.some((row) => row.id === previous)
        ? previous
        : (next.rows.find(held)?.id ?? next.rows[0]?.id ?? null),
    );
    setEditorEpoch((previous) => previous + 1);
  }

  async function mutate(command: MutationRequest, targetView?: WorkspaceView) {
    if (mutationInFlight.current || sessionNeedsReload) return;
    mutationInFlight.current = true;
    setBusy(true);
    setFeedback(null);
    const requestSequence = ++sequence.current;
    try {
      const next = await sendMutation(command);
      if (!mounted.current || requestSequence !== sequence.current) return;
      applySnapshot(next, command.path !== '/api/imports');
      setPendingRetry(null);
      if (targetView) setView(targetView);
      setFeedback({
        kind: 'success',
        title: command.label,
        message:
          command.path === '/api/publications'
            ? `Revision ${next.revision} is available as a frozen CSV and manifest.`
            : `The server returned revision ${next.revision}. Source rows remain preserved.`,
      });
    } catch (error: unknown) {
      if (!mounted.current || requestSequence !== sequence.current) return;
      const failure =
        error instanceof RequestError
          ? error
          : new RequestError(
              error instanceof Error ? error.message : 'The request could not be completed.',
            );
      if (failure.outcomeUnknown) {
        setPendingRetry(command);
        setFeedback({
          kind: 'unknown',
          title: 'The result is not yet confirmed.',
          message: `${failure.message} Retry below to send the same request with its original key. Other changes are paused until the result is resolved.`,
        });
      } else {
        setPendingRetry(null);
        setFeedback({
          kind: failure.status === 409 ? 'conflict' : 'error',
          title:
            failure.status === 409
              ? 'The server rejected this request.'
              : 'The change was not saved.',
          message: failure.message,
          details: failure.detail?.issues?.map((issue) => issue.message),
        });
      }
    } finally {
      mutationInFlight.current = false;
      if (mounted.current && requestSequence === sequence.current) setBusy(false);
    }
  }

  async function refresh() {
    if (mutationInFlight.current || sessionNeedsReload || pendingRetry) return;
    setBusy(true);
    const requestSequence = ++sequence.current;
    try {
      const next = await refreshWorkspace();
      if (!mounted.current || requestSequence !== sequence.current) return;
      applySnapshot(next);
      setPendingRetry(null);
      setFeedback({
        kind: 'success',
        title: 'Current server revision loaded.',
        message: `You are reviewing revision ${next.revision}. The edit form now shows the saved server values.`,
      });
    } catch (error: unknown) {
      if (!mounted.current || requestSequence !== sequence.current) return;
      setFeedback({
        kind: 'error',
        title: 'The current revision could not be loaded.',
        message: error instanceof Error ? error.message : 'Please try again.',
      });
    } finally {
      if (mounted.current && requestSequence === sequence.current) setBusy(false);
    }
  }

  async function recoverBoot() {
    if (busy) return;
    setBusy(true);
    const requestSequence = ++sequence.current;
    try {
      const next = await loadWorkspace();
      if (!mounted.current || requestSequence !== sequence.current) return;
      applySnapshot(next, false);
      setFeedback(null);
    } catch (error: unknown) {
      if (!mounted.current || requestSequence !== sequence.current) return;
      setFeedback({
        kind: 'error',
        title: 'The workspace could not be opened.',
        message: error instanceof Error ? error.message : 'Please try again.',
      });
    } finally {
      if (mounted.current && requestSequence === sequence.current) setBusy(false);
    }
  }

  async function recoverSession() {
    if (mutationInFlight.current) return;
    mutationInFlight.current = true;
    setBusy(true);
    const requestSequence = ++sequence.current;
    try {
      const next = await loadWorkspace();
      if (!mounted.current || requestSequence !== sequence.current) return;
      applySnapshot(next, false);
      setView('review');
      setPendingRetry(null);
      setSessionNeedsReload(false);
      setFeedback({
        kind: 'success',
        title: 'The current session is confirmed.',
        message:
          'The workspace now matches this browser’s session. You can continue with the records shown below.',
      });
    } catch (error: unknown) {
      if (!mounted.current || requestSequence !== sequence.current) return;
      setFeedback({
        kind: 'unknown',
        title: 'The current session is still unconfirmed.',
        message: `${error instanceof Error ? error.message : 'Please try again.'} The displayed workspace is stale. All changes remain paused until Reload session succeeds.`,
      });
    } finally {
      mutationInFlight.current = false;
      if (mounted.current && requestSequence === sequence.current) setBusy(false);
    }
  }

  function importFixture(fixtureId: FixtureId) {
    if (!workspace || pendingRetry || busy || sessionNeedsReload) return;
    void mutate(
      makeMutation(
        '/api/imports',
        'POST',
        { fixtureId },
        fixtureId === 'mixed'
          ? 'The fictional import is ready for review.'
          : 'The clean fictional fixture is loaded.',
      ),
      'review',
    );
  }

  async function decide(row: RowView, command: DecisionCommand) {
    if (pendingRetry || busy || sessionNeedsReload) return;
    await mutate(
      makeMutation(
        `/api/rows/${encodeURIComponent(row.id)}/decision`,
        'PATCH',
        command,
        command.action === 'accept'
          ? 'The row decision is saved.'
          : 'The row is excluded with its reason.',
      ),
    );
  }

  function publish() {
    if (
      !workspace ||
      workspace.summary.held > 0 ||
      workspace.summary.total === 0 ||
      pendingRetry ||
      sessionNeedsReload ||
      busy
    )
      return;
    void mutate(
      makeMutation(
        '/api/publications',
        'POST',
        { expectedRevision: workspace.revision },
        'This revision is published.',
      ),
      'publications',
    );
  }

  function demonstrateConflict() {
    if (
      !workspace ||
      workspace.revision < 1 ||
      !workspace.rows[0] ||
      busy ||
      sessionNeedsReload ||
      pendingRetry
    )
      return;
    void mutate(
      makeMutation(
        `/api/rows/${encodeURIComponent(workspace.rows[0].id)}/decision`,
        'PATCH',
        {
          expectedRevision: workspace.revision - 1,
          action: 'exclude',
          reason:
            'Deliberate stale-request demonstration; the revision check should reject this command.',
        },
        'Stale request unexpectedly completed.',
      ),
    );
  }

  async function startFresh() {
    if (mutationInFlight.current || sessionNeedsReload || pendingRetry) return;
    mutationInFlight.current = true;
    setBusy(true);
    const requestSequence = ++sequence.current;
    try {
      const next = await createSandbox();
      if (!mounted.current || requestSequence !== sequence.current) return;
      applySnapshot(next, false);
      setView('review');
      setPendingRetry(null);
      setSessionNeedsReload(false);
      setFeedback(null);
      setNewSandbox(false);
    } catch (error: unknown) {
      if (!mounted.current || requestSequence !== sequence.current) return;
      setNewSandbox(false);
      setSessionNeedsReload(true);
      setFeedback({
        kind: 'unknown',
        title: 'A fresh sandbox was not confirmed.',
        message: `${error instanceof Error ? error.message : 'Please try again.'} The browser may have switched sessions. The displayed workspace is stale and all changes are paused. Use Reload session before continuing.`,
      });
    } finally {
      mutationInFlight.current = false;
      if (mounted.current && requestSequence === sequence.current) setBusy(false);
    }
  }

  const selectedRow = workspace?.rows.find((row) => row.id === selectedId) ?? null;
  const nextHeld = workspace?.rows.find((row) => held(row) && row.id !== selectedId);
  const blocked = busy || pendingRetry !== null || sessionNeedsReload;

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to workspace
      </a>
      <Masthead workspace={workspace} busy={blocked} onNew={() => setNewSandbox(true)} />
      <main id="main" tabIndex={-1}>
        {booting ? (
          <section className="loading-screen" role="status">
            <span className="loading-indicator" aria-hidden="true" />
            <h1>Opening your fictional workspace…</h1>
            <p>Connecting to the real application API.</p>
          </section>
        ) : null}
        {!booting && feedback ? (
          <section
            className={`feedback feedback-${feedback.kind}`}
            role={feedback.kind === 'success' ? 'status' : 'alert'}
            aria-live={feedback.kind === 'success' ? 'polite' : 'assertive'}
          >
            <div>
              <span className="feedback-symbol" aria-hidden="true">
                {feedback.kind === 'success' ? '✓' : '!'}
              </span>
              <div>
                <strong>{feedback.title}</strong>
                <p>{feedback.message}</p>
                {feedback.details?.length ? (
                  <ul>
                    {feedback.details.map((detail, index) => (
                      <li key={`${detail}-${index}`}>{detail}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </div>
            <div className="feedback-actions">
              {sessionNeedsReload ? (
                <>
                  <button
                    className="button compact"
                    disabled={busy}
                    onClick={() => void recoverSession()}
                  >
                    {busy ? 'Reloading session…' : 'Reload session'}
                  </button>
                  <small>Reloads the workspace for this browser’s session.</small>
                </>
              ) : pendingRetry ? (
                <>
                  <button
                    className="button compact"
                    disabled={busy}
                    onClick={() =>
                      void mutate(
                        pendingRetry,
                        pendingRetry.path === '/api/publications' ? 'publications' : undefined,
                      )
                    }
                  >
                    Retry the same request
                  </button>
                  <small>Retry keeps the original command and request key.</small>
                </>
              ) : feedback.kind === 'conflict' ? (
                <>
                  <button className="button compact" disabled={busy} onClick={() => void refresh()}>
                    Reload current revision
                  </button>
                  <small>This replaces unsaved form changes with server values.</small>
                </>
              ) : workspace ? (
                <button className="text-button" disabled={busy} onClick={() => setFeedback(null)}>
                  Dismiss
                </button>
              ) : (
                <button
                  className="button compact"
                  disabled={busy}
                  onClick={() => void recoverBoot()}
                >
                  Reconnect to the workspace
                </button>
              )}
            </div>
          </section>
        ) : null}
        {!booting && workspace && !workspace.activeImport ? (
          <Welcome busy={blocked} onImport={() => importFixture('mixed')} />
        ) : null}
        {!booting && workspace?.activeImport ? (
          <div className="workspace">
            <Overview workspace={workspace} busy={blocked} onPublish={publish} />
            <div className="workspace-body">
              <WorkspaceNavigation view={view} onView={setView} workspace={workspace} />
              <div className="workspace-context">
                <span>
                  <span className="context-dot" />{' '}
                  {sessionNeedsReload
                    ? 'Session unconfirmed · displayed records are stale'
                    : 'Source preserved · decisions stored on the server'}
                </span>
                <button
                  className="text-button"
                  disabled={blocked}
                  onClick={() => void refresh()}
                  title="Reloads the form from server values, replacing unsaved edits."
                >
                  Refresh saved revision <span aria-hidden="true">↻</span>
                </button>
              </div>
              {view === 'review' ? (
                <div className="review-layout">
                  <ReviewQueue
                    rows={workspace.rows}
                    selectedId={selectedId}
                    disabled={blocked}
                    onSelect={(id) => {
                      if (!blocked) {
                        setSelectedId(id);
                        setEditorEpoch((previous) => previous + 1);
                        setFeedback(null);
                      }
                    }}
                  />
                  <RowInspector
                    key={`${selectedId}-${editorEpoch}`}
                    row={selectedRow}
                    revision={workspace.revision}
                    disabled={blocked}
                    onDecision={decide}
                    onNext={
                      nextHeld
                        ? () => {
                            setSelectedId(nextHeld.id);
                            setEditorEpoch((previous) => previous + 1);
                            setFeedback(null);
                          }
                        : null
                    }
                  />
                </div>
              ) : view === 'history' ? (
                <DecisionHistory events={workspace.events} />
              ) : (
                <Publications
                  workspace={workspace}
                  busy={blocked}
                  onPublish={publish}
                  onReview={() => setView('review')}
                />
              )}
            </div>
          </div>
        ) : null}
        {!booting && workspace ? (
          <UnderTheHood
            workspace={workspace}
            busy={blocked}
            onConflictDemo={demonstrateConflict}
            onCleanImport={() => importFixture('clean')}
          />
        ) : null}
      </main>
      <Footer workspace={workspace} />
      {newSandbox ? (
        <SandboxDialog
          busy={busy}
          onCancel={() => setNewSandbox(false)}
          onConfirm={() => void startFresh()}
        />
      ) : null}
    </>
  );
}
