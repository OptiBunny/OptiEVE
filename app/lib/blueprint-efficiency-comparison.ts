import type { BlueprintAnalyticsRow, BlueprintKind } from './blueprint-analytics-types';

type EfficiencyCombination = { material: number; time: number; records: number };

export function compareBlueprintEfficiency(rows: readonly BlueprintAnalyticsRow[], typeId: number, kind: BlueprintKind) {
  const selected = rows.filter(row => row.typeId === typeId && row.kind === kind);
  const copyRuns = selected.flatMap(row => row.copyRuns === null ? [] : [row.copyRuns]).sort((a, b) => a - b);
  let runs = null;
  if (copyRuns.length) {
    const lower = copyRuns[Math.floor((copyRuns.length - 1) / 2)];
    const upper = copyRuns[Math.floor(copyRuns.length / 2)];
    const sum = BigInt(lower) + BigInt(upper);
    runs = { minimum: copyRuns[0], median: (sum / 2n).toString() + (sum % 2n ? '.5' : ''), maximum: copyRuns[copyRuns.length - 1] };
  }

  // For a given material efficiency, only the highest time efficiency can qualify.
  // Walking material efficiencies in descending order also accounts for better material levels.
  const bestAtLevel = new Map<number, EfficiencyCombination>();
  for (const { materialEfficiency: material, timeEfficiency: time } of selected) {
    const best = bestAtLevel.get(material);
    if (!best || time > best.time) bestAtLevel.set(material, { material, time, records: 1 });
    else if (time === best.time) best.records++;
  }
  const levels = [...bestAtLevel.values()].sort((a, b) => b.material - a.material);
  const combinations: EfficiencyCombination[] = [];
  for (const level of levels) {
    const previous = combinations.at(-1);
    if (!previous || level.time > previous.time) combinations.push(level);
  }
  return { records: selected.length, combinations, runs };
}
