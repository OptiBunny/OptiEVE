/** Pure, request-local projection of a complete ESI asset snapshot. No lookups or storage. */
export type ManufacturingStockInput = {
  rows: unknown[];
  resourceEntity: 'character' | 'corporation';
  verifiedFacilityIds: number[];
  selectedStockLocationIds: number[];
  hangarDivisions?: number[];
  materialTypeIds: number[];
  providerComplete: boolean;
};
export type ManufacturingStockProjection = {
  complete: boolean;
  quantities: Array<{ typeId: number; quantity: number }>;
  byDivision: Record<string, Record<string, number>>;
  issues: string[];
};
type Asset = {
  item_id: number; type_id: number; location_id: number; quantity: number;
  location_type: 'station' | 'solar_system' | 'item' | 'other';
  location_flag: string; is_singleton: boolean; is_blueprint_copy?: boolean;
};
type Trace = { rows: Asset[]; locations: number[]; terminal: 'verified' | 'elsewhere' | 'unknown'; issue?: string };
const MAX_ROWS = 50_000, MAX_DEPTH = 16, MAX_QUANTITY = 1_000_000_000_000;
const integer = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum;
const record = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
};
const ids = (value: unknown, maximum: number, itemMaximum = Number.MAX_SAFE_INTEGER): value is number[] => Array.isArray(value) && value.length > 0 && value.length <= maximum && [...value].every(item => integer(item, itemMaximum)) && new Set(value).size === value.length;
// Current public ESI asset schema (2026-10-31 compatibility date). A new flag
// fails closed until reviewed; knowing a flag does not make its contents usable.
const flags = new Set(('AssetSafety AutoFit Bonus Booster BoosterBay Capsule CapsuleerDeliveries Cargo CorpDeliveries CorporationGoalDeliveries CorpseBay CrateLoot Deliveries DroneBay DustBattle DustDatabank ExpeditionHold FighterBay FleetHangar FrigateEscapeBay Hangar HangarAll HiddenModifiers Implant Impounded InfrastructureHangar JunkyardReprocessed JunkyardTrashed Locked MobileDepotHold MoonMaterialBay OfficeFolder Pilot PlanetSurface QuafeBay QuantumCoreRoom Reward SecondaryStorage ShipHangar ShipOffline Skill SkillInTraining SpecializedAmmoHold SpecializedAsteroidHold SpecializedCommandCenterHold SpecializedFuelBay SpecializedGasHold SpecializedIceHold SpecializedIndustrialShipHold SpecializedLargeShipHold SpecializedMaterialBay SpecializedMediumShipHold SpecializedMineralHold SpecializedOreHold SpecializedPlanetaryCommoditiesHold SpecializedSalvageHold SpecializedShipHold SpecializedSmallShipHold StructureActive StructureDeedBay StructureFuel StructureInactive StructureOffline SubSystemBay Unlocked Wallet Wardrobe').split(' '));
const knownFlag = (value: unknown): value is string => typeof value === 'string' && (flags.has(value) || /^(?:CorpSAG[1-7]|FighterTube[0-4]|(?:Hi|Med|Lo|Rig|Service|SubSystem)Slot[0-7])$/.test(value));
function asset(value: unknown): value is Asset {
  return record(value) && integer(value.item_id) && integer(value.type_id) && integer(value.location_id) && integer(value.quantity, MAX_QUANTITY) &&
    typeof value.is_singleton === 'boolean' && (value.is_blueprint_copy === undefined || typeof value.is_blueprint_copy === 'boolean') &&
    ['station', 'solar_system', 'item', 'other'].includes(value.location_type as string) && knownFlag(value.location_flag) &&
    (!value.is_singleton || value.quantity === 1) && (value.location_flag !== 'OfficeFolder' || value.is_singleton === true);
}

/**
 * Counts only selected hangar stock. Contained Unlocked stacks inherit the
 * personal Hangar or corporation division from their proven asset ancestry.
 * An unresolved material path invalidates the projection, even when its last
 * known location appears unrelated: a missing container may hide a selection.
 * Complete means complete within this selection, not proof of hauling, job
 * installation, container withdrawal rights or current facility services.
 */
