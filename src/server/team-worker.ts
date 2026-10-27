// Author, creator and maintainer: Dhruba Poudel.
import { performance } from 'node:perf_hooks';
import { request as requestHttp, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as requestHttps } from 'node:https';
import type { TeamStore, TeamAttemptResult } from './team-store.js';

export interface TeamWorkerOptions {
  store: TeamStore;
  baseUrl: string;
  /** Trusted deployment configuration for this app's own HTTPS origin, never browser input. */
  publicOrigin?: string;
  /** Trusted server listening address; never accepted from browser input. */
  socketPath?: string;
  secret: string;
  timeoutMs?: number;
  intervalMs?: number;
}

interface SandboxHttpResponse {
  status: number;
  retryAfter?: string;
  data: unknown;
}
class SandboxResponseError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}
const MAX_RESPONSE_BYTES = 64 * 1024;

function errorIdentity(error: unknown): { name: string; code?: string } {
  const rawName = error instanceof Error ? error.name : 'Error';
  const rawCode = error && typeof error === 'object' && 'code' in error ? error.code : null;
  return {
    name: /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(rawName) ? rawName : 'Error',
    ...(typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(rawCode)
      ? { code: rawCode }
      : {}),
  };
}

/** A complete HTTP exchange over the local listening socket or loopback TCP.
 * The wall-clock deadline includes connection, headers and the entire body.
 */
function sandboxRequest(
  origin: URL,
  options: TeamWorkerOptions,
  path: string,
  body?: string,
): Promise<SandboxHttpResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let response: IncomingMessage | undefined;
    const configuration: RequestOptions = {
      ...(options.socketPath
        ? { socketPath: options.socketPath }
        : {
            hostname: origin.hostname.replace(/^\[|\]$/g, ''),
            port: origin.port || (origin.protocol === 'https:' ? 443 : 80),
          }),
      method: body === undefined ? 'GET' : 'POST',
      path,
      agent: false,
      headers: {
        'X-Team-Sandbox-Secret': options.secret,
        ...(body === undefined
          ? {}
          : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }),
      },
    };
    const transport =
      !options.socketPath && origin.protocol === 'https:' ? requestHttps : requestHttp;
    const request = transport(configuration);
    const deadline = setTimeout(() => {
      const error = new Error('The sandbox response deadline elapsed.');
      error.name = 'TimeoutError';
      fail(error);
    }, options.timeoutMs ?? 500);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      response?.destroy();
      request.destroy(error);
      reject(error);
    };
    request.on('error', fail);
    request.on('response', (incoming) => {
      response = incoming;
      const status = incoming.statusCode ?? 502;
      let bytes = 0;
      const chunks: Buffer[] = [];
      incoming.on('error', fail);
      incoming.on('aborted', () =>
        fail(new SandboxResponseError('The sandbox response was interrupted.', status)),
      );
      incoming.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          fail(new SandboxResponseError('The sandbox response exceeded its 64 KiB limit.', status));
          return;
        }
        chunks.push(chunk);
      });
      incoming.on('end', () => {
        if (settled) return;
        let data: unknown;
        try {
          data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          // Redirects and other failed HTTP statuses stay observable; never follow Location.
          if (status >= 200 && status < 300) {
            fail(new SandboxResponseError('The sandbox returned invalid JSON.', status));
            return;
          }
          data = null;
        }
        settled = true;
        clearTimeout(deadline);
        const retryAfter = incoming.headers['retry-after'];
        resolve({ status, data, ...(typeof retryAfter === 'string' ? { retryAfter } : {}) });
      });
    });
    request.end(body);
  });
}

/** Durable claims stay in SQLite; a stopped/restarted worker recovers expired leases.
 * HTTP calls happen outside database transactions. The sandbox destination deduplicates
 * the stable source event, including when its response is lost after committing a receipt.
 */
export function createTeamWorker(options: TeamWorkerOptions) {
  const origin = new URL(options.baseUrl);
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname);
  let configuredPublic: URL | undefined;
  if (options.publicOrigin !== undefined) {
    configuredPublic = new URL(options.publicOrigin);
    if (
      configuredPublic.protocol !== 'https:' ||
      configuredPublic.username ||
      configuredPublic.password ||
      configuredPublic.pathname !== '/' ||
      configuredPublic.search ||
      configuredPublic.hash ||
      configuredPublic.href !== `${configuredPublic.origin}/`
    )
      throw new Error('The trusted public origin must be a plain HTTPS origin.');
  }
  const ownHttpsOrigin =
    configuredPublic !== undefined &&
    origin.protocol === 'https:' &&
    origin.origin === configuredPublic.origin &&
    origin.pathname === '/' &&
    !origin.search &&
    !origin.hash &&
    origin.href === `${origin.origin}/`;
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    (!loopback && !ownHttpsOrigin) ||
    origin.username ||
    origin.password
  )
    throw new Error(
      'The connector worker must use a loopback sandbox or the configured own HTTPS origin.',
    );
  if (
    options.socketPath !== undefined &&
    (!loopback || !options.socketPath || options.socketPath.includes('\0'))
  )
    throw new Error('A trusted listening socket address is required.');
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
      const path = `/api/team/sandbox/${job.id}/${job.phase === 'source' ? 'source' : 'destination'}`;
      const response = await sandboxRequest(
        origin,
        options,
        path,
        job.phase === 'delivery'
          ? JSON.stringify({ eventId: job.eventId, payload: job.payload })
          : undefined,
      );
      const data = response.data,
        retryAfter = response.retryAfter,
        ok = response.status >= 200 && response.status < 300;
      result = {
        outcome: ok ? 'success' : response.status === 429 ? 'rate_limit' : 'upstream_error',
        httpStatus: response.status,
        durationMs: Math.round(performance.now() - started),
        message: ok
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
      // Log only bounded error categories; messages may contain private socket paths or request data.
      console.error('Team sandbox request failed.', errorIdentity(error));
      const timedOut =
        error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name);
      result = {
        outcome: timedOut ? 'timeout' : 'upstream_error',
        httpStatus: error instanceof SandboxResponseError ? error.status : null,
        durationMs: Math.round(performance.now() - started),
        message: timedOut
          ? 'The response deadline elapsed; the remote outcome may be unknown. The stable event ID is retained for a safe retry.'
          : error instanceof SandboxResponseError
            ? error.message
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
        void runOnce().catch((error: unknown) =>
          console.error('Team worker claim failed; its lease will recover.', errorIdentity(error)),
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
