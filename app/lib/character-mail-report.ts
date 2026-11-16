import { EveError } from './eve';
import { getMailAnalytics } from './mail-analytics';
import type { MailAnalytics, MailFreshness, MailHeaderSummary, MailLabelSummary } from './mail-analytics-types';

const freshness = (value: MailFreshness) => ({ state: value.state, retrievedAt: value.retrievedAt, cacheExpires: value.cacheExpires, lastModified: value.lastModified });
const headerSummary = (v: MailHeaderSummary) => ({ headers: v.headers, read: v.read, unread: v.unread, dated: v.dated,
  missingMailIds: v.missingMailIds, missingTimestamps: v.missingTimestamps, missingLabelAssignments: v.missingLabelAssignments,
  emptyLabelAssignments: v.emptyLabelAssignments, missingSubjects: v.missingSubjects, emptySubjects: v.emptySubjects,
  redactedSubjects: v.redactedSubjects, truncatedSubjects: v.truncatedSubjects });
const labelSummary = (v: MailLabelSummary) => ({ returnedLabels: v.returnedLabels, missingLabelIds: v.missingLabelIds, missingUnreadCounts: v.missingUnreadCounts,
  missingNames: v.missingNames, emptyNames: v.emptyNames, redactedNames: v.redactedNames, truncatedNames: v.truncatedNames });
const counts = (total: number | null, limit: number) => ({ limit, total, shown: total === null ? null : Math.min(total, limit), omitted: total === null ? null : Math.max(0, total - limit) });

/** Aggregate-only whitelist. Private subjects, label names, correspondents and
 * individual mail records are deliberately never read by this projection. */
export function projectCharacterMailReport(value: MailAnalytics) {
  const headers = value.headers, labels = value.labels;
  const dates = headers.data?.daily ?? [];
  const headerLabels = [...(headers.data?.byLabel ?? [])].sort((a, b) => b.headers - a.headers || a.labelId - b.labelId);
  const labelRows = labels.data?.rows;
  const rankedLabels = [...(labelRows ?? [])].sort((a, b) => {
    if (a.unreadCount === null && b.unreadCount !== null) return 1;
    if (a.unreadCount !== null && b.unreadCount === null) return -1;
    const count = a.unreadCount !== null && b.unreadCount !== null ? b.unreadCount - a.unreadCount : 0;
    if (count) return count;
    if (a.labelId === null && b.labelId !== null) return 1;
    if (a.labelId !== null && b.labelId === null) return -1;
    return a.labelId !== null && b.labelId !== null ? a.labelId - b.labelId : a.row - b.row;
  });
  const report = {
    characterId: value.characterId, selected: { beforeId: value.selected.beforeId, labels: [...value.selected.labels] },
    generatedAt: value.generatedAt, status: value.status, message: value.message, scope: value.scope,
    headers: {
      status: headers.status, message: headers.message, freshness: freshness(headers.freshness),
      coverage: { kind: headers.coverage.kind, headers: headers.coverage.headers, nextBeforeId: headers.coverage.nextBeforeId, continuation: headers.coverage.continuation },
      summary: headers.data === null ? null : headerSummary(headers.data.summary),
      daily: { ...counts(headers.data === null ? null : dates.length, 30), rows: dates.slice(-30).map(row => ({ date: row.date, headers: row.headers, read: row.read, unread: row.unread })) },
      labels: { ...counts(headers.data === null ? null : headerLabels.length, 20), rows: headerLabels.slice(0, 20).map(row => ({ labelId: row.labelId, headers: row.headers, read: row.read, unread: row.unread })) },
    },
    labels: {
      status: labels.status, message: labels.message, freshness: freshness(labels.freshness),
      coverage: { kind: labels.coverage.kind, labels: labels.coverage.labels },
      totalUnread: labels.data?.totalUnread ?? null, summary: labels.data === null ? null : labelSummary(labels.data.summary),
      groups: { ...counts(labelRows == null ? null : labelRows.length, 20), rows: rankedLabels.slice(0, 20).map(row => ({ row: row.row, labelId: row.labelId, unreadCount: row.unreadCount })) },
    },
    limitations: [
      'Mailbox unread total, overlapping mailbox-label counters and this bounded header batch are independent evidence. Do not sum labels into a mailbox total or reconcile them to the header batch. Their caches are not an atomic snapshot.',
      'Header dates cover the latest thirty returned UTC dates with explicit omissions, not a continuous mailbox history. Undated rows remain in the full read/unread counts. Optional absent ESI is_read means unread; other absent optional fields stay unknown.',
      'Header-label groups rank by batch presence, then numeric label ID. Mailbox-label groups rank known unread counts first, then known numeric label IDs and response-local ordinals. Missing counters remain unknown; label groups overlap.',
      'Only selected and next mail cursors are retained as pagination context. Individual mail IDs, subjects, private label names, sender/recipient identities and bodies are omitted. An empty or short batch does not establish lifetime completeness or deletion.',
      'This report requests only the selected label counters and one header batch. No body/detail lookup, automatic continuation, mark-read action, mail write, permission expansion, background collection or retained history is performed.',
    ],
  };
  if (new TextEncoder().encode(JSON.stringify(report)).byteLength > 64 * 1024) throw new EveError('The mail briefing exceeds the safe response limit. No partial briefing was returned.', 502);
  return report;
}
export type CharacterMailReport = ReturnType<typeof projectCharacterMailReport>;
export async function readCharacterMailReport(user: string, input: unknown, options: { signal?: AbortSignal } = {}): Promise<CharacterMailReport> {
  options.signal?.throwIfAborted();
  const value = await getMailAnalytics(user, input, options);
  options.signal?.throwIfAborted();
  const report = projectCharacterMailReport(value);
  options.signal?.throwIfAborted();
  return report;
}