export function projectManufacturingStock(input: ManufacturingStockInput): ManufacturingStockProjection {
  const issues = new Set<string>();
  const unknown = (): ManufacturingStockProjection => ({ complete: false, quantities: [], byDivision: {}, issues: [...issues] });
  if (!record(input) || !Array.isArray(input.rows) || input.rows.length > MAX_ROWS ||
      !['character', 'corporation'].includes(input.resourceEntity) || typeof input.providerComplete !== 'boolean' ||
      !ids(input.verifiedFacilityIds, 10) || !ids(input.selectedStockLocationIds, 10) || !ids(input.materialTypeIds, 100) ||
      (input.resourceEntity === 'corporation' ? !ids(input.hangarDivisions, 7, 7) : input.hangarDivisions !== undefined)) {
    issues.add('The stock selection or bounded asset snapshot is invalid.'); return unknown();
  }
  if (!input.providerComplete) { issues.add('The asset provider did not establish complete snapshot coverage.'); return unknown(); }
  const byId = new Map<number, Asset>(), facilities = new Set(input.verifiedFacilityIds), selected = new Set(input.selectedStockLocationIds);
  const materials = new Set(input.materialTypeIds), divisions = new Set(input.hangarDivisions ?? []);
  for (const value of input.rows) {
    if (!asset(value) || byId.has(value.item_id) || facilities.has(value.item_id)) {
      issues.add('The asset snapshot contains an invalid row, duplicate item or conflicting facility identity.'); return unknown();
    }
    byId.set(value.item_id, value);
  }
  function trace(start: Asset): Trace {
    const rows: Asset[] = [], locations: number[] = [], seen = new Set<number>();
    let current = start;
    const fail = (issue: string): Trace => ({ rows, locations, terminal: 'unknown', issue });
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      if (seen.has(current.item_id)) return fail('An asset ancestry contains a cycle.');
      seen.add(current.item_id); rows.push(current);
      const parentId = current.location_id;
      locations.push(parentId);
      if (seen.has(parentId)) return fail('An asset ancestry contains a cycle.');
      if (facilities.has(parentId)) {
        if (current.location_type === 'solar_system') return fail('An asset ancestry has a conflicting physical location type.');
        return { rows, locations, terminal: 'verified' };
      }
      const parent = byId.get(parentId);
      if (parent) {
        if (current.location_type === 'station' || current.location_type === 'solar_system') return fail('An asset ancestry has a conflicting physical location type.');
        if (!parent.is_singleton || parent.is_blueprint_copy === true) return fail('An asset parent is not a supported singleton container or office.');
        current = parent;
      } else if (current.location_type === 'station' || current.location_type === 'solar_system') {
        // This explicit physical root proves the branch is outside the selected
        // verified facilities. Unknown item/other IDs cannot prove that.
        return { rows, locations, terminal: 'elsewhere' };
      } else return fail('An asset ancestry is missing a parent or a verified physical facility.');
    }
    return fail('An asset ancestry exceeds the supported depth of 16.');
  }
  function group(path: Trace, selectionOnly = false): string | null {
    let division: number | undefined, personal = false;
    for (const row of path.rows) {
      const match = /^CorpSAG([1-7])$/.exec(row.location_flag);
      if (match) {
        const next = Number(match[1]);
        if (input.resourceEntity !== 'corporation' || division !== undefined && division !== next) {
          issues.add('An asset ancestry has conflicting hangar ownership or corporation divisions.'); return null;
        }
        division = next;
      } else if (row.location_flag === 'Hangar') {
        if (input.resourceEntity !== 'character') { issues.add('An asset ancestry has conflicting hangar ownership or corporation divisions.'); return null; }
        personal = true;
      } else if (row.location_flag !== 'Unlocked' && !(input.resourceEntity === 'corporation' && row.location_flag === 'OfficeFolder')) {
        issues.add('Selected stock includes a cargo, locked, delivery, safety or other unsupported asset branch.'); return null;
      }
    }
    if (input.resourceEntity === 'character') {
      if (personal) return 'personal';
    } else {
      if (division !== undefined) return String(division);
      if (selectionOnly && path.rows[0]?.location_flag === 'OfficeFolder') return 'office';
    }
    issues.add('Selected stock does not have a proven personal hangar or corporation division.'); return null;
  }
  // Validate the explicit roots independently, including selections with no
  // material stacks. Selecting overlapping roots never duplicates a stack.
  for (const location of selected) {
    if (facilities.has(location)) continue;
    const row = byId.get(location);
    if (!row || !row.is_singleton || row.is_blueprint_copy === true) { issues.add('A selected stock location is not an observed singleton container, office or verified facility.'); continue; }
    const path = trace(row);
    if (path.terminal !== 'verified') { issues.add(path.issue ?? 'A selected stock location is outside the verified facilities.'); continue; }
    const division = group(path, true);
    if (input.resourceEntity === 'corporation' && division !== null && division !== 'office' && !divisions.has(Number(division))) issues.add('A selected stock container belongs to a corporation division that was not selected.');
  }
  if (issues.size) return unknown();
  const quantities = new Map<number, number>(input.materialTypeIds.map(typeId => [typeId, 0])), byDivision: Record<string, Record<string, number>> = {};
  for (const row of byId.values()) {
    if (!materials.has(row.type_id) || row.is_singleton || row.is_blueprint_copy === true) continue;
    const path = trace(row);
    if (path.terminal === 'unknown') { issues.add(path.issue!); continue; }
    if (path.terminal !== 'verified' || !path.locations.some(location => selected.has(location))) continue;
    const division = group(path);
    if (division === null || input.resourceEntity === 'corporation' && !divisions.has(Number(division))) continue;
    const quantity = quantities.get(row.type_id)! + row.quantity;
    if (!Number.isSafeInteger(quantity) || quantity > MAX_QUANTITY) { issues.add('The selected stock quantity exceeds the exact supported calculation limit.'); continue; }
    quantities.set(row.type_id, quantity);
    const totals = byDivision[division] ??= {};
    totals[String(row.type_id)] = (totals[String(row.type_id)] ?? 0) + row.quantity;
  }
  if (issues.size) return unknown();
  return { complete: true, quantities: [...quantities].sort(([a], [b]) => a - b).map(([typeId, quantity]) => ({ typeId, quantity })), byDivision, issues: [] };
}
