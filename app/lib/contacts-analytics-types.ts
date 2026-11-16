export type ContactsAnalyticsArgs = { characterId: number; page?: number; includeLabels?: boolean };
export type ContactsEvidenceStatus = 'ready' | 'partial' | 'needs_permission' | 'unavailable' | 'error';
export type ContactsFreshness = { state: 'fresh' | 'stale' | 'unknown'; retrievedAt: string | null; cacheExpires: string | null; lastModified: string | null };
export type ContactType = 'character' | 'corporation' | 'alliance' | 'faction' | 'other';
export type Contact = {
  row: number;
  contactId: number;
  type: ContactType;
  /** Finite received number, no rounding/clipping or implied [-10,10] GET constraint. */
  standing: number;
  /** Omitted upstream is_blocked explicitly means unknown. */
  blocked: boolean | null;
  /** Omitted upstream optional is_watched means false. */
  watched: boolean;
  /** null is unreported membership; [] is explicit empty. */
  labelIds: number[] | null;
};
export type ContactLabel = {
  row: number; labelId: number;
  name: { text: string | null; state: 'reported' | 'redacted'; truncated: boolean };
};
export type ContactsSummary = {
  contacts: number;
  negativeStanding: number; zeroStanding: number; positiveStanding: number;
  watched: number; notWatched: number;
  blocked: number; notBlocked: number; unknownBlocked: number;
  missingLabelAssignments: number; emptyLabelAssignments: number; otherTypes: number;
};
export type ContactsLabelSummary = { returnedLabels: number; emptyNames: number; redactedNames: number; truncatedNames: number };
export type ContactsAnalytics = {
  characterId: number;
  selected: { page: number; includeLabels: boolean };
  generatedAt: string; status: ContactsEvidenceStatus; message: string;
  scope: 'esi-characters.read_contacts.v1';
  contacts: {
    status: ContactsEvidenceStatus; message: string; freshness: ContactsFreshness;
    coverage: {
      kind: 'returned_page' | 'unavailable'; page: number; pages: number | null;
      nextPage: number | null; previousPage: number | null; pageLimitReached: boolean;
      contacts: number | null;
    };
    data: null | {
      summary: ContactsSummary;
      /** Fixed character, corporation, alliance, faction, other order including zero. */
      typeCounts: { type: ContactType; contacts: number }[];
      /** Ascending label ID; presence counts overlap, from known memberships only. */
      byLabel: { labelId: number; contacts: number }[];
      /** Provider order with response-local ordinal; <=1000. */
      rows: Contact[];
    };
  };
  labels: {
    status: ContactsEvidenceStatus | 'not_requested'; message: string; freshness: ContactsFreshness;
    coverage: { kind: 'returned_response' | 'not_requested' | 'unavailable'; labels: number | null };
    data: null | { summary: ContactsLabelSummary; rows: ContactLabel[] };
  };
  limitations: string[];
};
