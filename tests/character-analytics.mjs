import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const compile = name => ts.transpileModule(readFileSync(`app/lib/${name}.ts`, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const code = compile('character-analytics'), summaryCode = compile('overview-summary');
const now = Date.parse('2026-01-01T00:00:00Z'), stamp = new Date(now).toISOString(), characterId = 90000001;
const skillScope = 'esi-skills.read_skills.v1', queueScope = 'esi-skills.read_skillqueue.v1', allScopes = [skillScope, queueScope];
const plain = value => JSON.parse(JSON.stringify(value));
const marker = 'OMIT_PRIVATE_FIELDS';
const skill = (skill_id = 1001, extra = {}) => ({ skill_id, trained_skill_level: 3, active_skill_level: 3, skillpoints_in_skill: 8000, private_marker: marker, name: marker, ...extra });
const queueEntry = (queue_position = 0, extra = {}) => ({ queue_position, skill_id: 1001 + queue_position, finished_level: 4, start_date: stamp, finish_date: '2026-01-02T00:00:00Z', level_start_sp: 8000, level_end_sp: 45000, training_start_sp: 12000, private_marker: marker, ...extra });
const fixtureData = dataset => dataset === 'skills' ? { total_sp: 8000, unallocated_sp: 10, skills: [skill()], private_marker: marker } : dataset === 'skill_queue' ? [queueEntry()] : { charisma: 20, intelligence: 21, memory: 22, perception: 23, willpower: 24, bonus_remaps: 0, private_marker: marker };
const envelope = (args, data = fixtureData(args.dataset), extra = {}) => ({ characterId: args.characterId, dataset: args.dataset, retrievedAt: stamp, cacheExpires: 'Thu, 01 Jan 2026 00:05:00 GMT', pagination: { kind: 'none', nextPage: null, after: null, before: null }, data, source: marker, private_marker: marker, ...extra });
function load(source, context = {}) {
  const fixtureModule = { exports: {} };
  vm.runInNewContext(source, { module: fixtureModule, exports: fixtureModule.exports, Date, AbortSignal, ...context });
  return fixtureModule.exports;
}
const summary = load(summaryCode);
function harness(options = {}) {
  class EveError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
  const calls = [], deadline = new AbortController();
  const deps = {
    connections: async user => { calls.push({ operation: 'connections', user }); return options.connected ? options.connected(deadline) : options.connections ?? [{ characterId, scopes: allScopes }]; },
    character: async (user, args, signal) => { calls.push({ operation: 'character', user, args, signal }); return options.read ? options.read(args, signal, EveError, deadline) : envelope(args); },
    now: options.now ?? (() => now),
  };
  const item = typeId => options.item ? options.item(typeId) : typeId === 1001 ? { typeId, name: 'Synthetic public skill', categoryId: 16, groupId: 20, groupName: 'Synthetic public group' } : null;
  const service = load(code, {
    require: name => name === './overview-summary' ? summary : name === './manufacturing-catalog' ? { findPublishedManufacturingItem: item } : { EveError, listConnections: deps.connections, readCharacterData: deps.character },
    AbortSignal: { any: AbortSignal.any.bind(AbortSignal), timeout: milliseconds => { assert.equal(milliseconds, 55000); return deadline.signal; } },
  });
  return { read: service.createCharacterAnalyticsReader(deps), calls, deadline };
}
const read = h => h.read('synthetic-owner', { characterId });
const sectionFor = dataset => ({ skills: 'skills', skill_queue: 'queue', attributes: 'attributes' })[dataset];

test('analytics accepts only an explicit positive owned-character selector before any reads', async () => {
  for (const input of [null, [], {}, { characterId: 0 }, { characterId: -1 }, { characterId: 1.5 }, { characterId: NaN }, { characterId: Infinity }, { characterId: '90000001' }, { characterId: Number.MAX_SAFE_INTEGER + 1 }, { characterId, page: 1 }, { characterId, dataset: 'mail' }, { characterId, characterIds: [characterId] }, { characterId, scopes: allScopes }, { characterId, refreshToken: marker }, Object.create({ characterId })]) {
    const h = harness(); await assert.rejects(h.read('synthetic-owner', input), error => error.status === 400); assert.equal(h.calls.length, 0);
  }
});
test('analytics requires sign-in and ownership before exposing data or grant status', async () => {
  for (const user of ['', null, 10]) {
    const h = harness(); await assert.rejects(h.read(user, { characterId }), error => error.status === 401); assert.equal(h.calls.length, 0);
  }
  const h = harness({ connections: [{ characterId: characterId + 1, scopes: allScopes }] });
  await assert.rejects(read(h), error => error.status === 404); assert.equal(h.calls.length, 1);
});
test('three bounded sequential reads use exact existing scopes, identity and one deadline', async () => {
  const h = harness(), result = await read(h);
  assert.equal(result.status, 'ready'); assert.equal(result.generatedAt, stamp);
  assert.deepEqual(plain(h.calls.slice(1).map(row => row.args)), ['skills', 'skill_queue', 'attributes'].map(dataset => ({ characterId, dataset })));
  assert(h.calls.slice(1).every(row => row.user === 'synthetic-owner' && row.signal === h.deadline.signal));
  assert.equal(result.skills.scope, skillScope); assert.equal(result.attributes.scope, skillScope); assert.equal(result.queue.scope, queueScope);
  for (const section of [result.skills, result.queue, result.attributes]) {
    assert.equal(section.retrievedAt, stamp); assert.equal(section.cacheExpires, '2026-01-01T00:05:00.000Z'); assert.equal(section.freshness, 'fresh');
  }
  assert(!JSON.stringify(result).includes(marker)); assert(!JSON.stringify(result).includes('source'));
  assert.match(result.message, /separate ESI snapshots/); assert.match(result.message, /Nothing is saved/);
});
test('missing permissions are independent and never create zero data or request new grants', async () => {
  for (const grants of [[], [skillScope], [queueScope]]) {
    const h = harness({ connections: [{ characterId, scopes: grants }] }), result = await read(h);
    assert.equal(h.calls.length, 1 + (grants.includes(skillScope) ? 2 : 0) + (grants.includes(queueScope) ? 1 : 0));
    assert.equal(result.status, grants.length ? 'partial' : 'needs_permission');
    for (const section of [result.skills, result.queue, result.attributes]) if (!grants.includes(section.scope)) {
      assert.equal(section.status, 'needs_permission'); assert.equal(section.data, null); assert.equal(section.retrievedAt, null); assert.match(section.message, /No additional access/);
    }
  }
});
test('SP groups preserve reported points while active and trained levels can differ both ways', async () => {
  const rows = [skill(1001), skill(1002, { trained_skill_level: 5, active_skill_level: 2, skillpoints_in_skill: 256000 }), skill(1003, { trained_skill_level: 0, active_skill_level: 5, skillpoints_in_skill: 0 }), skill(1004, { trained_skill_level: 0, active_skill_level: 0, skillpoints_in_skill: 1 })];
  const h = harness({ read: async args => envelope(args, args.dataset === 'skills' ? { skills: rows, total_sp: 999999 } : fixtureData(args.dataset)), item: typeId => ({ typeId, name: `Public skill ${typeId}`, categoryId: 16, groupId: typeId <= 1002 ? 20 : 30, groupName: typeId <= 1002 ? 'Group A' : 'Group B' }) });
  const result = (await read(h)).skills;
  assert.equal(result.data.totalSp, 999999); assert.equal(result.data.reportedSkillSp, 264001); assert.equal(result.data.unallocatedSp, null);
  assert.equal(result.data.skillCount, 4); assert.equal(result.data.trainedSkillCount, 2); assert.equal(result.data.activeSkillCount, 3);
  assert.equal(result.data.reducedActiveSkillCount, 1); assert.equal(result.data.boostedActiveSkillCount, 1);
  assert.deepEqual(plain(result.data.groups), [{ groupId: 20, name: 'Group A', skillCount: 2, skillpoints: 264000 }, { groupId: 30, name: 'Group B', skillCount: 2, skillpoints: 1 }]);
  assert.deepEqual(plain(result.data.levelDistribution), [{ level: 0, trainedCount: 2, activeCount: 1 }, { level: 1, trainedCount: 0, activeCount: 0 }, { level: 2, trainedCount: 0, activeCount: 1 }, { level: 3, trainedCount: 1, activeCount: 1 }, { level: 4, trainedCount: 0, activeCount: 0 }, { level: 5, trainedCount: 1, activeCount: 1 }]);
  assert.deepEqual(plain(result.data.skills.map(row => row.typeId)), [1002, 1001, 1004, 1003]);
  assert.match(result.message, /next character login/); assert.match(result.message, /expert systems/); assert.match(result.message, /do not reconcile/); assert.match(result.message, /No active SP/);
});
test('unknown types and wrong-category catalog matches cannot invent a skill group', async () => {
  const h = harness({ item: () => ({ categoryId: 6, name: 'Unrelated ship', groupId: 25, groupName: 'Unrelated group' }) });
  const result = await read(h);
  assert.equal(result.skills.data.skills[0].name, 'Type 1001'); assert.equal(result.skills.data.skills[0].groupId, null);
  assert.deepEqual(plain(result.skills.data.groups), [{ groupId: null, name: 'Unknown skill group', skillCount: 1, skillpoints: 8000 }]);
  assert.equal(result.queue.data.entries[0].name, 'Type 1001'); assert(!JSON.stringify(result).includes('Unrelated'));
});
test('a verified empty skills/queue response remains distinct from unavailable data', async () => {
  const h = harness({ read: async args => envelope(args, args.dataset === 'skills' ? { total_sp: 0, unallocated_sp: 0, skills: [] } : args.dataset === 'skill_queue' ? [] : fixtureData(args.dataset)) });
  const result = await read(h);
  assert.equal(result.status, 'ready'); assert.equal(result.skills.data.totalSp, 0); assert.equal(result.skills.data.unallocatedSp, 0);
  assert.equal(result.skills.data.skillCount, 0); assert.deepEqual(plain(result.skills.data.groups), []);
  assert.equal(result.queue.data.entryCount, 0); assert.equal(result.queue.data.nextPlannedFinishAt, null); assert.equal(result.queue.data.lastPlannedFinishAt, null);
});
test('missing skill fields, malformed levels, duplicates and unsafe SP reject only the skill section', async () => {
  const badRows = [null, {}, skill(0), skill(1001, { trained_skill_level: undefined }), skill(1001, { active_skill_level: -1 }), skill(1001, { active_skill_level: 6 }), skill(1001, { trained_skill_level: 1.5 }), skill(1001, { skillpoints_in_skill: -1 }), skill(1001, { skillpoints_in_skill: 1.2 }), skill(1001, { skillpoints_in_skill: Infinity }), skill(1001, { skillpoints_in_skill: Number.MAX_SAFE_INTEGER + 1 })];
  const bad = [null, {}, { total_sp: 0 }, { total_sp: -1, skills: [] }, { total_sp: '0', skills: [] }, { total_sp: 0, skills: [], unallocated_sp: -1 }, { total_sp: 0, skills: [skill(), skill()] }, { total_sp: 0, skills: [skill(1001, { skillpoints_in_skill: Number.MAX_SAFE_INTEGER }), skill(1002)] }, ...badRows.map(row => ({ total_sp: 10, skills: [row] }))];
  for (const data of bad) {
    const result = await read(harness({ read: async args => envelope(args, args.dataset === 'skills' ? data : fixtureData(args.dataset)) }));
    assert.equal(result.skills.status, 'error'); assert.equal(result.skills.data, null); assert.equal(result.queue.status, 'ready'); assert.equal(result.attributes.status, 'ready'); assert.match(result.skills.message, /unknown, not zero/);
  }
});
test('skills safety cap accepts 2000 complete rows and rejects 2001 without a truncated chart', async () => {
  for (const count of [2000, 2001]) {
    const result = await read(harness({ read: async args => envelope(args, args.dataset === 'skills' ? { total_sp: count, skills: Array.from({ length: count }, (_, index) => skill(index + 1, { skillpoints_in_skill: 1 })) } : fixtureData(args.dataset)) }));
    assert.equal(result.skills.status, count === 2000 ? 'ready' : 'error');
    assert.equal(result.skills.data?.skills.length ?? null, count === 2000 ? count : null);
  }
});
test('queue orders reported positions and preserves unknown dates/SP without inferring pause or progress', async () => {
  const rows = [queueEntry(9, { start_date: undefined, finish_date: undefined, level_start_sp: undefined, level_end_sp: undefined, training_start_sp: undefined }), queueEntry(5, { start_date: null, finish_date: '2026-01-03T00:00:00+00:00' }), queueEntry(0, { start_date: '2025-12-30T00:00:00Z', finish_date: '2025-12-31T00:00:00Z' }), queueEntry(3)];
  const result = (await read(harness({ read: async args => envelope(args, args.dataset === 'skill_queue' ? rows : fixtureData(args.dataset)) }))).queue;
  assert.equal(result.data.entryCount, 4); assert.equal(result.data.timedEntryCount, 2); assert.equal(result.data.passedFinishEntryCount, 1);
  assert.equal(result.data.nextPlannedFinishAt, '2026-01-02T00:00:00.000Z'); assert.equal(result.data.lastPlannedFinishAt, '2026-01-03T00:00:00.000Z');
  assert.deepEqual(plain(result.data.entries.map(row => row.position)), [0, 3, 5, 9]);
  assert.deepEqual(plain(result.data.entries[3]), { position: 9, typeId: 1010, name: 'Type 1010', finishedLevel: 4, startAt: null, finishAt: null, levelStartSp: null, levelEndSp: null, trainingStartSp: null });
  assert.equal(result.data.entries[0].trainingStartSp, 12000); assert.equal(result.data.entries[0].levelStartSp, 8000); assert.equal(result.data.entries[0].levelEndSp, 45000);
  assert.match(result.message, /not proof that training is active or unpaused/); assert.match(result.message, /not proof of a paused queue/); assert.match(result.message, /not yet be reflected/);
  assert.equal(result.data.active, undefined); assert.equal(result.data.progress, undefined);
});
test('queue allows sequential levels of the same skill but rejects duplicate positions and targets', async () => {
  for (const [rows, status] of [ [[queueEntry(0, { skill_id: 1001, finished_level: 3 }), queueEntry(1, { skill_id: 1001, finished_level: 4 })], 'ready'], [[queueEntry(), queueEntry()], 'error'], [[queueEntry(), queueEntry(1, { skill_id: 1001 })], 'error'] ]) {
    const result = await read(harness({ read: async args => envelope(args, args.dataset === 'skill_queue' ? rows : fixtureData(args.dataset)) })); assert.equal(result.queue.status, status);
  }
});
test('queue rejects malformed required values, invalid dates, reversed periods and bad optional SP', async () => {
  const bad = [null, {}, [{ skill_id: 1001, finished_level: 1 }], ...[ { queue_position: -1 }, { queue_position: 0.5 }, { skill_id: 0 }, { finished_level: 0 }, { finished_level: 6 }, { start_date: '2026-02-30T00:00:00Z' }, { finish_date: '2026-01-02' }, { finish_date: '2025-12-31T00:00:00Z' }, { level_start_sp: -1 }, { level_end_sp: 100 }, { training_start_sp: '1' } ].map(extra => [queueEntry(0, extra)])];
  for (const data of bad) {
    const result = await read(harness({ read: async args => envelope(args, args.dataset === 'skill_queue' ? data : fixtureData(args.dataset)) }));
    assert.equal(result.queue.status, 'error'); assert.equal(result.queue.data, null); assert.equal(result.skills.status, 'ready');
  }
});
test('queue safety cap accepts 1000 complete entries and rejects 1001 instead of silently truncating', async () => {
  for (const count of [1000, 1001]) {
    const result = await read(harness({ read: async args => envelope(args, args.dataset === 'skill_queue' ? Array.from({ length: count }, (_, index) => queueEntry(index)) : fixtureData(args.dataset)) }));
    assert.equal(result.queue.status, count === 1000 ? 'ready' : 'error'); assert.equal(result.queue.data?.entries.length ?? null, count === 1000 ? count : null);
  }
});
test('attributes strictly project five attributes and optional remap values, without rates or remap availability', async () => {
  const result = await read(harness({ read: async args => envelope(args, args.dataset === 'attributes' ? { ...fixtureData(args.dataset), bonus_remaps: 2, last_remap_date: '2025-12-01T01:00:00+01:00', accrued_remap_cooldown_date: '2026-12-01T00:00:00Z', implant_names: marker } : fixtureData(args.dataset)) }));
  assert.deepEqual(plain(result.attributes.data), { charisma: 20, intelligence: 21, memory: 22, perception: 23, willpower: 24, bonusRemaps: 2, lastRemapAt: '2025-12-01T00:00:00.000Z', accruedRemapCooldownAt: '2026-12-01T00:00:00.000Z' });
  assert.match(result.attributes.message, /No training rate/); assert(!JSON.stringify(result).includes(marker));
  const minimal = (await read(harness())).attributes.data;
  assert.equal(minimal.lastRemapAt, null); assert.equal(minimal.accruedRemapCooldownAt, null); assert.equal(minimal.bonusRemaps, 0);
});
test('attributes reject missing, noninteger or negative values and malformed remap metadata', async () => {
  for (const extra of [{ charisma: undefined }, { intelligence: -1 }, { memory: NaN }, { perception: 1.5 }, { willpower: '20' }, { bonus_remaps: -1 }, { last_remap_date: '2026-02-30T00:00:00Z' }, { accrued_remap_cooldown_date: marker }]) {
    const result = await read(harness({ read: async args => envelope(args, args.dataset === 'attributes' ? { ...fixtureData(args.dataset), ...extra } : fixtureData(args.dataset)) }));
    assert.equal(result.attributes.status, 'error'); assert.equal(result.attributes.data, null); assert.equal(result.skills.status, 'ready');
  }
});
test('each response must match selected owner, endpoint, entity, date and unpaginated envelope', async () => {
  for (const dataset of ['skills', 'skill_queue', 'attributes']) for (const extra of [{ characterId: characterId + 1 }, { dataset: 'mail' }, { entity: 'corporation' }, { retrievedAt: '2026-01-01' }, { pagination: undefined }, { pagination: { kind: 'page' } }, { pagination: { kind: 'none', nextPage: 2 } }, { pagination: { kind: 'none', after: 'cursor' } }]) {
    const result = await read(harness({ read: async args => envelope(args, fixtureData(args.dataset), args.dataset === dataset ? extra : {}) }));
    assert.equal(result[sectionFor(dataset)].status, 'error'); assert.equal(result[sectionFor(dataset)].data, null);
  }
});
test('independent expiry unknown/stale states never become fabricated fresh readings', async () => {
  for (const expiry of [undefined, null, '', marker, 'Thu, 01 Jan 2026 00:00:00 GMT', 'Wed, 31 Dec 2025 23:00:00 GMT']) {
    const result = await read(harness({ read: async args => envelope(args, fixtureData(args.dataset), args.dataset === 'skills' ? { cacheExpires: expiry } : {}) }));
    assert.equal(result.status, 'partial'); assert.equal(result.skills.status, 'partial');
    assert.equal(result.skills.freshness, typeof expiry === 'string' && expiry.startsWith('Thu,') || typeof expiry === 'string' && expiry.startsWith('Wed,') ? 'stale' : 'unknown');
    assert.equal(result.queue.freshness, 'fresh'); assert(!JSON.stringify(result).includes(marker));
  }
});
test('all section freshness and queue finish metrics use one final completion clock', async () => {
  let clock = now;
  const h = harness({ now: () => clock, read: async args => { if (args.dataset === 'attributes') clock = now + 600000; return envelope(args, args.dataset === 'skill_queue' ? [queueEntry(0, { finish_date: '2026-01-01T00:05:00Z' })] : fixtureData(args.dataset)); } });
  const result = await read(h);
  assert.equal(result.generatedAt, '2026-01-01T00:10:00.000Z');
  assert([result.skills, result.queue, result.attributes].every(section => section.freshness === 'stale' && section.status === 'partial'));
  assert.equal(result.queue.data.passedFinishEntryCount, 1); assert.equal(result.queue.data.nextPlannedFinishAt, null); assert.equal(result.queue.data.lastPlannedFinishAt, null);
});

test('cache age, max-age and revalidation directives override a future Expires header', async () => {
  for (const [headers, expected] of [
    [{ responseDate: 'Thu, 01 Jan 2026 00:00:00 GMT', cacheControl: 'private, max-age=300', cacheAge: '301' }, 'stale'],
    [{ responseDate: 'Wed, 31 Dec 2025 23:50:00 GMT', cacheControl: 'private, max-age=300', cacheAge: '0' }, 'stale'],
    [{ cacheControl: 'private, no-store' }, 'stale'],
    [{ cacheControl: 'private, no-cache' }, 'stale'],
    [{ responseDate: 'Thu, 01 Jan 2026 00:00:00 GMT', cacheControl: 'private, max-age=300', cacheAge: '0', cacheExpires: null }, 'fresh'],
    [{ responseDate: 'Thu, 01 Jan 2026 00:00:00 GMT', cacheControl: 'private, max-age=300', cacheAge: '-1' }, 'unknown'],
    [{ responseDate: 'Thu, 01 Jan 2026 00:00:00 GMT', cacheControl: 'private, max-age=300', cacheAge: 'not-an-age' }, 'unknown'],
  ]) {
    const result = await read(harness({ read: async args => envelope(args, fixtureData(args.dataset), headers) }));
    for (const section of [result.skills, result.queue, result.attributes]) {
      assert.equal(section.freshness, expected); assert.equal(section.status, expected === 'fresh' ? 'ready' : 'partial');
    }
  }
});

test('cache dates reject impossible calendar rollovers and ambiguous strings', async () => {
  for (const cacheExpires of ['2026-02-30T00:00:00Z', 'Mon, 30 Feb 2026 00:00:00 GMT', '2026-02-01', '2026-01-01T00:05:00', '2026-13-01T00:00:00Z']) {
    const result = await read(harness({ read: async args => envelope(args, fixtureData(args.dataset), { cacheExpires }) }));
    assert.equal(result.skills.freshness, 'unknown'); assert.equal(result.skills.cacheExpires, null); assert.equal(result.skills.status, 'partial');
  }
  const result = await read(harness({ read: async args => envelope(args, fixtureData(args.dataset), { retrievedAt: '2026-01-01T00:02:00Z' }) }));
  assert.equal(result.status, 'error'); assert([result.skills, result.queue, result.attributes].every(section => section.data === null));
});
test('authorization changes and rate limits stop later reads without leaking exception text', async () => {
  for (const status of [401, 404, 409, 429]) {
    const h = harness({ read: async (args, signal, EveError) => { throw new EveError(marker, status); } });
    const result = await read(h); assert.equal(h.calls.length, 2); assert.equal(result.status, 'unavailable');
    assert([result.skills, result.queue, result.attributes].every(section => section.data === null && section.status === 'unavailable'));
    assert(!JSON.stringify(result).includes(marker));
  }
});
test('forbidden and generic provider failures do not prevent independently authorized datasets', async () => {
  for (const status of [403, 502]) {
    const h = harness({ read: async (args, signal, EveError) => { if (args.dataset === 'skills') throw new EveError(marker, status); return envelope(args); } });
    const result = await read(h); assert.equal(h.calls.length, 4); assert.equal(result.status, 'partial');
    assert.equal(result.skills.status, status === 403 ? 'unavailable' : 'error'); assert.equal(result.skills.data, null); assert.equal(result.queue.status, 'ready'); assert.equal(result.attributes.status, 'ready'); assert(!JSON.stringify(result).includes(marker));
  }
});
test('pre-cancelled requests and connection-stage cancellation do not issue provider reads', async () => {
  const controller = new AbortController(); controller.abort();
  const first = harness(); await assert.rejects(first.read('synthetic-owner', { characterId }, { signal: controller.signal })); assert.equal(first.calls.length, 0);
  const second = harness({ connected: deadline => { deadline.abort(); return [{ characterId, scopes: allScopes }]; } });
  await assert.rejects(read(second)); assert.equal(second.calls.length, 1);
});
test('shared deadline and caller cancellation discard late results and block later reads', async () => {
  for (const external of [false, true]) {
    const controller = new AbortController();
    const h = harness({ read: async (args, signal, EveError, deadline) => { if (external) controller.abort(); else deadline.abort(); return envelope(args); } });
    const result = await h.read('synthetic-owner', { characterId }, { signal: controller.signal });
    assert.equal(h.calls.length, 2); assert.equal(result.status, 'unavailable');
    assert([result.skills, result.queue, result.attributes].every(section => section.data === null)); assert.match(result.skills.message, /cancelled or reached its time limit/);
  }
});

test('shared deadline releases uncooperative connection lookup and dataset promises', async () => {
  const connection = harness({ connected: deadline => { queueMicrotask(() => deadline.abort()); return new Promise(() => {}); } });
  await assert.rejects(read(connection)); assert.equal(connection.calls.length, 1);
  const dataset = harness({ read: async (_args, _signal, _EveError, deadline) => { queueMicrotask(() => deadline.abort()); return new Promise(() => {}); } });
  const result = await read(dataset);
  assert.equal(dataset.calls.length, 2); assert.equal(result.status, 'unavailable');
  assert([result.skills, result.queue, result.attributes].every(section => section.data === null));
});

test('caller cancellation releases uncooperative promises before the shared deadline', async () => {
  for (const stage of ['connections', 'dataset']) {
    const controller = new AbortController();
    const stuck = () => { queueMicrotask(() => controller.abort()); return new Promise(() => {}); };
    const h = harness(stage === 'connections' ? { connected: stuck } : { read: stuck });
    if (stage === 'connections') await assert.rejects(h.read('synthetic-owner', { characterId }, { signal: controller.signal }));
    else {
      const result = await h.read('synthetic-owner', { characterId }, { signal: controller.signal });
      assert.equal(result.status, 'unavailable'); assert.equal(result.skills.data, null);
    }
    assert.equal(h.calls.length, stage === 'connections' ? 1 : 2);
  }
});
test('later cancellation preserves completed independent evidence while keeping later sections unavailable', async () => {
  const h = harness({ read: async (args, signal, EveError, deadline) => { if (args.dataset === 'skill_queue') deadline.abort(); return envelope(args); } });
  const result = await read(h); assert.equal(h.calls.length, 3); assert.equal(result.status, 'partial');
  assert.equal(result.skills.status, 'ready'); assert.equal(result.queue.data, null); assert.equal(result.attributes.data, null);
});
