import { EveError } from './eve';
import { readIndustryAnalytics } from './industry-analytics';
import type { IndustryAnalytics, IndustryJob, IndustrySchedule } from './industry-analytics-types';

type BriefingJob = Pick<IndustryJob, 'jobId' | 'activityId' | 'activityLabel' | 'status' | 'blueprintTypeId' | 'blueprintName' | 'productTypeId' | 'productName' | 'runs' | 'startAt' | 'endAt' | 'pauseAt'>;
type AttentionReason = 'reported_ready' | 'active_past_end' | 'reported_paused';
export type IndustryJobsReport = Omit<IndustryAnalytics, 'jobs' | 'activityCounts'> & {
  topActivities: IndustryAnalytics['activityCounts'];
  activityGroupTotal: number | null;
  activityGroupsOmitted: number | null;
  upcomingActiveJobs: BriefingJob[];
  upcomingActiveTotal: number | null;
  upcomingActiveOmitted: number | null;
  attentionJobs: (BriefingJob & { reason: AttentionReason })[];
  attentionTotal: number | null;
  attentionOmitted: number | null;
  limits: { activityGroups: 10; upcomingActiveJobs: 10; attentionJobs: 10 };
};
const MAX_REPORT_BYTES = 256 * 1024;

function job(value: IndustryJob): BriefingJob {
  return { jobId: value.jobId, activityId: value.activityId, activityLabel: value.activityLabel, status: value.status,
    blueprintTypeId: value.blueprintTypeId, blueprintName: value.blueprintName,
    productTypeId: value.productTypeId, productName: value.productName, runs: value.runs,
    startAt: value.startAt, endAt: value.endAt, pauseAt: value.pauseAt };
}
function schedule(value: IndustrySchedule | null): IndustrySchedule | null {
  return value === null ? null : { asOf: value.asOf, horizonDays: value.horizonDays,
    activePastEndJobs: value.activePastEndJobs, activeNext24hJobs: value.activeNext24hJobs,
    activeDays2To7Jobs: value.activeDays2To7Jobs, activeDays8To30Jobs: value.activeDays8To30Jobs,
    activeLaterJobs: value.activeLaterJobs, daily: value.daily.map(row => ({ date: row.date, activeJobs: row.activeJobs })) };
}
const order = (left: IndustryJob, right: IndustryJob) => left.endAt.localeCompare(right.endAt) || left.jobId - right.jobId;

/** Compact whitelist of one validated dashboard response; no extra reads. */
export function projectIndustryJobsReport(value: IndustryAnalytics): IndustryJobsReport {
  const { coverage, freshness, summary } = value, asOf = Date.parse(value.generatedAt);
  const activities = summary === null ? [] : [...value.activityCounts].sort((left, right) => right.count - left.count || left.activityId - right.activityId);
  const upcoming = summary === null ? [] : value.jobs.filter(row => row.status === 'active' && Date.parse(row.endAt) > asOf).sort(order);
  const attention = summary === null ? [] : value.jobs.flatMap(row => {
    const reason: AttentionReason | null = row.status === 'ready' ? 'reported_ready'
      : row.status === 'active' && Date.parse(row.endAt) <= asOf ? 'active_past_end'
        : row.status === 'paused' ? 'reported_paused' : null;
    return reason ? [{ row, reason }] : [];
  }).sort((left, right) => {
    const priority = { reported_ready: 0, active_past_end: 1, reported_paused: 2 };
    return priority[left.reason] - priority[right.reason] || order(left.row, right.row);
  });
  const report: IndustryJobsReport = {
    characterId: value.characterId, entity: value.entity, corporationId: value.corporationId,
    includeCompleted: value.includeCompleted, generatedAt: value.generatedAt, status: value.status,
    message: value.message, scope: value.scope,
    coverage: { kind: coverage.kind, page: coverage.page, pages: coverage.pages, nextPage: coverage.nextPage,
      previousPage: coverage.previousPage, pageLimitReached: coverage.pageLimitReached, rows: coverage.rows },
    freshness: { state: freshness.state, retrievedAt: freshness.retrievedAt, cacheExpires: freshness.cacheExpires, lastModified: freshness.lastModified },
    summary: summary === null ? null : { jobs: summary.jobs, active: summary.active, ready: summary.ready, paused: summary.paused,
      activePastEnd: summary.activePastEnd, activeDueWithin24h: summary.activeDueWithin24h,
      unknownBlueprintNames: summary.unknownBlueprintNames, unknownProductNames: summary.unknownProductNames },
    schedule: summary === null ? null : schedule(value.schedule),
    statusCounts: summary === null ? [] : value.statusCounts.map(row => ({ status: row.status, count: row.count })),
    topActivities: activities.slice(0, 10).map(row => ({ activityId: row.activityId, label: row.label, count: row.count })),
    activityGroupTotal: summary === null ? null : activities.length,
    activityGroupsOmitted: summary === null ? null : Math.max(0, activities.length - 10),
    upcomingActiveJobs: upcoming.slice(0, 10).map(job),
    upcomingActiveTotal: summary === null ? null : upcoming.length,
    upcomingActiveOmitted: summary === null ? null : Math.max(0, upcoming.length - 10),
    attentionJobs: attention.slice(0, 10).map(value => ({ ...job(value.row), reason: value.reason })),
    attentionTotal: summary === null ? null : attention.length,
    attentionOmitted: summary === null ? null : Math.max(0, attention.length - 10),
    limits: { activityGroups: 10, upcomingActiveJobs: 10, attentionJobs: 10 },
    limitations: [
      ...value.limitations,
      'Summary, status counts and schedule cover the whole selected response. Activity groups show the ten largest record counts, tied by activity ID; omission counts describe groups, not jobs.',
      'Upcoming rows show the first ten reported-active jobs with an end after generatedAt, ordered by end and job ID; later future jobs include those beyond the thirty-day chart. Attention rows show at most ten reported-ready, then active-past-end, then reported-paused jobs, ordered within each category by end and job ID. Omission totals are unknown when the response is unavailable.',
      'These are reported states and dates at load time, not automatic alerts or evidence of running work, completed output, delivery, remaining capacity or profit. No extra pages, facilities, installers, character identities, costs or history are requested.',
    ],
  };
  if (new TextEncoder().encode(JSON.stringify(report)).byteLength > MAX_REPORT_BYTES) throw new EveError('The industry briefing exceeds the safe response limit. No partial briefing was returned.', 502);
  return report;
}

export async function readIndustryJobsReport(user: string, input: unknown, options: { signal?: AbortSignal } = {}): Promise<IndustryJobsReport> {
  options.signal?.throwIfAborted();
  const result = await readIndustryAnalytics(user, input, options);
  options.signal?.throwIfAborted();
  const report = projectIndustryJobsReport(result);
  options.signal?.throwIfAborted();
  return report;
}
