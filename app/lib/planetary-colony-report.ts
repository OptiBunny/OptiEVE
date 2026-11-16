import { EveError } from './eve';
import { readPlanetaryAnalytics } from './planetary-analytics';
import type { PlanetaryAnalytics, PlanetaryExtractor, PlanetarySource } from './planetary-analytics-types';

export type PlanetaryColonyReport = Omit<PlanetaryAnalytics, 'extractors'> & {
  extractorPreview: PlanetaryExtractor[];
  extractorPreviewLimit: 20;
  extractorsTotal: number | null;
  extractorsOmitted: number | null;
};
function source(value: PlanetarySource): PlanetarySource {
  return { status: value.status, message: value.message, rows: value.rows, freshness: { state: value.freshness.state, retrievedAt: value.freshness.retrievedAt, cacheExpires: value.freshness.cacheExpires, lastModified: value.freshness.lastModified } };
}
function extractor(value: PlanetaryExtractor): PlanetaryExtractor {
  return { reference: value.reference, typeId: value.typeId, typeName: value.typeName, productTypeId: value.productTypeId, productName: value.productName, headCount: value.headCount,
    cycleTimeSeconds: value.cycleTimeSeconds, quantityPerCycle: value.quantityPerCycle, installedAt: value.installedAt, lastCycleStartedAt: value.lastCycleStartedAt, expiresAt: value.expiresAt };
}
/** Whitelist one validated selected-colony response without another read. */
export function projectPlanetaryColonyReport(value: PlanetaryAnalytics): PlanetaryColonyReport {
  const { colony, summary, schedule } = value;
  const result: PlanetaryColonyReport = {
    characterId: value.characterId, planetId: value.planetId, generatedAt: value.generatedAt, status: value.status, message: value.message, scope: value.scope, simulationEvidence: value.simulationEvidence,
    colony: colony === null ? null : { solarSystemId: colony.solarSystemId, planetType: colony.planetType, upgradeLevel: colony.upgradeLevel, reportedPins: colony.reportedPins, lastUpdateAt: colony.lastUpdateAt },
    sources: { colonies: source(value.sources.colonies), layout: source(value.sources.layout) },
    summary: summary === null ? null : { pins: summary.pins, extractorPins: summary.extractorPins, pinsWithoutExtractorDetails: summary.pinsWithoutExtractorDetails, missingExpiryPins: summary.missingExpiryPins, missingProductPins: summary.missingProductPins, pinCountMatchesListing: summary.pinCountMatchesListing },
    schedule: summary === null || schedule === null ? null : { asOf: schedule.asOf, horizonDays: schedule.horizonDays, pastExpiryPins: schedule.pastExpiryPins, next24hPins: schedule.next24hPins,
      days2To7Pins: schedule.days2To7Pins, days8To30Pins: schedule.days8To30Pins, laterPins: schedule.laterPins, missingExpiryPins: schedule.missingExpiryPins, daily: schedule.daily.map(row => ({ date: row.date, extractorPins: row.extractorPins })) },
    extractorPreview: summary === null ? [] : value.extractors.slice(0, 20).map(extractor), extractorPreviewLimit: 20,
    extractorsTotal: summary === null ? null : value.extractors.length, extractorsOmitted: summary === null ? null : Math.max(0, value.extractors.length - 20),
    limitations: [...value.limitations, 'Counts and schedule cover the whole accepted selected-colony response. The preview shows at most twenty extractor-detail rows, ordered by reported expiry with missing dates last; omission counts do not mean zero activity. References are only local row labels for this load.'],
  };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 256 * 1024) throw new EveError('The colony briefing exceeds the safe response limit. No partial briefing was returned.', 502);
  return result;
}
export async function readPlanetaryColonyReport(user: string, input: unknown, options: { signal?: AbortSignal } = {}): Promise<PlanetaryColonyReport> {
  options.signal?.throwIfAborted();
  const value = await readPlanetaryAnalytics(user, input, options);
  options.signal?.throwIfAborted();
  const result = projectPlanetaryColonyReport(value);
  options.signal?.throwIfAborted();
  return result;
}
