// Author, creator and maintainer: Dhruba Poudel.
import type {
  OperationalRecord,
  RecordField,
  RowView,
  WorkspaceSummary,
} from '../shared/contracts.js';

export type RowFilter = 'held' | 'all' | 'accepted' | 'excluded';
export type WorkspaceView = 'review' | 'history' | 'publications';
export const FIELD_LABELS: Record<RecordField, string> = {
  reference: 'Reference',
  team: 'Team',
  opened: 'Opened date',
  due: 'Due date',
  status: 'Status',
  minutes: 'Effort minutes',
};

export function held(row: RowView): boolean {
  return row.decision !== 'excluded' && (row.decision !== 'accepted' || row.issues.length > 0);
}

export function rowState(row: RowView): 'held' | 'accepted' | 'excluded' {
  return row.decision === 'excluded' ? 'excluded' : held(row) ? 'held' : 'accepted';
}

export function filterRows(rows: readonly RowView[], filter: RowFilter, query: string): RowView[] {
  const search = query.trim().toLocaleLowerCase();
  return rows.filter((row) => {
    if (filter !== 'all' && rowState(row) !== filter) return false;
    return (
      !search ||
      [
        row.current.reference,
        row.current.team,
        row.original.reference,
        ...row.issues.map((issue) => issue.message),
      ]
        .join(' ')
        .toLocaleLowerCase()
        .includes(search)
    );
  });
}

export function changedValues(
  original: OperationalRecord,
  draft: OperationalRecord,
): Partial<OperationalRecord> {
  const changes: Partial<OperationalRecord> = {};
  for (const field of Object.keys(draft) as RecordField[]) {
    if (draft[field] !== original[field]) changes[field] = draft[field];
  }
  return changes;
}

export function summaryWidths(summary: WorkspaceSummary): [number, number, number] {
  if (summary.total === 0) return [0, 0, 0];
  return [summary.accepted, summary.held, summary.excluded].map(
    (count) => (100 * count) / summary.total,
  ) as [number, number, number];
}

export function dateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('en-AU', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'short',
      }).format(date);
}

export function shortId(value: string, length = 8): string {
  return value.slice(0, length);
}

export function downloadPath(value: string): string | undefined {
  return /^\/api\/publications\/[A-Za-z0-9_-]+\.(?:csv|json)$/.test(value) ? value : undefined;
}
