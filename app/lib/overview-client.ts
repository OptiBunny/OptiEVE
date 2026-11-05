import type { Overview, OverviewArgs, OverviewMetric, OverviewSection } from './overview-types';
import { ConnectionResponseError } from './connection-client';

const sectionIds = ['wallet', 'training', 'orders', 'industry', 'contracts', 'projects', 'extractions', 'freelance'];
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 2048;
const date = (value: unknown): value is string => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
const nullableDate = (value: unknown) => value === null || date(value);
const identifier = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
function metric(value: unknown): value is OverviewMetric {
  return record(value) && text(value.label) && (text(value.value) || typeof value.value === 'number' && Number.isFinite(value.value)) &&
    (value.unit === undefined || typeof value.unit === 'string' && ['ISK', 'count', 'datetime'].includes(value.unit)) &&
    (value.unit !== 'datetime' || date(value.value)) &&
    (value.unit !== 'count' || typeof value.value === 'number' && Number.isSafeInteger(value.value) && value.value >= 0) &&
    (value.unit !== 'ISK' || typeof value.value === 'number');
}
function section(value: unknown): value is OverviewSection {
  return record(value) && typeof value.id === 'string' && sectionIds.includes(value.id) && text(value.title) && text(value.message) && text(value.scope) &&
    typeof value.status === 'string' && ['ready', 'partial', 'needs_permission', 'unavailable', 'error'].includes(value.status) &&
    typeof value.coverage === 'string' && ['complete', 'partial', 'unknown', 'unavailable'].includes(value.coverage) &&
    Array.isArray(value.metrics) && value.metrics.length <= 12 && value.metrics.every(metric) &&
    nullableDate(value.retrievedAt) && nullableDate(value.cacheExpires) && nullableDate(value.lastModified) &&
    (value.cacheControl === null || text(value.cacheControl));
}
export function overviewResponse(value: unknown, args: OverviewArgs): Overview {
  if (!record(value) || value.view !== args.view || value.characterId !== args.characterId ||
      (value.corporationId !== undefined && !identifier(value.corporationId)) || !date(value.generatedAt) || !text(value.coverage) ||
      !Array.isArray(value.sections) || value.sections.length !== 6 || !value.sections.every(section) ||
      new Set(value.sections.map(item => item.id)).size !== value.sections.length ||
      value.sections.some(item => !(args.view === 'personal' ? ['wallet', 'training', 'orders', 'industry', 'contracts', 'freelance'] : ['wallet', 'industry', 'contracts', 'projects', 'extractions', 'freelance']).includes(item.id))) {
    throw new ConnectionResponseError('The overview returned an incomplete response. Please try again.');
  }
  return value as Overview;
}

export async function overviewRequest(args: OverviewArgs, signal: AbortSignal): Promise<Overview> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) controller.abort();
  const timer = setTimeout(abort, 75000);
  try {
    const response = await fetch('/api/eve/overview', {
      method: 'POST', cache: 'no-store', signal: controller.signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args),
    });
    if (response.status === 401) {
      await response.body?.cancel().catch(() => {});
      throw new ConnectionResponseError('Sign in to this private connector to load your overview.', 401);
    }
    let value: unknown;
    try { value = await response.json(); } catch { throw new ConnectionResponseError('The overview service returned an unreadable response. Please try again.'); }
    if (!response.ok) throw new ConnectionResponseError(record(value) && text(value.error) && value.error.length <= 512 && value.error.trim()
      ? value.error : 'The overview could not be loaded. Please try again.', response.status);
    return overviewResponse(value, args);
  } catch (error) {
    if (controller.signal.aborted) throw new ConnectionResponseError(signal.aborted ? 'Overview request cancelled.' : 'The overview took too long to respond. Please try again.');
    if (error instanceof ConnectionResponseError) throw error;
    throw new ConnectionResponseError('Could not reach the overview service. Please try again.');
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}

export function formatMetric(metric: OverviewMetric): string {
  if (metric.unit === 'datetime') return new Date(String(metric.value)).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';
  if (typeof metric.value === 'number') return new Intl.NumberFormat(undefined, { maximumFractionDigits: metric.unit === 'ISK' ? 2 : 0 }).format(metric.value);
  return metric.value;
}
