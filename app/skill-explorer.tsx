'use client';
import { useId, useState } from 'react';
import type { CharacterSkillsAnalytics } from './lib/character-analytics-types';

const groupKey = (id: number | null) => id === null ? 'unmapped' : String(id);
const groupLabel = (name: string, id: number | null) => `${name} · ${id === null ? 'unmapped group' : 'group ' + id}`;
type DrillRow = { key: string; label: string; value: number; action: string };
function SkillBars({ title, unit, rows, maximum, choose }: { title: string; unit: string; rows: DrillRow[]; maximum: number; choose: (key: string) => void }) {
  return <figure className="analytics-figure"><figcaption>{title}</figcaption><div className="analytics-bars">{rows.map(row => <div className="analytics-bar-row" key={row.key}><button className="small" aria-label={row.action} onClick={() => choose(row.key)}>{row.label}</button><div className="analytics-track" aria-hidden="true"><span style={{ width: `${row.value / Math.max(1, maximum) * 100}%` }}/></div><strong>{row.value.toLocaleString()} <small>{unit}</small></strong></div>)}</div>{!rows.length && <p>No reported groups in this response.</p>}</figure>;
}

/** Local exploration of an already validated response; the parent keys each loaded result. */
export default function SkillExplorer({ skills }: { skills: CharacterSkillsAnalytics }) {
  const id = useId(), [query, setQuery] = useState(''), [group, setGroup] = useState('all'), [trained, setTrained] = useState('all'), [active, setActive] = useState('all'), [relation, setRelation] = useState('all'), [offset, setOffset] = useState(0);
  const groups = [...skills.groups].sort((a, b) => b.skillpoints - a.skillpoints || (a.groupId ?? -1) - (b.groupId ?? -1));
  const needle = query.trim().toLowerCase();
  const matching = skills.skills.filter(row => (group === 'all' || groupKey(row.groupId) === group)
    && (trained === 'all' || row.trainedLevel === Number(trained)) && (active === 'all' || row.activeLevel === Number(active))
    && (relation === 'all' || relation === 'reduced' && row.activeLevel < row.trainedLevel || relation === 'equal' && row.activeLevel === row.trainedLevel || relation === 'boosted' && row.activeLevel > row.trainedLevel)
    && `${row.name} ${row.groupName} ${row.typeId}`.toLowerCase().includes(needle));
  const shown = matching.slice(offset, offset + 100), levelMaximum = Math.max(1, ...skills.levelDistribution.flatMap(row => [row.trainedCount, row.activeCount]));
  function reset() { setQuery(''); setGroup('all'); setTrained('all'); setActive('all'); setRelation('all'); setOffset(0); }
  function drill(kind: 'group' | 'trained' | 'active', value: string) { reset(); if (kind === 'group') setGroup(value); else if (kind === 'trained') setTrained(value); else setActive(value); }
  return <article className="overview-card analytics-section" aria-label="Reported skill explorer"><h3>Explore reported skills</h3>
    <p className="overview-hint">Charts cover all {skills.skillCount.toLocaleString()} returned skills, independent of table filters. Group bars sum reported skill SP, not training speed or completion. Active levels may be reduced or boosted; they do not identify a skill currently training. Select a chart label to replace the table filters with that group or level.</p>
    <SkillBars title="SP by skill group" unit="SP" maximum={groups[0]?.skillpoints ?? 1} rows={groups.slice(0, 20).map(row => ({ key: groupKey(row.groupId), label: groupLabel(row.name, row.groupId), value: row.skillpoints, action: `Show ${row.skillCount} skills in ${groupLabel(row.name, row.groupId)}` }))} choose={value => drill('group', value)}/>
    <p className="overview-hint">Showing {Math.min(20, groups.length)} of {groups.length} returned groups by reported SP. Every group is available in the exact group filter. Unmapped groups stay separate from known group IDs.</p>
    <div className="analytics-columns">{(['trained', 'active'] as const).map(kind => <SkillBars key={kind} title={kind === 'trained' ? 'Trained levels' : 'Active levels'} unit="skills" maximum={levelMaximum} rows={skills.levelDistribution.map(row => ({ key: String(row.level), label: `Level ${row.level}`, value: kind === 'trained' ? row.trainedCount : row.activeCount, action: `Show skills with ${kind} level ${row.level}` }))} choose={value => drill(kind, value)}/>)}</div>
    <h4>Browse all returned skills</h4><div className="overview-controls operations-filters"><div><label htmlFor={id + '-query'}>Skill, group or type ID</label><input id={id + '-query'} type="search" maxLength={200} value={query} onChange={event => { setQuery(event.target.value); setOffset(0); }}/></div>
      <div><label htmlFor={id + '-group'}>Exact skill group</label><select id={id + '-group'} value={group} onChange={event => { setGroup(event.target.value); setOffset(0); }}><option value="all">All returned groups</option>{groups.map(row => <option key={groupKey(row.groupId)} value={groupKey(row.groupId)}>{groupLabel(row.name, row.groupId)} ({row.skillCount} skills)</option>)}</select></div>
      {(['trained', 'active'] as const).map(kind => <div key={kind}><label htmlFor={id + '-' + kind}>{kind === 'trained' ? 'Trained level' : 'Active level'}</label><select id={id + '-' + kind} value={kind === 'trained' ? trained : active} onChange={event => { (kind === 'trained' ? setTrained : setActive)(event.target.value); setOffset(0); }}><option value="all">All levels</option>{[0, 1, 2, 3, 4, 5].map(level => <option key={level} value={level}>Level {level}</option>)}</select></div>)}
      <div><label htmlFor={id + '-relation'}>Active versus trained</label><select id={id + '-relation'} value={relation} onChange={event => { setRelation(event.target.value); setOffset(0); }}><option value="all">All reported levels</option><option value="reduced">Active lower than trained</option><option value="equal">Active equals trained</option><option value="boosted">Active higher than trained</option></select></div><button className="small" onClick={reset}>Reset skill filters</button></div>
    <p role="status">{matching.length.toLocaleString()} matching skills of {skills.skillCount.toLocaleString()} returned. Showing {matching.length ? offset + 1 : 0}–{offset + shown.length}. Filters affect this table only.</p>
    <div className="workspace-table-scroll" tabIndex={0} role="region" aria-label="Filtered reported skills"><table className="workspace-table"><caption>Reported skills {matching.length ? offset + 1 : 0}–{offset + shown.length} of {matching.length} matches</caption><thead><tr><th scope="col">Skill</th><th scope="col">Group</th><th scope="col">Trained</th><th scope="col">Active</th><th scope="col">Reported SP</th></tr></thead><tbody>{shown.map(row => <tr key={row.typeId}><th scope="row">{row.name}<br/><small>Type {row.typeId}</small></th><td>{groupLabel(row.groupName, row.groupId)}</td><td>{row.trainedLevel}</td><td>{row.activeLevel}</td><td>{row.skillpoints.toLocaleString()}</td></tr>)}</tbody></table></div>
    {!matching.length && <p>No returned skills match these filters. This does not describe skills omitted from the response.</p>}
    <div className="analytics-pagination"><button className="small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>Previous 100 skills</button><button className="small" disabled={offset + 100 >= matching.length} onClick={() => setOffset(offset + 100)}>Next 100 skills</button></div>
  </article>;
}
