// Author, creator and maintainer: Dhruba Poudel.
import type { ConnectorScenario, TeamJob, TeamJobStatus } from '../../shared/team-contracts.js';

export const SCENARIOS: { id: ConnectorScenario; label: string; description: string }[] = [
  {
    id: 'healthy',
    label: 'Healthy handoff',
    description: 'Receive a valid fictional work order, review it and request approval.',
  },
  {
    id: 'rate_limit',
    label: 'Rate-limited source',
    description:
      'The source returns 429 twice. Watch the worker wait and retry without losing the job.',
  },
  {
    id: 'timeout',
    label: 'Source timeout',
    description:
      'The first source response is delayed. A later attempt recovers the same work order.',
  },
  {
    id: 'schema_drift',
    label: 'Changed source format',
    description:
      'The source fields no longer match. An analyst must provide a valid correction and reason.',
  },
  {
    id: 'duplicate',
    label: 'Repeated source event',
    description:
      'Run this scenario twice. The same source event is recognised without creating another job.',
  },
  {
    id: 'upstream_down',
    label: 'Unavailable source',
    description:
      'The source keeps failing. Exhaust the attempts, then restore the sandbox and replay deliberately.',
  },
  {
    id: 'delivery_timeout',
    label: 'Lost delivery response',
    description:
      'The destination saves the record but the first response times out. A safe retry returns the same receipt.',
  },
];

export const STATUS_LABELS: Record<TeamJobStatus, string> = {
  queued_source: 'Source queued',
  running_source: 'Receiving source',
  retry_source: 'Source retry scheduled',
  schema_error: 'Correction needed',
  awaiting_review: 'Ready for review',
  awaiting_approval: 'Awaiting approval',
  queued_delivery: 'Delivery queued',
  running_delivery: 'Delivering',
  retry_delivery: 'Delivery retry scheduled',
  delivered: 'Delivered',
  dead_letter: 'Attempts exhausted',
};

export function isInFlight(job: TeamJob): boolean {
  return [
    'queued_source',
    'running_source',
    'retry_source',
    'queued_delivery',
    'running_delivery',
    'retry_delivery',
  ].includes(job.status);
}
export function statusTone(status: TeamJobStatus): 'positive' | 'warning' | 'neutral' | 'active' {
  if (status === 'delivered') return 'positive';
  if (['schema_error', 'dead_letter'].includes(status)) return 'warning';
  if (['awaiting_review', 'awaiting_approval'].includes(status)) return 'neutral';
  return 'active';
}
export function scenarioLabel(scenario: ConnectorScenario): string {
  return SCENARIOS.find((item) => item.id === scenario)?.label || scenario;
}
export function shortId(id: string): string {
  return id.slice(0, 8);
}
export function displayTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? 'Time unavailable'
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
