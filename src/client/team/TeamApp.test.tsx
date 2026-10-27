// Author, creator and maintainer: Dhruba Poudel.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DemoAccess, TeamJob, TeamSnapshot } from '../../shared/team-contracts.js';
import TeamApp from './TeamApp';

const ACCESS: DemoAccess = {
  workspaceId: 'workspace-demo-123',
  expiresAt: '2026-10-30T00:00:00.000Z',
  credentials: [
    {
      username: 'analyst-123',
      password: 'fictional-secret-a',
      displayName: 'Alex Morgan',
      role: 'analyst',
    },
    {
      username: 'approver-123',
      password: 'fictional-secret-b',
      displayName: 'Jordan Lee',
      role: 'approver',
    },
  ],
};

function job(overrides: Partial<TeamJob> = {}): TeamJob {
  return {
    id: 'job-a',
    eventId: 'event-a',
    scenario: 'healthy',
    status: 'awaiting_review',
    revision: 3,
    createdAt: '2026-10-28T01:00:00.000Z',
    updatedAt: '2026-10-28T01:01:00.000Z',
    nextAttemptAt: null,
    sourceAttempts: 1,
    deliveryAttempts: 0,
    generation: 1,
    sourceRecovered: false,
    sourceRaw: { reference: 'WO-101', team: 'Site operations', minutes: 45 },
    sourceSha256: 'a'.repeat(64),
    payload: { reference: 'WO-101', team: 'Site operations', minutes: 45 },
    submittedBy: null,
    submittedByName: null,
    approvedBy: null,
    approvedByName: null,
    reviewReason: null,
    approvalReason: null,
    error: null,
    traceId: 'trace-demo-123',
    attempts: [
      {
        id: 1,
        phase: 'source',
        attempt: 1,
        generation: 1,
        startedAt: '2026-10-28T01:00:01.000Z',
        durationMs: 32,
        outcome: 'success',
        httpStatus: 200,
        message: 'Source work order received.',
        traceId: 'trace-demo-123',
        spanId: 'span-1',
      },
    ],
    receipt: null,
    ...overrides,
  };
}

