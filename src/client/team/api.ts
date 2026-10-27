// Author, creator and maintainer: Dhruba Poudel.
import type { DemoAccess, TeamSnapshot } from '../../shared/team-contracts.js';

export class TeamRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly uncertain = false,
  ) {
    super(message);
    this.name = 'TeamRequestError';
  }
}

export interface TeamMutation {
  path: string;
  body: string;
  key: string;
  label: string;
}

export function teamMutation(path: string, input: unknown, label: string): TeamMutation {
  return { path, body: JSON.stringify(input), key: crypto.randomUUID(), label };
}

async function responseJson<T>(response: Response, uncertain: boolean): Promise<T> {
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new TeamRequestError(
      response.ok
        ? 'The server response could not be read.'
        : 'The server did not return a readable error.',
      response.status,
      uncertain && response.ok,
    );
  }
  if (!response.ok) {
    const detail = result as { error?: { message?: unknown } };
    throw new TeamRequestError(
      typeof detail?.error?.message === 'string'
        ? detail.error.message
        : 'The request was not accepted.',
      response.status,
      uncertain && response.status >= 500,
    );
  }
  return result as T;
}

export async function getTeamWorkspace(signal?: AbortSignal): Promise<TeamSnapshot> {
  const response = await fetch('/api/team/workspace', {
    credentials: 'same-origin',
    signal,
    cache: 'no-store',
  });
  return responseJson<TeamSnapshot>(response, false);
}

async function post<T>(path: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new TeamRequestError(
      'The connection ended before the result was confirmed.',
      undefined,
      true,
    );
  }
  return responseJson<T>(response, true);
}

export function createTeamDemo(): Promise<DemoAccess> {
  return post<DemoAccess>('/api/team/demo', {});
}

export function loginTeam(input: {
  workspaceId: string;
  username: string;
  password: string;
}): Promise<TeamSnapshot> {
  return post<TeamSnapshot>('/api/team/login', input);
}

export function logoutTeam(): Promise<{ ok: true }> {
  return post<{ ok: true }>('/api/team/logout', {});
}

export async function executeTeamMutation(command: TeamMutation): Promise<TeamSnapshot> {
  let response: Response;
  try {
    response = await fetch(command.path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': command.key },
      body: command.body,
    });
  } catch {
    throw new TeamRequestError(
      'The connection ended before the change was confirmed.',
      undefined,
      true,
    );
  }
  return responseJson<TeamSnapshot>(response, true);
}
