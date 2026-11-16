import { EveError } from './eve';
import { readPersonalFreelance } from './personal-freelance';
import type { PersonalFreelance, PersonalFreelanceJob } from './personal-freelance-types';

type JobPreview = Pick<PersonalFreelanceJob, 'jobId' | 'state' | 'updatedAt' | 'progress' | 'rewardReserve'>;
export type CharacterFreelanceReport = Omit<PersonalFreelance, 'jobs'> & {
  previewLimit: 20; omittedJobs: number | null; jobs: JobPreview[]; selectedJob: JobPreview | null;
};
function jobPreview(row: PersonalFreelanceJob): JobPreview {
  return { jobId: row.jobId, state: row.state, updatedAt: row.updatedAt, progress: { current: row.progress.current, desired: row.progress.desired },
    rewardReserve: row.rewardReserve === null ? null : { initialISK: row.rewardReserve.initialISK, remainingISK: row.rewardReserve.remainingISK } };
}
/** Explicit compact whitelist: no job names, descriptions or participant identities. */
export function projectCharacterFreelanceReport(value: PersonalFreelance): CharacterFreelanceReport {
  const selected = value.selectedJobId === null ? undefined : value.jobs.find(row => row.jobId === value.selectedJobId);
  const result: CharacterFreelanceReport = {
    characterId: value.characterId, selectedJobId: value.selectedJobId, generatedAt: value.generatedAt, status: value.status, scope: value.scope, message: value.message,
    coverage: { kind: value.coverage.kind, jobs: value.coverage.jobs, rowLimit: value.coverage.rowLimit },
    listFreshness: { state: value.listFreshness.state, retrievedAt: value.listFreshness.retrievedAt, cacheExpires: value.listFreshness.cacheExpires, lastModified: value.listFreshness.lastModified },
    summary: value.summary === null ? null : { jobs: value.summary.jobs, withRewardReserve: value.summary.withRewardReserve, withoutRewardReserve: value.summary.withoutRewardReserve, redactedNames: value.summary.redactedNames, truncatedNames: value.summary.truncatedNames },
    stateCounts: value.stateCounts.map(row => ({ state: row.state, jobs: row.jobs })), jobs: value.jobs.slice(0, 20).map(jobPreview), previewLimit: 20,
    omittedJobs: value.summary === null ? null : Math.max(0, value.summary.jobs - 20), selectedJob: selected ? jobPreview(selected) : null,
    participation: { status: value.participation.status, message: value.participation.message,
      freshness: { state: value.participation.freshness.state, retrievedAt: value.participation.freshness.retrievedAt, cacheExpires: value.participation.freshness.cacheExpires, lastModified: value.participation.freshness.lastModified },
      data: value.participation.data === null ? null : { state: value.participation.data.state, contributed: value.participation.data.contributed, updatedAt: value.participation.data.updatedAt } },
    limitations: [...value.limitations, 'The preview shows up to twenty jobs in reported update-time order, with an explicit selected-job preview separately. Omitted jobs remain outside the preview; names and raw fields are omitted. UUIDs are private selection context, not authority.'],
  };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 64 * 1024) throw new EveError('The freelance briefing exceeded its output limit. Use the dashboard to inspect this response.', 502);
  return result;
}
export async function readCharacterFreelanceReport(user: string, input: unknown, options: { signal?: AbortSignal } = {}): Promise<CharacterFreelanceReport> {
  options.signal?.throwIfAborted();
  const value = await readPersonalFreelance(user, input, options); options.signal?.throwIfAborted();
  const result = projectCharacterFreelanceReport(value); options.signal?.throwIfAborted(); return result;
}
