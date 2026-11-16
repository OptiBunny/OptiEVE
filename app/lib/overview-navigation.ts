import type { OverviewSectionId, OverviewView } from './overview-types';

// A shortcut carries selection only. Detail readers still enforce ownership and grants.
export type OverviewShortcut = { sectionId: OverviewSectionId; characterId: number; view: OverviewView };
export type OverviewDestination = {
  destination: 'wallet' | 'training' | 'orders' | 'jobs' | 'contracts' | 'corporation' | 'freelance';
  label: string;
  entity?: 'character' | 'corporation';
  corporationView?: 'wallets' | 'projects' | 'extractions' | 'freelance_jobs';
};
const targets: Record<OverviewView, Partial<Record<OverviewSectionId, OverviewDestination>>> = {
  personal: {
    wallet: { destination: 'wallet', label: 'Open wallet activity' },
    training: { destination: 'training', label: 'Open skills and training' },
    orders: { destination: 'orders', label: 'Open personal orders' },
    industry: { destination: 'jobs', entity: 'character', label: 'Open personal industry jobs' },
    contracts: { destination: 'contracts', entity: 'character', label: 'Open personal contracts' },
    freelance: { destination: 'freelance', label: 'Open personal freelance jobs' },
  },
  corporation: {
    wallet: { destination: 'corporation', corporationView: 'wallets', label: 'Open corporation wallet divisions' },
    industry: { destination: 'jobs', entity: 'corporation', label: 'Open corporation industry jobs' },
    contracts: { destination: 'contracts', entity: 'corporation', label: 'Open corporation contracts' },
    projects: { destination: 'corporation', corporationView: 'projects', label: 'Open corporation projects' },
    extractions: { destination: 'corporation', corporationView: 'extractions', label: 'Open corporation extractions' },
    freelance: { destination: 'corporation', corporationView: 'freelance_jobs', label: 'Open corporation freelance jobs' },
  },
};

export function overviewDestination(value: unknown): OverviewDestination | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 3 || !['sectionId', 'characterId', 'view'].every(key => Object.hasOwn(value, key) && Object.getOwnPropertyDescriptor(value, key)?.get === undefined)) return null;
  const shortcut = value as OverviewShortcut;
  if (!Number.isSafeInteger(shortcut.characterId) || shortcut.characterId <= 0 || !['personal', 'corporation'].includes(shortcut.view) || typeof shortcut.sectionId !== 'string') return null;
  const choices = targets[shortcut.view];
  return Object.hasOwn(choices, shortcut.sectionId) ? { ...choices[shortcut.sectionId]! } : null;
}
