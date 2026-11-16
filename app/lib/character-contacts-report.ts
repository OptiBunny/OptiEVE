import { EveError } from './eve';
import { getContactsAnalytics } from './contacts-analytics';
import type { ContactsAnalytics, ContactsFreshness, ContactsSummary, ContactsLabelSummary } from './contacts-analytics-types';

const freshness = (v: ContactsFreshness) => ({ state: v.state, retrievedAt: v.retrievedAt, cacheExpires: v.cacheExpires, lastModified: v.lastModified });
const summary = (v: ContactsSummary) => ({ contacts: v.contacts, negativeStanding: v.negativeStanding, zeroStanding: v.zeroStanding, positiveStanding: v.positiveStanding,
  watched: v.watched, notWatched: v.notWatched, blocked: v.blocked, notBlocked: v.notBlocked, unknownBlocked: v.unknownBlocked,
  missingLabelAssignments: v.missingLabelAssignments, emptyLabelAssignments: v.emptyLabelAssignments, otherTypes: v.otherTypes });
const labelSummary = (v: ContactsLabelSummary) => ({ returnedLabels: v.returnedLabels, emptyNames: v.emptyNames, redactedNames: v.redactedNames, truncatedNames: v.truncatedNames });

/** Aggregate-only whitelist. Contact rows and private label records are never
 * read; label IDs are used only to break ranking ties and are not returned. */
export function projectCharacterContactsReport(value: ContactsAnalytics) {
  const contacts = value.contacts, labels = value.labels;
  const groups = [...(contacts.data?.byLabel ?? [])].sort((a, b) => b.contacts - a.contacts || a.labelId - b.labelId);
  const total = contacts.data === null ? null : groups.length;
  const report = {
    characterId: value.characterId, selected: { page: value.selected.page, includeLabels: value.selected.includeLabels },
    generatedAt: value.generatedAt, status: value.status, message: value.message, scope: value.scope,
    contacts: {
      status: contacts.status, message: contacts.message, freshness: freshness(contacts.freshness),
      coverage: { kind: contacts.coverage.kind, page: contacts.coverage.page, pages: contacts.coverage.pages,
        nextPage: contacts.coverage.nextPage, previousPage: contacts.coverage.previousPage,
        pageLimitReached: contacts.coverage.pageLimitReached, contacts: contacts.coverage.contacts },
      summary: contacts.data === null ? null : summary(contacts.data.summary),
      types: contacts.data === null ? null : contacts.data.typeCounts.map(row => ({ type: row.type, contacts: row.contacts })),
      labels: { limit: 20, total, shown: total === null ? null : Math.min(total, 20), omitted: total === null ? null : Math.max(0, total - 20),
        rows: groups.slice(0, 20).map((row, index) => ({ rank: index + 1, contacts: row.contacts })) },
    },
    labels: {
      status: labels.status, message: labels.message, freshness: freshness(labels.freshness),
      coverage: { kind: labels.coverage.kind, labels: labels.coverage.labels },
      summary: labels.data === null ? null : labelSummary(labels.data.summary),
    },
    limitations: [
      'Contact counts and standing signs cover only the selected returned page. Missing pages, unknown blocked flags, unreported memberships and future contact types remain explicit uncertainty. An empty page does not establish lifetime completeness or deletion.',
      'These are the selected character\'s reported contact settings. Standing signs are counts, not a sum or average, and imply no friendliness, safety, docking rights, NPC reputation or effective standings. Watched is a setting, not evidence of online status or activity.',
      'Label-presence groups overlap and use known assignment arrays only. Missing assignments are distinct from explicit empty arrays. Do not add group counts into a distinct-contact total.',
      'Anonymous label groups rank by presence, then numeric source label ID for deterministic ties. The response-local rank is not a stable label identity and must not be matched across requests. At most twenty groups are included, with full totals and explicit omissions.',
      'Contact IDs, individual standing values, label IDs, private label names, raw future type strings and contact rows are omitted. Optional label metadata reports only its independent record and name-quality counts; it does not establish membership completeness or form an atomic snapshot with contacts.',
      'By default this report reads one selected contact page. Optional label metadata requires includeLabels=true. No automatic continuation, name enrichment, writes, new grants, background collection or retained history is performed.',
    ],
  };
  if (new TextEncoder().encode(JSON.stringify(report)).byteLength > 64 * 1024) throw new EveError('The contacts briefing exceeds the safe response limit. No partial briefing was returned.', 502);
  return report;
}
export type CharacterContactsReport = ReturnType<typeof projectCharacterContactsReport>;
export async function readCharacterContactsReport(user: string, input: unknown, options: { signal?: AbortSignal } = {}): Promise<CharacterContactsReport> {
  options.signal?.throwIfAborted();
  const value = await getContactsAnalytics(user, input, options);
  options.signal?.throwIfAborted();
  const report = projectCharacterContactsReport(value);
  options.signal?.throwIfAborted();
  return report;
}
