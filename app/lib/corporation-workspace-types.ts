export type CorporationWorkspaceRequest = (
  | { view: 'wallets'; characterId: number }
  | { view: 'contracts'; characterId: number; page?: number; offset?: number }
  | { view: 'order_history'; characterId: number; page?: number; offset?: number }
  | { view: 'blueprints'; characterId: number; page?: number; offset?: number }
  | { view: 'structures'; characterId: number; page?: number; offset?: number }
  | { view: 'extractions'; characterId: number; page?: number; offset?: number }
  | { view: 'freelance_jobs'; characterId: number; after?: string }
  | { view: 'assets'; characterId: number; page?: number; offset?: number }
  | { view: 'asset_detail'; characterId: number; itemId: number; page: number }
  | { view: 'facilities'; characterId: number; offset?: number }
  | { view: 'projects'; characterId: number; after?: string }
  | { view: 'contract_items'; characterId: number; contractId: number; offset?: number }
  | { view: 'contract_bids'; characterId: number; contractId: number; page?: number; offset?: number }
  | { view: 'project'; characterId: number; projectId: string }
) & { includeNames?: boolean };

export type CorporationWorkspaceColumn = { key: string; label: string; unit?: 'ISK' | 'count' | 'datetime' };
export type CorporationWorkspaceRow = {
  id: string;
  cells: Record<string, string | number>;
  action?: { label: string; request: CorporationWorkspaceRequest };
  actions?: { label: string; request: CorporationWorkspaceRequest }[];
};
export type CorporationWorkspace = {
  view: CorporationWorkspaceRequest['view'];
  characterId: number;
  corporationId?: number;
  generatedAt: string;
  status: 'ready' | 'partial' | 'needs_permission' | 'unavailable' | 'error';
  message: string;
  scope: string;
  coverage: 'complete' | 'partial' | 'unknown' | 'unavailable';
  retrievedAt: string | null;
  cacheExpires: string | null;
  sources: { dataset: string; scope: string; retrievedAt: string; cacheExpires: string | null }[];
  columns: CorporationWorkspaceColumn[];
  rows: CorporationWorkspaceRow[];
  details?: { label: string; value: string | number }[];
  next: CorporationWorkspaceRequest | null;
};
