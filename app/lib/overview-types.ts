// Browser-safe view models. Raw ESI records and credentials never belong here.
export type OverviewView = 'personal' | 'corporation';
export type OverviewSectionId = 'wallet' | 'training' | 'orders' | 'industry' | 'contracts' | 'projects' | 'extractions' | 'freelance';
export type OverviewMetric = { label: string; value: number | string; unit?: 'ISK' | 'count' | 'datetime' };
export type OverviewSection = {
  id: OverviewSectionId;
  title: string;
  status: 'ready' | 'partial' | 'needs_permission' | 'unavailable' | 'error';
  message: string;
  metrics: OverviewMetric[];
  scope: string;
  retrievedAt: string | null;
  cacheExpires: string | null;
  cacheControl: string | null;
  lastModified: string | null;
  coverage: 'complete' | 'partial' | 'unknown' | 'unavailable';
};
export type Overview = {
  view: OverviewView;
  characterId: number;
  corporationId?: number;
  generatedAt: string;
  coverage: string;
  sections: OverviewSection[];
};
export type OverviewArgs = { characterId: number; view: OverviewView };
