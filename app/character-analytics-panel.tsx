'use client';
import { useEffect, useRef, useState } from 'react';
import { ConnectionResponseError, type Character } from './lib/connection-client';
import { characterAnalyticsRequest } from './lib/analytics-client';
import type { CharacterAnalytics, CharacterAnalyticsSection } from './lib/character-analytics-types';
import { CountBars } from './analytics-charts';
import TrainingQueue from './training-queue';
import SkillExplorer from './skill-explorer';

const time = (value: string | null) => value ? new Date(value).toISOString().replace('T', ' ').replace('.000Z', ' UTC') : 'Not reported';
function Freshness({ section }: { section: CharacterAnalyticsSection<unknown> }) {
  return <div className="overview-freshness"><p>{section.message}</p><p>Source: {section.freshness} · Fetched {time(section.retrievedAt)} · Cache expiry {time(section.cacheExpires)}</p>{section.status === 'needs_permission' && <p>Required read permission: <code>{section.scope}</code></p>}</div>;
}
export default function CharacterAnalyticsPanel({ characters, openConnections, initialCharacterId }: { characters: Character[]; openConnections: () => void; initialCharacterId?: number }) {
  const [characterId, setCharacterId] = useState(initialCharacterId === undefined ? characters[0]?.characterId ?? 0 : characters.some(character => character.characterId === initialCharacterId) ? initialCharacterId : 0), [result, setResult] = useState<CharacterAnalytics | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [signedOut, setSignedOut] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  function clear() { request.current?.abort(); request.current = null; setResult(null); setBusy(false); setError(''); setSignedOut(false); }
  async function load() { if (!characters.some(character => character.characterId === characterId)) return; clear(); const controller = new AbortController(); request.current = controller; setBusy(true); try { const value = await characterAnalyticsRequest({ characterId }, controller.signal); if (request.current === controller && !controller.signal.aborted) setResult(value); } catch (failure) { if (request.current !== controller || controller.signal.aborted) return; setError((failure as Error).message); setSignedOut(failure instanceof ConnectionResponseError && failure.status === 401); } finally { if (request.current === controller) setBusy(false); } }
  if (!characters.length) return <section className="panel"><h2>Skills &amp; training</h2><p>Connect a character to view its reported skill points, queue and attributes.</p><button className="button secondary" onClick={openConnections}>Set up a connection</button></section>;
  const skills = result?.skills.data, queue = result?.queue.data, attributes = result?.attributes.data;
  return <section aria-labelledby="training-heading"><div className="overview-heading"><div><p className="eyebrow">CHARACTER INTELLIGENCE · READ ONLY</p><h2 id="training-heading">Skills &amp; training</h2></div><button className="small" onClick={openConnections}>Manage connections</button></div>
    <div className="overview-controls"><div><label htmlFor="training-character">Character</label><select id="training-character" value={characterId} onChange={event => { clear(); setCharacterId(Number(event.target.value)); }}>{!characterId && <option value={0}>Choose a connected character</option>}{characters.map(character => <option key={character.characterId} value={character.characterId}>{character.name}</option>)}</select></div><button className="button secondary" disabled={busy || !characterId} onClick={() => void load()}>{busy ? 'Loading training…' : result ? 'Refresh training' : 'Load training'}</button>{busy && <button className="small" onClick={clear}>Cancel</button>}</div>
    <p className="overview-hint">A current response for one selected character. No skill plans are submitted and no account history is saved. EVE skill data may lag until your next login.</p>
    {error && <div className="alert" role="alert">{error}{signedOut && <p><a href="/signin-with-chatgpt?return_to=%2F" target="_top">Sign in with ChatGPT</a></p>}</div>}<p className="overview-state" role="status">{busy ? 'Reading skills, queue and attributes…' : result ? result.message : 'Choose a character, then load training.'}</p>
    {result && <><div className="overview-cards"><article className="overview-card"><h3>Skill points</h3>{skills && <><dl className="overview-metrics"><div><dt>Reported total SP</dt><dd>{skills.totalSp.toLocaleString()}</dd></div><div><dt>Unallocated SP</dt><dd>{skills.unallocatedSp?.toLocaleString() ?? 'Not reported'}</dd></div><div><dt>Trained / active skills</dt><dd>{skills.trainedSkillCount} / {skills.activeSkillCount}</dd></div><div><dt>Reduced / boosted active levels</dt><dd>{skills.reducedActiveSkillCount} / {skills.boostedActiveSkillCount}</dd></div></dl><p className="overview-hint">Active levels can differ from trained levels, including expert systems. Group bars sum the SP reported on individual skills.</p></>}<Freshness section={result.skills}/></article>
      <article className="overview-card"><h3>Attributes &amp; remaps</h3>{attributes && <><CountBars title="Reported attributes" unit="points" rows={(['intelligence', 'memory', 'perception', 'willpower', 'charisma'] as const).map(key => ({ label: key[0].toUpperCase() + key.slice(1), value: attributes[key] }))}/><dl className="overview-metrics"><div><dt>Bonus remaps</dt><dd>{attributes.bonusRemaps ?? 'Not reported'}</dd></div></dl><p className="overview-hint">Last remap: {time(attributes.lastRemapAt)}<br/>Accrued remap cooldown: {time(attributes.accruedRemapCooldownAt)}</p></>}<Freshness section={result.attributes}/></article></div>
      {skills && <SkillExplorer key={result.characterId + ":" + result.generatedAt} skills={skills}/>}
      <article className="overview-card analytics-section"><h3>Training queue</h3>{queue && <TrainingQueue key={result.characterId + ":" + result.generatedAt} queue={queue}/>}<Freshness section={result.queue}/></article>
    </>}
  </section>;
}
