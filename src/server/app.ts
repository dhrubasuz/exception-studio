// Author, creator and maintainer: Dhruba Poudel.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { HttpError } from './errors.js';
import { MAX_REQUEST_BYTES } from './domain.js';
import type { MutationResult, StudioStore } from './store.js';

const COOKIE_NAME = 'es_session';
const COOKIE_AGE = 24 * 60 * 60;
export interface AppOptions {
  store: StudioStore;
  clientDirectory?: string;
  publicOrigin?: string;
  secureCookies?: boolean;
  sessionCreationsPerMinute?: number;
  mutationsPerMinute?: number;
  now?: () => number;
}
function getCookie(request: IncomingMessage, name: string): string | undefined {
  return request.headers.cookie
    ?.split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(name + '='))
    ?.slice(name.length + 1);
}
function json(response: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': bytes.length,
  });
  response.end(bytes);
}
function idempotencyKey(request: IncomingMessage): string | undefined {
  const value = request.headers['idempotency-key'];
  return typeof value === 'string' ? value : undefined;
}
function body(request: IncomingMessage): Promise<unknown> {
  const type = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json')
    throw new HttpError(415, 'JSON_REQUIRED', 'Use application/json for this request.');
  if (Number(request.headers['content-length']) > MAX_REQUEST_BYTES) {
    request.resume();
    throw new HttpError(413, 'REQUEST_TOO_LARGE', 'Request bodies are limited to 64 KiB.');
  }
  return new Promise((resolveBody, reject) => {
    let bytes = 0,
      finished = false;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      if (finished) return;
      bytes += chunk.length;
      if (bytes > MAX_REQUEST_BYTES) {
        finished = true;
        chunks.length = 0;
        reject(new HttpError(413, 'REQUEST_TOO_LARGE', 'Request bodies are limited to 64 KiB.'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (finished) return;
      finished = true;
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'INVALID_JSON', 'The JSON body could not be read.'));
      }
    });
    request.on('error', () => {
      if (!finished) {
        finished = true;
        reject(new HttpError(400, 'REQUEST_INTERRUPTED', 'The request was interrupted.'));
      }
    });
    request.on('aborted', () => {
      if (!finished) {
        finished = true;
        reject(new HttpError(400, 'REQUEST_INTERRUPTED', 'The request was interrupted.'));
      }
    });
  });
}

