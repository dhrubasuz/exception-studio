// Author, creator and maintainer: Dhruba Poudel.
import type { ApiErrorBody, ValidationIssue } from '../shared/contracts.js';

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string,
    public readonly details: { currentRevision?: number; issues?: ValidationIssue[] } = {}) {
    super(message);
    this.name = 'HttpError';
  }
  body(): ApiErrorBody { return { error: { code: this.code, message: this.message, ...this.details } }; }
}

export function assertObject(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'INVALID_BODY', 'Use a JSON object.');
  }
}
export function assertKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    throw new HttpError(422, 'UNEXPECTED_FIELD', 'The request contains an unsupported field.');
  }
}
