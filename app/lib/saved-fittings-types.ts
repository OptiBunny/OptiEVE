// Read-only saved-plan projection. Persistent fitting IDs and descriptions are omitted.
export type SavedFittingsArgs = { characterId: number };
export type FittingFlag = 'Cargo' | 'DroneBay' | 'FighterBay' | 'Invalid'
  | 'HiSlot0' | 'HiSlot1' | 'HiSlot2' | 'HiSlot3' | 'HiSlot4' | 'HiSlot5' | 'HiSlot6' | 'HiSlot7'
  | 'LoSlot0' | 'LoSlot1' | 'LoSlot2' | 'LoSlot3' | 'LoSlot4' | 'LoSlot5' | 'LoSlot6' | 'LoSlot7'
  | 'MedSlot0' | 'MedSlot1' | 'MedSlot2' | 'MedSlot3' | 'MedSlot4' | 'MedSlot5' | 'MedSlot6' | 'MedSlot7'
  | 'RigSlot0' | 'RigSlot1' | 'RigSlot2'
  | 'ServiceSlot0' | 'ServiceSlot1' | 'ServiceSlot2' | 'ServiceSlot3' | 'ServiceSlot4' | 'ServiceSlot5' | 'ServiceSlot6' | 'ServiceSlot7'
  | 'SubSystemSlot0' | 'SubSystemSlot1' | 'SubSystemSlot2' | 'SubSystemSlot3';
export type FittingFlagGroup = 'high' | 'medium' | 'low' | 'rig' | 'subsystem' | 'service' | 'cargo' | 'drone_bay' | 'fighter_bay' | 'invalid';
export type SavedFittingItem = {
  /** One-based ordinal within this fitting; repeated rows and flags are retained. */
  row: number;
  typeId: number;
  flag: FittingFlag;
  /** Safe signed integer exactly as received. No minimum is specified by ESI. */
  quantity: number;
};
export type SavedFitting = {
  /** One-based ordinal in this returned response, not a persistent fitting ID. */
  row: number;
  shipTypeId: number;
  name: string | null;
  nameState: 'reported' | 'redacted';
  nameTruncated: boolean;
  items: SavedFittingItem[];
};
export type SavedFittingType = {
  typeId: number;
  name: string;
  mapped: boolean;
  nameTruncated: boolean;
};
export type SavedFittings = {
  characterId: number;
  generatedAt: string;
  status: 'ready' | 'partial' | 'needs_permission' | 'unavailable' | 'error';
  message: string;
  scope: 'esi-fittings.read_fittings.v1';
  coverage: { kind: 'returned_response' | 'unavailable'; fittings: number | null; itemRecords: number | null };
  freshness: { state: 'fresh' | 'stale' | 'unknown'; retrievedAt: string | null; cacheExpires: string | null; lastModified: string | null };
  summary: null | {
    fittings: number; itemRecords: number; shipTypes: number; itemTypes: number;
    emptyFittings: number; emptyNames: number; redactedNames: number; truncatedNames: number;
    unmappedShipTypes: number; unmappedItemTypes: number;
  };
  /** Exactly the unique IDs present as shipTypeId or item.typeId; sorted numeric. */
  types: SavedFittingType[];
  /** Numeric type-ID order; count each fitting once. */
  hullCounts: { typeId: number; fittings: number }[];
  /** Numeric type-ID order; each fitting counts once per type regardless of repeated rows/quantity. */
  itemPresence: { typeId: number; fittings: number; itemRecords: number }[];
  /** Fixed group order, known zeros only with an accepted response. Counts records, never quantity/slots. */
  flagCounts: { group: FittingFlagGroup; itemRecords: number }[];
  fittings: SavedFitting[];
  limitations: string[];
};