export function createApp(options: AppOptions): Server {
  const { store } = options;
  const publicOrigin = options.publicOrigin ? new URL(options.publicOrigin).origin : undefined;
  const secureCookies = options.secureCookies ?? publicOrigin?.startsWith('https://') ?? false;
  const cookieName = secureCookies ? '__Host-' + COOKIE_NAME : COOKIE_NAME;
  const clientDirectory = options.clientDirectory ? resolve(options.clientDirectory) : undefined;
  const now = options.now || Date.now;
  const salt = randomBytes(16).toString('hex');
  const rateWindows = new Map<string, { since: number; count: number }>();
  const rate = (scope: string, identifier: string, limit: number) => {
    const time = now();
    // Only salted hashes are kept in process memory; no IP or request text is persisted here.
    const key =
      scope +
      ':' +
      createHash('sha256')
        .update(salt + identifier)
        .digest('hex');
    for (const [oldKey, item] of rateWindows)
      if (time - item.since >= 60_000) rateWindows.delete(oldKey);
    if (rateWindows.size >= 2500 && !rateWindows.has(key))
      throw new HttpError(429, 'RATE_LIMIT', 'The demonstration is busy. Try again in a minute.');
    const item = rateWindows.get(key) || { since: time, count: 0 };
    item.count += 1;
    rateWindows.set(key, item);
    if (item.count > limit)
      throw new HttpError(
        429,
        'RATE_LIMIT',
        'Too many demonstration requests. Try again in a minute.',
      );
  };
  const checkOrigin = (request: IncomingMessage) => {
    const origin = request.headers.origin;
    if (!origin || origin === 'null' || Array.isArray(origin))
      throw new HttpError(
        403,
        'ORIGIN_REQUIRED',
        'Mutations require this application’s same-origin browser context.',
      );
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new HttpError(403, 'ORIGIN_MISMATCH', 'This request origin is not allowed.');
    }
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      (publicOrigin ? parsed.origin !== publicOrigin : parsed.host !== request.headers.host)
    ) {
      throw new HttpError(403, 'ORIGIN_MISMATCH', 'This request origin is not allowed.');
    }
  };
  const sendMutation = (response: ServerResponse, result: MutationResult) => {
    response.setHeader('Idempotency-Replayed', result.replayed ? 'true' : 'false');
    json(response, 200, result.snapshot);
  };
  const setSessionCookie = (response: ServerResponse, token: string) =>
    response.setHeader(
      'Set-Cookie',
      `${cookieName}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_AGE}${secureCookies ? '; Secure' : ''}`,
    );
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
    );
    response.setHeader('Cache-Control', 'no-store');
    try {
      if (!request.url || request.url.length > 2048 || !request.url.startsWith('/'))
        throw new HttpError(400, 'INVALID_URL', 'The request URL is not supported.');
      const url = new URL(request.url, 'http://local.invalid');
      const path = decodeURIComponent(url.pathname);
      const token = getCookie(request, cookieName);
      const method = request.method || 'GET';
      if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) {
        checkOrigin(request);
        rate(
          'mutation',
          token || request.socket.remoteAddress || 'unknown',
          options.mutationsPerMinute ?? 90,
        );
      }
      if (path === '/api/health' && method === 'GET') {
        json(response, 200, {
          status: 'ok',
          application: 'Exception Studio',
          mode: store.publicMode ? 'fictional-demo' : 'local',
          storage: 'sqlite',
          author: 'Dhruba Poudel',
        });
        return;
      }
      if (path === '/api/session' && (method === 'GET' || method === 'POST')) {
        if (method === 'GET' && token) {
          try {
            json(response, 200, store.getSnapshot(token));
            return;
          } catch (error) {
            if (!(error instanceof HttpError) || error.status !== 401) throw error;
          }
        }
        if (method === 'POST') {
          const input = await body(request);
          if (
            !input ||
            typeof input !== 'object' ||
            Array.isArray(input) ||
            Object.keys(input).length
          )
            throw new HttpError(
              422,
              'INVALID_SESSION_REQUEST',
              'Start a new sandbox with an empty JSON object.',
            );
        }
        rate(
          'session',
          request.socket.remoteAddress || 'unknown',
          options.sessionCreationsPerMinute ?? 6,
        );
        const created = store.createSession();
        setSessionCookie(response, created.token);
        json(response, 201, created.snapshot);
        return;
      }
      if (path === '/api/workspace' && method === 'GET') {
        json(response, 200, store.getSnapshot(token));
        return;
      }
      if (path === '/api/imports' && method === 'POST') {
        sendMutation(
          response,
          store.importFixture(token, idempotencyKey(request), await body(request)),
        );
        return;
      }
      const decision = path.match(/^\/api\/rows\/([a-f0-9-]{36})\/decision$/);
      if (decision && method === 'PATCH') {
        sendMutation(
          response,
          store.decide(token, decision[1]!, idempotencyKey(request), await body(request)),
        );
        return;
      }
      if (path === '/api/publications' && method === 'POST') {
        sendMutation(response, store.publish(token, idempotencyKey(request), await body(request)));
        return;
      }
      const publication = path.match(/^\/api\/publications\/([a-f0-9-]{36})\.(csv|json)$/);
      if (publication && method === 'GET') {
        const snapshot = store.publication(token, publication[1]!),
          csv = publication[2] === 'csv';
        const content = csv
          ? Buffer.from(snapshot.csv)
          : Buffer.from(snapshot.manifestJson, 'utf8');
        response.writeHead(200, {
          'Content-Type': csv ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
          'Content-Length': content.length,
          'Content-Disposition': `attachment; filename="exception-studio-${publication[1]}.${publication[2]}"`,
        });
        response.end(content);
        return;
      }
      if (path.startsWith('/api'))
        throw new HttpError(404, 'NOT_FOUND', 'That API route or method is not available.');
      if (!['GET', 'HEAD'].includes(method))
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Use GET to view the application.');
      if (!clientDirectory)
        throw new HttpError(
          404,
          'CLIENT_NOT_BUILT',
          'Build the client before opening the application.',
        );
      if (path.includes('\0') || path.includes('\\'))
        throw new HttpError(400, 'INVALID_PATH', 'The static path is not supported.');
      if (
        path.split('/').some((segment) => segment.startsWith('.')) ||
        /\.(?:sqlite(?:3)?|db|env|pem|key)$/i.test(path)
      )
        throw new HttpError(404, 'NOT_FOUND', 'File not found.');
      let file = resolve(clientDirectory, '.' + path);
      if (file !== clientDirectory && !file.startsWith(clientDirectory + sep))
        throw new HttpError(404, 'NOT_FOUND', 'File not found.');
      let info = await stat(file).catch(() => null);
      if (info?.isDirectory()) {
        file = resolve(file, 'index.html');
        info = await stat(file).catch(() => null);
      }
      if (
        !info?.isFile() &&
        !extname(path) &&
        (request.headers.accept || '').includes('text/html')
      ) {
        file = resolve(clientDirectory, 'index.html');
        info = await stat(file).catch(() => null);
      }
      if (!info?.isFile()) throw new HttpError(404, 'NOT_FOUND', 'File not found.');
      const content = await readFile(file);
      const types: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.ico': 'image/x-icon',
        '.json': 'application/json; charset=utf-8',
      };
      response.writeHead(200, {
        'Content-Type': types[extname(file)] || 'application/octet-stream',
        'Content-Length': content.length,
        'Cache-Control': extname(file) === '.html' ? 'no-store' : 'public, max-age=300',
      });
      response.end(method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      if (error instanceof HttpError) {
        if (error.status === 429) response.setHeader('Retry-After', '60');
        json(response, error.status, error.body());
      } else if (error instanceof URIError)
        json(response, 400, {
          error: { code: 'INVALID_URL', message: 'The URL could not be decoded.' },
        });
      else {
        console.error(
          'Exception Studio request failed:',
          error instanceof Error ? error.name : 'unknown error',
        );
        json(response, 500, {
          error: {
            code: 'INTERNAL_ERROR',
            message: 'The demonstration could not complete this request. Try again.',
          },
        });
      }
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
