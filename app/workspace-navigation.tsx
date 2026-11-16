'use client';
import { useId } from 'react';

const groups = [
  { label: 'Character', items: [{ key: 'overview', label: 'Overview' }, { key: 'training', label: 'Skills & training' }, { key: 'clones', label: 'Clones & implants' }, { key: 'calendar', label: 'Calendar' }, { key: 'freelance', label: 'Freelance' }, { key: 'fittings', label: 'Saved fittings' }, { key: 'mail', label: 'Mail headers' }, { key: 'contacts', label: 'Contacts' }, { key: 'reputation', label: 'Reputation' }] },
  { label: 'Finance', items: [{ key: 'wallet', label: 'Wallet activity' }, { key: 'orders', label: 'Open orders' }, { key: 'market', label: 'Trade activity' }, { key: 'contracts', label: 'Contracts' }] },
  { label: 'Operations', items: [{ key: 'corporation', label: 'Corporation' }, { key: 'inventory', label: 'Inventory' }, { key: 'jobs', label: 'Industry jobs' }, { key: 'industry', label: 'Industry' }, { key: 'manufacturing', label: 'Manufacturing' }, { key: 'blueprints', label: 'Blueprint analytics' }] },
  { label: 'Setup', items: [{ key: 'connections', label: 'Connections' }] },
] as const;
export type WorkspaceDestination = typeof groups[number]['items'][number]['key'];

export default function WorkspaceNavigation({ current, select }: { current: WorkspaceDestination; select: (destination: WorkspaceDestination) => void }) {
  const id = useId(), destinations = groups.flatMap<{ key: WorkspaceDestination; label: string }>(group => [...group.items]), active = destinations.find(item => item.key === current) ?? destinations[0];
  return <nav className="workspace-nav" aria-label="OptiEVE workspace">
    <div className="workspace-nav-compact"><label htmlFor={id + '-select'}>Workspace view</label><select id={id + '-select'} value={active.key} onChange={event => { const destination = destinations.find(item => item.key === event.target.value); if (destination) select(destination.key); }}>
      {groups.map(group => <optgroup key={group.label} label={group.label}>{group.items.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</optgroup>)}
    </select></div>
    <div className="workspace-nav-groups">{groups.map((group, index) => <div className="workspace-nav-group" key={group.label} role="group" aria-labelledby={id + '-group-' + index}>
      <p id={id + '-group-' + index}>{group.label}</p><ul>{group.items.map(item => <li key={item.key}><button type="button" aria-current={active.key === item.key ? 'page' : undefined} onClick={() => select(item.key)}>{item.label}</button></li>)}</ul>
    </div>)}</div>
  </nav>;
}