function workspace(jobs: TeamJob[] = [], overrides: Partial<TeamSnapshot> = {}): TeamSnapshot {
  return {
    workspace: {
      id: ACCESS.workspaceId,
      name: 'Demo workspace',
      createdAt: '2026-10-28T01:00:00.000Z',
      expiresAt: ACCESS.expiresAt,
    },
    actor: {
      id: 'actor-a',
      username: ACCESS.credentials[0]!.username,
      displayName: 'Alex Morgan',
      role: 'analyst',
    },
    jobs,
    events: [],
    metrics: {
      total: jobs.length,
      awaitingReview: jobs.filter((item) =>
        ['awaiting_review', 'schema_error'].includes(item.status),
      ).length,
      awaitingApproval: jobs.filter((item) => item.status === 'awaiting_approval').length,
      inFlight: jobs.filter((item) => item.status === 'queued_source').length,
      delivered: 0,
      deadLetter: 0,
      duplicateEvents: 0,
      destinationWrites: 0,
      attempts: jobs.length,
      retries: 0,
      p95AttemptMs: null,
    },
    limits: { lifetimeHours: 24, maxJobs: 40, maxAttempts: 3 },
    ...overrides,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Team edition account boundary', () => {
  it('does not create a workspace automatically after a missing session', async () => {
    fetchMock.mockResolvedValue(json({ error: { message: 'Sign in.' } }, 401));
    render(<TeamApp />);
    expect(await screen.findByRole('button', { name: /Start a private demo/ })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/team/workspace');
    expect(screen.queryByText(/Every handoff, accounted for/)).toBeNull();
  });

  it('shows an error without fake workspace data and can safely check the session again', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('Offline'))
      .mockResolvedValueOnce(json(workspace()));
    render(<TeamApp />);
    expect(await screen.findByText(/The workspace could not be loaded/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: /Start a private demo/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Check current session' }));
    expect(await screen.findByText('Every handoff, accounted for.')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('creates a private demo only on request, signs in using server credentials, and switches through login', async () => {
    const approver = workspace([], {
      actor: {
        id: 'actor-b',
        username: 'approver-123',
        displayName: 'Jordan Lee',
        role: 'approver',
      },
    });
    fetchMock
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json(ACCESS))
      .mockResolvedValueOnce(json(workspace()))
      .mockResolvedValueOnce(json(approver));
    render(<TeamApp />);
    fireEvent.click(await screen.findByRole('button', { name: /Start a private demo/ }));
    expect(await screen.findByText('Alex Morgan')).toBeTruthy();
    const login = fetchMock.mock.calls[2]!;
    expect(login[0]).toBe('/api/team/login');
    expect(JSON.parse(String(login[1]!.body))).toEqual({
      workspaceId: ACCESS.workspaceId,
      username: 'analyst-123',
      password: 'fictional-secret-a',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in as approver' }));
    expect(await screen.findByText('Jordan Lee')).toBeTruthy();
    expect(fetchMock.mock.calls[3]![0]).toBe('/api/team/login');
    expect(JSON.parse(String(fetchMock.mock.calls[3]![1]!.body)).username).toBe('approver-123');
    expect(screen.queryByRole('button', { name: /Run scenario/ })).toBeNull();
    expect(screen.getByText(/not verified organisational identities/)).toBeTruthy();
  });

  it('does not recover credentials from browser storage after a refresh', async () => {
    fetchMock.mockResolvedValue(json(workspace()));
    render(<TeamApp />);
    await screen.findByText('Alex Morgan');
    expect(screen.queryByRole('button', { name: 'Sign in as approver' })).toBeNull();
    expect(screen.getByText(/enter the access details saved/)).toBeTruthy();
    expect(screen.queryByText('fictional-secret-a')).toBeNull();
  });

  it('requires account-state verification after an uncertain sign out', async () => {
    fetchMock
      .mockResolvedValueOnce(json(workspace()))
      .mockRejectedValueOnce(new TypeError('Lost response'))
      .mockResolvedValueOnce(json({}, 401));
    render(<TeamApp />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('Check the signed-in account')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: /Run scenario/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Check current session' }));
    expect(await screen.findByRole('button', { name: /Start a private demo/ })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('Team edition commands and evidence', () => {
  it('reveals older server-recorded activity in accessible batches without hiding its total', async () => {
    const events = Array.from({ length: 25 }, (_, index) => ({
      id: 25 - index,
      type: 'job.reviewed',
      jobId: 'job-a',
      actorName: 'Alex Morgan',
      actorRole: 'analyst',
      message: 'Reviewed fictional work order decision ' + (25 - index),
      createdAt: new Date(Date.UTC(2026, 9, 28, 1, 25 - index)).toISOString(),
      traceId: 'trace-demo-123',
    }));
    fetchMock.mockResolvedValue(json(workspace([], { events })));
    render(<TeamApp />);
    fireEvent.click(await screen.findByRole('button', { name: 'Activity' }));
    expect(screen.getByText('Latest 12 of 25 events')).toBeTruthy();
    expect(screen.queryByText('Reviewed fictional work order decision 13')).toBeNull();
    const showMore = screen.getByRole('button', { name: 'Show more events' });
    expect(document.getElementById(showMore.getAttribute('aria-controls') || '')).toBeTruthy();
    fireEvent.click(showMore);
    expect(screen.getByText('Latest 24 of 25 events')).toBeTruthy();
    expect(screen.getByText('Reviewed fictional work order decision 13')).toBeTruthy();
    expect(screen.queryByText('Reviewed fictional work order decision 1')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show more events' }));
    expect(screen.getByText('Latest 25 of 25 events')).toBeTruthy();
    expect(screen.getByText('Reviewed fictional work order decision 1')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show more events' })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('discloses the server history cap when the latest 500 events are returned', async () => {
    const events = Array.from({ length: 500 }, (_, index) => ({
      id: 500 - index,
      type: 'job.reviewed',
      jobId: 'job-a',
      actorName: 'Alex Morgan',
      actorRole: 'analyst',
      message: 'Fictional review ' + (500 - index),
      createdAt: '2026-10-28T01:00:00.000Z',
      traceId: 'trace-demo-123',
    }));
    fetchMock.mockResolvedValue(json(workspace([], { events })));
    render(<TeamApp />);
    fireEvent.click(await screen.findByRole('button', { name: 'Activity' }));
    expect(screen.getByText('Latest 12 of 500 events')).toBeTruthy();
    expect(screen.getByText(/at most the latest 500 workspace events/)).toBeTruthy();
  });
  it('blocks malformed references and out-of-range effort before sending a review', async () => {
    fetchMock
      .mockResolvedValueOnce(json(workspace([job()])))
      .mockResolvedValueOnce(
        json(
          workspace([job({ status: 'awaiting_approval', revision: 4, submittedBy: 'actor-a' })]),
        ),
      );
    render(<TeamApp />);
    fireEvent.change(await screen.findByLabelText('Review reason'), {
      target: { value: 'Source record checked carefully.' },
    });
    fireEvent.change(screen.getByLabelText('Work order reference'), {
      target: { value: 'lowercase invalid' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Submit for approval/ }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText('Work order reference'), {
      target: { value: 'WO-101' },
    });
    fireEvent.change(screen.getByLabelText('Effort in minutes'), { target: { value: '10081' } });
    fireEvent.click(screen.getByRole('button', { name: /Submit for approval/ }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText('Effort in minutes'), { target: { value: '60' } });
    fireEvent.click(screen.getByRole('button', { name: /Submit for approval/ }));
    await screen.findByText(/Your review is saved/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body)).payload.minutes).toBe(60);
  });
  it('keeps an uncertain command and retries the exact same key and content', async () => {
    fetchMock
      .mockResolvedValueOnce(json(workspace()))
      .mockRejectedValueOnce(new TypeError('Response lost'))
      .mockResolvedValueOnce(json(workspace([job({ status: 'queued_source' })])));
    render(<TeamApp />);
    fireEvent.click(await screen.findByRole('button', { name: /Run scenario/ }));
    const retry = await screen.findByRole('button', { name: 'Retry original change' });
    expect(
      (screen.getByRole('button', { name: /Run scenario/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(retry);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Retry original change' })).toBeNull(),
    );
    const first = fetchMock.mock.calls[1]![1]!;
    const second = fetchMock.mock.calls[2]![1]!;
    expect(first.body).toBe(second.body);
    expect(first.headers).toEqual(second.headers);
    expect((first.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();
    expect(JSON.parse(String(first.body))).toEqual({ scenario: 'healthy' });
  });

  it('treats a server failure as uncertain rather than generating another change', async () => {
    fetchMock
      .mockResolvedValueOnce(json(workspace()))
      .mockResolvedValueOnce(json({ error: { message: 'Temporary failure.' } }, 503));
    render(<TeamApp />);
    fireEvent.click(await screen.findByRole('button', { name: /Run scenario/ }));
    expect(await screen.findByRole('button', { name: 'Retry original change' })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('submits an explicit review reason with the selected revision and corrected payload', async () => {
    const changed = job({
      status: 'schema_error',
      payload: null,
      error: 'team is missing; minutes must be a number.',
      sourceRaw: { reference: 'WO-101', squad: 'Fictional repairs', duration: '45m' },
    });
    fetchMock.mockResolvedValueOnce(json(workspace([changed]))).mockResolvedValueOnce(
      json(
        workspace([
          job({
            status: 'awaiting_approval',
            revision: 4,
            submittedBy: 'actor-a',
            submittedByName: 'Alex Morgan',
            reviewReason: 'Mapped the fictional team and duration fields.',
          }),
        ]),
      ),
    );
    render(<TeamApp />);
    expect(await screen.findByText('The source needs a correction')).toBeTruthy();
    const submit = screen.getByRole('button', { name: /Submit for approval/ });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Work order reference'), {
      target: { value: 'WO-101' },
    });
    fireEvent.change(screen.getByLabelText('Assigned team'), {
      target: { value: 'Fictional repairs' },
    });
    fireEvent.change(screen.getByLabelText('Effort in minutes'), { target: { value: '45' } });
    fireEvent.change(screen.getByLabelText('Review reason'), {
      target: { value: 'Mapped the fictional team and duration fields.' },
    });
    fireEvent.click(submit);
    await screen.findByText(/Your review is saved/);
    const request = fetchMock.mock.calls[1]!;
    expect(request[0]).toBe('/api/team/jobs/job-a/review');
    expect(JSON.parse(String(request[1]!.body))).toEqual({
      expectedRevision: 3,
      payload: { reference: 'WO-101', team: 'Fictional repairs', minutes: 45 },
      reason: 'Mapped the fictional team and duration fields.',
    });
  });

  it('prevents further changes after a stale revision until the current snapshot is loaded', async () => {
    fetchMock
      .mockResolvedValueOnce(json(workspace([job()])))
      .mockResolvedValueOnce(json({ error: { message: 'Revision conflict.' } }, 409))
      .mockResolvedValueOnce(
        json(
          workspace([
            job({
              revision: 4,
              payload: { reference: 'WO-101', team: 'Updated team', minutes: 60 },
            }),
          ]),
        ),
      );
    render(<TeamApp />);
    fireEvent.change(await screen.findByLabelText('Review reason'), {
      target: { value: 'Source details checked.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Submit for approval/ }));
    expect(await screen.findByText(/Changes are paused until a successful refresh/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: /Submit for approval/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    await waitFor(() =>
      expect((screen.getByLabelText('Assigned team') as HTMLInputElement).value).toBe(
        'Updated team',
      ),
    );
    expect(screen.queryByText(/Changes are paused until a successful refresh/)).toBeNull();
    expect((screen.getByLabelText('Review reason') as HTMLTextAreaElement).value).toBe('');
  });

  it('offers approval only to the approver and uses a reason and expected revision', async () => {
    const submitted = job({
      status: 'awaiting_approval',
      submittedBy: 'actor-a',
      submittedByName: 'Alex Morgan',
      reviewReason: 'Checked source against work order.',
    });
    const approver = {
      id: 'actor-b',
      username: 'approver-123',
      displayName: 'Jordan Lee',
      role: 'approver' as const,
    };
    fetchMock
      .mockResolvedValueOnce(json(workspace([submitted], { actor: approver })))
      .mockResolvedValueOnce(
        json(
          workspace(
            [
              job({
                ...submitted,
                status: 'queued_delivery',
                revision: 4,
                approvedBy: 'actor-b',
                approvedByName: 'Jordan Lee',
              }),
            ],
            { actor: approver },
          ),
        ),
      );
    render(<TeamApp />);
    await screen.findByLabelText('Approval reason');
    expect(screen.queryByRole('button', { name: /Run scenario/ })).toBeNull();
    expect(screen.queryByLabelText('Work order reference')).toBeNull();
    fireEvent.change(screen.getByLabelText('Approval reason'), {
      target: { value: 'Reviewed the analyst correction and source.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Approve delivery/ }));
    await screen.findByText(/worker is delivering/);
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body))).toEqual({
      expectedRevision: 3,
      reason: 'Reviewed the analyst correction and source.',
    });
  });

  it('retains dirty review fields when polling updates a different job', async () => {
    const waiting = job({
      id: 'job-b',
      eventId: 'event-b',
      status: 'queued_source',
      payload: null,
    });
    const initial = workspace([job(), waiting]);
    const updated = workspace([
      job(),
      {
        ...waiting,
        status: 'awaiting_review',
        revision: 4,
        payload: { reference: 'WO-102', team: 'Other team', minutes: 20 },
      },
    ]);
    fetchMock.mockResolvedValueOnce(json(initial)).mockResolvedValue(json(updated));
    render(<TeamApp />);
    fireEvent.change(await screen.findByLabelText('Review reason'), {
      target: { value: 'An unfinished careful review.' },
    });
    fireEvent.change(screen.getByLabelText('Assigned team'), { target: { value: 'Edited team' } });
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1), { timeout: 1800 });
    await waitFor(() => expect(screen.getByText('WO-102')).toBeTruthy());
    expect((screen.getByLabelText('Assigned team') as HTMLInputElement).value).toBe('Edited team');
    expect((screen.getByLabelText('Review reason') as HTMLTextAreaElement).value).toBe(
      'An unfinished careful review.',
    );
  });

  it('shows original source, all attempts, receipt hash and the scoped trace link', async () => {
    const delivered = job({
      status: 'delivered',
      approvedBy: 'actor-b',
      approvedByName: 'Jordan Lee',
      receipt: {
        id: 'receipt-123',
        eventId: 'event-a',
        reference: 'WO-101',
        payloadSha256: 'b'.repeat(64),
        createdAt: '2026-10-28T01:02:00.000Z',
      },
    });
    fetchMock.mockResolvedValue(json(workspace([delivered])));
    render(<TeamApp />);
    await screen.findByText('Delivery receipt');
    expect(screen.getByText('Jordan Lee')).toBeTruthy();
    expect(screen.getByText('b'.repeat(64))).toBeTruthy();
    expect(screen.getByText('Source work order received.')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Download job evidence/ }).getAttribute('href')).toBe(
      '/api/team/jobs/job-a/trace.json',
    );
    const evidence = screen.getByText('Source and trace evidence').parentElement!;
    expect(within(evidence).getByText('a'.repeat(64))).toBeTruthy();
    expect(within(evidence).getByText(/"reference": "WO-101"/)).toBeTruthy();
  });

  it('restores a failed source only with an explicit reason and retains the revision', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json(
          workspace([
            job({
              status: 'dead_letter',
              scenario: 'upstream_down',
              payload: null,
              sourceAttempts: 3,
              error: 'Source unavailable after three attempts.',
            }),
          ]),
        ),
      )
      .mockResolvedValueOnce(
        json(
          workspace([
            job({
              status: 'queued_source',
              scenario: 'upstream_down',
              payload: null,
              revision: 4,
              generation: 2,
            }),
          ]),
        ),
      );
    render(<TeamApp />);
    fireEvent.change(await screen.findByLabelText('Recovery reason'), {
      target: { value: 'Restored the fictional source for another run.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Restore sandbox and replay' }));
    await screen.findByText(/worker is receiving/);
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/team/jobs/job-a/replay');
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body))).toEqual({
      expectedRevision: 3,
      reason: 'Restored the fictional source for another run.',
      restoreConnector: true,
    });
  });
});
