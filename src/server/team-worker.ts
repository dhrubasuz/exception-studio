// Author, creator and maintainer: Dhruba Poudel.
import { performance } from 'node:perf_hooks';
import type { TeamStore, TeamAttemptResult } from './team-store.js';

export interface TeamWorkerOptions {
  store: TeamStore;
  baseUrl: string;
  secret: string;
  timeoutMs?: number;
  intervalMs?: number;
}

/** Durable claims stay in SQLite; a stopped/restarted worker recovers expired leases.
 * HTTP calls happen outside database transactions. The sandbox destination deduplicates
 * the stable source event, including when its response is lost after committing a receipt.
 */
export function createTeamWorker(options: TeamWorkerOptions) {
  const origin = new URL(options.baseUrl);
  if (!['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname))
    throw new Error('The educational connector worker must use a loopback sandbox.');
  let active: Promise<boolean> | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopping = false;

  const processOne = async (): Promise<boolean> => {
    if (stopping) return false;
    const job = options.store.claimNext();
    if (!job) return false;
    const started = performance.now();
    let result: TeamAttemptResult;
    try {
      const url = new URL(
        `/api/team/sandbox/${job.id}/${job.phase === 'source' ? 'source' : 'destination'}`,
        origin,
      );
      const response = await fetch(url, {
        method: job.phase === 'source' ? 'GET' : 'POST',
        headers: {
          'X-Team-Sandbox-Secret': options.secret,
          ...(job.phase === 'delivery' ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(job.phase === 'delivery'
          ? { body: JSON.stringify({ eventId: job.eventId, payload: job.payload }) }
          : {}),
        signal: AbortSignal.timeout(options.timeoutMs ?? 500),
        redirect: 'error',
      });
      const data: unknown = await response.json();
      const retryAfter = response.headers.get('retry-after');
      result = {
        outcome: response.ok
          ? 'success'
          : response.status === 429
            ? 'rate_limit'
            : 'upstream_error',
        httpStatus: response.status,
        durationMs: Math.round(performance.now() - started),
        message: response.ok
          ? job.phase === 'source'
            ? 'The source response arrived for validation.'
            : 'The destination confirmed its durable receipt.'
          : `The sandbox returned HTTP ${response.status}.`,
        data,
        ...(response.status === 429 && retryAfter && /^\d+$/.test(retryAfter)
          ? { retryAfterMs: Math.min(30_000, Number(retryAfter) * 1000) }
          : {}),
      };
    } catch (error) {
      const timedOut =
        error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name);
      result = {
        outcome: timedOut ? 'timeout' : 'upstream_error',
        httpStatus: null,
        durationMs: Math.round(performance.now() - started),
        message: timedOut
          ? 'The response deadline elapsed; the remote outcome may be unknown. The stable event ID is retained for a safe retry.'
          : 'The HTTP sandbox could not be reached. The durable job remains available for recovery.',
      };
    }
    options.store.completeAttempt(job.id, job.leaseToken, result);
    return true;
  };

  const runOnce = (): Promise<boolean> => {
    if (active) return active;
    active = processOne().finally(() => {
      active = null;
    });
    return active;
  };
  return {
    runOnce,
    start() {
      if (timer || stopping) return;
      timer = setInterval(() => {
        void runOnce().catch(() =>
          console.error('Team worker could not complete a claim; its lease will recover.'),
        );
      }, options.intervalMs ?? 350);
      timer.unref();
    },
    async stop() {
      stopping = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      await active;
    },
  };
}
