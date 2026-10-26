// Author, creator and maintainer: Dhruba Poudel.
import type { ApiErrorBody, WorkspaceSnapshot } from "../shared/contracts.js";

export interface MutationRequest {
  path: string;
  method: "POST" | "PATCH";
  body: string;
  key: string;
  label: string;
}

export class RequestError extends Error {
  readonly status: number;
  readonly detail: ApiErrorBody["error"] | null;
  readonly outcomeUnknown: boolean;

  constructor(
    message: string,
    status = 0,
    detail: ApiErrorBody["error"] | null = null,
  ) {
    super(message);
    this.name = "RequestError";
    this.status = status;
    this.detail = detail;
    this.outcomeUnknown = status === 0 || status >= 500;
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorDetail(value: unknown): ApiErrorBody["error"] | null {
  if (!object(value) || !object(value.error)) return null;
  const candidate = value.error;
  if (
    typeof candidate.code !== "string" ||
    typeof candidate.message !== "string"
  )
    return null;
  return candidate as unknown as ApiErrorBody["error"];
}

function snapshot(value: unknown): value is WorkspaceSnapshot {
  if (!object(value) || !object(value.session) || !object(value.summary))
    return false;
  const summary = value.summary;
  return (
    typeof value.session.id === "string" &&
    typeof value.session.expiresAt === "string" &&
    typeof value.revision === "number" &&
    Array.isArray(value.rows) &&
    Array.isArray(value.events) &&
    Array.isArray(value.publications) &&
    [
      "total",
      "accepted",
      "held",
      "excluded",
      "changed",
      "acceptedMinutes",
    ].every((key) => typeof summary[key] === "number")
  );
}

async function request(
  path: string,
  init: RequestInit,
): Promise<WorkspaceSnapshot> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
    throw new RequestError(
      "The server could not be reached. The outcome of this request is not yet known.",
    );
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new RequestError(
      "The server returned an unreadable response. Refresh before starting another action.",
      response.ok ? 502 : response.status,
    );
  }
  if (!response.ok) {
    const detail = errorDetail(data);
    throw new RequestError(
      detail?.message ??
        `The request could not be completed (HTTP ${response.status}).`,
      response.status,
      detail,
    );
  }
  if (!snapshot(data))
    throw new RequestError(
      "The server response did not match the workspace contract.",
      502,
    );
  return data;
}

export function loadWorkspace(
  signal?: AbortSignal,
): Promise<WorkspaceSnapshot> {
  return request("/api/session", { method: "GET", signal });
}

export function refreshWorkspace(
  signal?: AbortSignal,
): Promise<WorkspaceSnapshot> {
  return request("/api/workspace", { method: "GET", signal });
}

export function createSandbox(): Promise<WorkspaceSnapshot> {
  return request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
}

export function makeMutation(
  path: string,
  method: MutationRequest["method"],
  body: object,
  label: string,
): MutationRequest {
  return {
    path,
    method,
    body: JSON.stringify(body),
    key: crypto.randomUUID(),
    label,
  };
}

export function sendMutation(
  command: MutationRequest,
): Promise<WorkspaceSnapshot> {
  return request(command.path, {
    method: command.method,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": command.key,
    },
    body: command.body,
  });
}
