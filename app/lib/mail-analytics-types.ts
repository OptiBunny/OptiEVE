// Manually loaded read-only mail evidence; private content is not retained.
export type MailAnalyticsArgs = { characterId: number; beforeId?: number; labels?: number[] };
export type MailEvidenceStatus = 'ready' | 'partial' | 'needs_permission' | 'unavailable' | 'error';
export type MailFreshness = { state: 'fresh' | 'stale' | 'unknown'; retrievedAt: string | null; cacheExpires: string | null; lastModified: string | null };
export type MailText = { text: string | null; state: 'missing' | 'reported' | 'redacted'; truncated: boolean };
export type MailHeader = {
  /** Response-local ordinal; never a persistent mail ID. */
  row: number;
  /** Whether the service validated a reported ID; the ID itself is withheld. */
  mailIdReported: boolean;
  timestamp: string | null;
  /** Missing optional ESI is_read is false, by the official optional-boolean contract. */
  isRead: boolean;
  /** null means assignments unreported; [] means an explicit empty assignment list. */
  labelIds: number[] | null;
  subject: MailText;
};
export type MailLabel = {
  row: number;
  labelId: number | null;
  name: MailText;
  unreadCount: number | null;
};
export type MailHeaderSummary = {
  headers: number; read: number; unread: number; dated: number;
  missingMailIds: number; missingTimestamps: number; missingLabelAssignments: number; emptyLabelAssignments: number;
  missingSubjects: number; emptySubjects: number; redactedSubjects: number; truncatedSubjects: number;
};
export type MailLabelSummary = {
  /** All null when the optional labels array was absent. */
  returnedLabels: number | null; missingLabelIds: number | null; missingUnreadCounts: number | null;
  missingNames: number | null; emptyNames: number | null; redactedNames: number | null; truncatedNames: number | null;
};
export type MailDaily = { date: string; headers: number; read: number; unread: number };
export type MailHeaderLabel = { labelId: number; headers: number; read: number; unread: number };
export type MailAnalytics = {
  characterId: number;
  selected: { beforeId: number | null; labels: number[] };
  generatedAt: string;
  status: MailEvidenceStatus;
  message: string;
  scope: 'esi-mail.read_mail.v1';
  headers: {
    status: MailEvidenceStatus; message: string; freshness: MailFreshness;
    coverage: {
      kind: 'returned_batch' | 'unavailable';
      headers: number | null;
      nextBeforeId: number | null;
      continuation: 'available' | 'empty' | 'missing_mail_ids' | 'unavailable';
    };
    data: null | {
      summary: MailHeaderSummary;
      /** All returned UTC dates sorted ascending, at most50, no zero-filled dates. */
      daily: MailDaily[];
      /** Sorted label ID; presence counts overlap and cannot be added as distinct headers. */
      byLabel: MailHeaderLabel[];
      rows: MailHeader[];
    };
  };
  labels: {
    status: MailEvidenceStatus; message: string; freshness: MailFreshness;
    coverage: { kind: 'returned_response' | 'unavailable'; labels: number | null };
    data: null | {
      /** Provider's independent total, never summed or inferred from labels/headers. */
      totalUnread: number | null;
      summary: MailLabelSummary;
      /** null means the labels array was absent; [] means accepted explicit empty. */
      rows: MailLabel[] | null;
    };
  };
  limitations: string[];
};

