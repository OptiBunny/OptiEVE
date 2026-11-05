export type CharacterWorkspaceRequest =
  | { view: 'standings' | 'loyalty_points'; characterId: number; offset?: number }
  | { view: 'research' | 'planets'; characterId: number; offset?: number; resolveNames?: boolean }
  | { view: 'blueprints'; characterId: number; page?: number; offset?: number; resolveNames?: boolean }
  | { view: 'mining'; characterId: number; page?: number; offset?: number; resolveNames?: boolean }
  | { view: 'faction_warfare'; characterId: number };

export type CharacterWorkspaceUnit = 'count' | 'standing' | 'LP' | 'datetime' | 'RP' | 'RP/day';
export type CharacterWorkspaceMetric = { label: string; value: string | number; unit?: CharacterWorkspaceUnit };
export type CharacterWorkspaceColumn = { key: string; label: string; unit?: CharacterWorkspaceUnit };
export type CharacterWorkspaceRow = { id: string; cells: Record<string, string | number> };
export type CharacterWorkspaceLabels = {
  status: 'ready' | 'partial' | 'unavailable';
  message: string;
  retrievedAt: string | null;
  cacheExpires: string | null;
  names: { id: number; category: 'inventory_type' | 'solar_system'; name: string }[];
};
export type CharacterWorkspace = {
  view: CharacterWorkspaceRequest['view'];
  characterId: number;
  generatedAt: string;
  status: 'ready' | 'partial' | 'needs_permission' | 'unavailable' | 'error';
  coverage: 'complete' | 'partial' | 'unknown' | 'unavailable';
  message: string;
  scope: string;
  retrievedAt: string | null;
  cacheExpires: string | null;
  metrics: CharacterWorkspaceMetric[];
  columns: CharacterWorkspaceColumn[];
  rows: CharacterWorkspaceRow[];
  next: CharacterWorkspaceRequest | null;
  labels?: CharacterWorkspaceLabels;
};
