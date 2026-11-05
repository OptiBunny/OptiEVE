import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const compile = name => ts.transpileModule(readFileSync(`app/lib/${name}.ts`, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const code = compile('industry-analytics'), summaryCode = compile('overview-summary');
const stamp = '2026-01-01T00:00:00.000Z', now = Date.parse(stamp), characterId = 90000001, corporationId = 98000001;
const scopes = { character: 'esi-industry.read_character_jobs.v1', corporation: 'esi-industry.read_corporation_jobs.v1' };
const args = { characterId, entity: 'character' }, plain = value => JSON.parse(JSON.stringify(value)), marker = 'OMIT_PRIVATE_JOB_DATA';
const job = (job_id = 1001, extra = {}) => ({ job_id, activity_id: 1, blueprint_type_id: 10001, product_type_id: 10002, runs: 1, duration: 3600, status: 'active', start_date: stamp, end_date: '2026-01-01T01:00:00Z', installer_id: 90009999, completed_character_id: 90008888, blueprint_id: 70000001, blueprint_location_id: 60000001, output_location_id: 60000002, facility_id: 10000001, station_id: 60000003, location_id: 60000004, cost: 1000000, probability: 0.4, private_marker: marker, name: marker, ...extra });
const envelope = (entity, readArgs, data = [job()], extra = {}) => ({ characterId: readArgs.characterId, dataset: 'industry_jobs', ...(entity === 'corporation' ? { entity, corporationId } : {}), retrievedAt: stamp, cacheExpires: 'Thu, 01 Jan 2026 00:05:00 GMT', data,
  pagination: entity === 'corporation' ? { kind: 'page', page: readArgs.parameters.page, pages: 1, nextPage: null, pageLimit: 500, morePagesAvailable: false, pageLimitReached: false, after: null, before: null } : { kind: 'none', nextPage: null, nextFromId: null, nextBeforeId: null, nextFromEvent: null, after: null, before: null }, source: marker, ...extra });
function load(source, context = {}) { const module = { exports: {} }; vm.runInNewContext(source, { module, exports: module.exports, Date, AbortSignal, ...context }); return module.exports; }
const summary = load(summaryCode);
function harness(options = {}) {
  class EveError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
  const calls = [], deadline = new AbortController();
  const read = entity => async (user, input, signal) => { calls.push({ entity, user, args: input, signal }); return options.read ? options.read(entity, input, signal, EveError, deadline) : envelope(entity, input); };
  const deps = { connections: async user => { calls.push({ operation: 'connections', user }); return options.connect ? options.connect(deadline) : options.connections ?? [{ characterId, scopes: Object.values(scopes) }]; }, character: read('character'), corporation: read('corporation'), now: options.now ?? (() => now) };
  const findItem = typeId => options.item ? options.item(typeId) : typeId === 10001 || typeId === 10002 ? { typeId, name: typeId === 10001 ? 'Synthetic public blueprint' : 'Synthetic public product' } : null;
  const service = load(code, { require: name => name === './overview-summary' ? summary : name === './manufacturing-catalog' ? { findPublishedManufacturingItem: findItem } : { EveError, listConnections: deps.connections, readCharacterData: deps.character, readCorporationData: deps.corporation }, AbortSignal: { any: AbortSignal.any.bind(AbortSignal), timeout: milliseconds => { assert.equal(milliseconds, 55000); return deadline.signal; } } });
  return { read: service.createIndustryAnalyticsReader(deps), calls, deadline };
}
const get = (h, selection = args, options) => h.read('synthetic-owner', selection, options);

test('industry selectors reject unexpected, unsafe and personally paginated input before any access', async () => {
  for (const input of [null, [], {}, { ...args, characterId: '90000001' }, { ...args, characterId: 0 }, { ...args, characterId: -1 }, { ...args, characterId: 1.1 }, { ...args, characterId: Number.MAX_SAFE_INTEGER + 1 }, { ...args, entity: 'all' }, { ...args, page: 1 }, { ...args, page: undefined }, { ...args, includeCompleted: 'false' }, { ...args, includeCompleted: undefined }, { ...args, url: marker }, { ...args, corporationId }, { ...args, write: true }, { ...args, entity: 'corporation', page: 0 }, { ...args, entity: 'corporation', page: 501 }, Object.create(args), { ...args, [Symbol('unexpected')]: true }]) {
    const h = harness(); await assert.rejects(get(h, input), error => error.status === 400); assert.equal(h.calls.length, 0);
  }
});
test('sign-in, ownership and exact existing grants precede each dataset request', async () => {
  for (const user of ['', null, 99]) { const h = harness(); await assert.rejects(h.read(user, args), error => error.status === 401); assert.equal(h.calls.length, 0); }
  const other = harness({ connections: [{ characterId: characterId + 1, scopes: Object.values(scopes) }] }); await assert.rejects(get(other), error => error.status === 404); assert.equal(other.calls.length, 1);
  for (const entity of ['character', 'corporation']) {
    const h = harness({ connections: [{ characterId, scopes: [scopes[entity === 'character' ? 'corporation' : 'character']] }] }), result = await get(h, { characterId, entity });
    assert.equal(result.status, 'needs_permission'); assert.equal(result.scope, scopes[entity]); assert.equal(result.summary, null); assert.deepEqual(plain(result.jobs), []); assert.equal(h.calls.length, 1); assert.equal(result.coverage.kind, 'unavailable');
  }
});
test('personal read is a single unpaginated response with explicit includeCompleted false', async () => {
  const h = harness(), result = await get(h);
  assert.equal(h.calls.length, 2); assert.equal(h.calls[1].entity, 'character'); assert.equal(h.calls[1].signal, h.deadline.signal);
  assert.deepEqual(plain(h.calls[1].args), { characterId, dataset: 'industry_jobs', parameters: { includeCompleted: false } });
  assert.equal(result.status, 'ready'); assert.equal(result.corporationId, null); assert.equal(result.includeCompleted, false);
  assert.deepEqual(plain(result.coverage), { kind: 'complete_returned_response', page: null, pages: null, nextPage: null, previousPage: null, pageLimitReached: false, rows: 1 });
  assert.equal(result.summary.jobs, 1); assert.equal(result.summary.activeDueWithin24h, 1); assert.equal(result.summary.activePastEnd, 0);
  assert.equal(result.jobs[0].activityLabel, 'Manufacturing'); assert.equal(result.jobs[0].blueprintName, 'Synthetic public blueprint'); assert.equal(result.jobs[0].productName, 'Synthetic public product');
  assert.equal(result.freshness.state, 'fresh'); assert.equal(result.freshness.cacheExpires, '2026-01-01T00:05:00.000Z');
  assert.equal(result.statusCounts.length, 6); assert.equal(result.statusCounts.reduce((sum, row) => sum + row.count, 0), 1);
});
test('corporation ownership is returned from the live scoped adapter with one explicit page', async () => {
  const h = harness({ read: async (entity, input) => envelope(entity, input, [job()], { corporationId: corporationId + 1, pagination: { kind: 'page', page: 2, pages: 4, nextPage: 3, pageLimit: 500, morePagesAvailable: true, pageLimitReached: false } }) });
  const result = await get(h, { ...args, entity: 'corporation', page: 2, includeCompleted: true });
  assert.equal(h.calls.length, 2); assert.equal(h.calls[1].entity, 'corporation'); assert.deepEqual(plain(h.calls[1].args.parameters), { includeCompleted: true, page: 2 });
  assert.equal(result.corporationId, corporationId + 1); assert.equal(result.includeCompleted, true); assert.equal(result.status, 'partial');
  assert.equal(result.coverage.page, 2); assert.equal(result.coverage.pages, 4); assert.equal(result.coverage.nextPage, 3); assert.equal(result.coverage.previousPage, 1); assert.match(result.message, /past-90-day/);
});
test('unknown corporation pages and application boundary cannot claim complete coverage or fetch another page', async () => {
  for (const [page, pages, nextPage, more, reached] of [[1, null, null, null, false], [500, 501, null, true, true], [500, null, null, null, true], [500, 500, null, false, false]]) {
    const h = harness({ read: async (entity, input) => envelope(entity, input, [], { pagination: { kind: 'page', page, pages, nextPage, morePagesAvailable: more, pageLimitReached: reached } }) });
    const result = await get(h, { ...args, entity: 'corporation', page });
    assert.equal(result.status, 'partial'); assert.equal(result.coverage.kind, pages === null ? 'unknown' : 'partial'); assert.equal(result.coverage.pageLimitReached, reached); assert.equal(h.calls.length, 2);
  }
});
test('statuses and activity charts count records, never mix runs or infer readiness from timestamps', async () => {
  const rows = [job(1, { runs: 10, start_date: '2025-12-30T00:00:00Z', end_date: '2025-12-31T00:00:00Z' }), job(2, { status: 'paused', activity_id: 3, runs: 20, end_date: stamp }), job(3, { status: 'ready', activity_id: 4 }), job(4, { status: 'delivered', activity_id: 5, completed_date: stamp }), job(5, { status: 'cancelled', activity_id: 8 }), job(6, { status: 'reverted', activity_id: 9 }), job(7, { activity_id: 999, end_date: '2026-01-03T00:00:00Z' })];
  const result = await get(harness({ read: async (entity, input) => envelope(entity, input, rows) }), { ...args, includeCompleted: true });
  assert.deepEqual(plain(result.summary), { jobs: 7, active: 2, ready: 1, paused: 1, activePastEnd: 1, activeDueWithin24h: 0, unknownBlueprintNames: 0, unknownProductNames: 0 });
  assert.equal(result.activityCounts.reduce((sum, row) => sum + row.count, 0), 7);
  assert.deepEqual(plain(result.activityCounts.map(row => row.label)), ['Manufacturing', 'Time Efficiency Research', 'Material Efficiency Research', 'Copying', 'Invention', 'Reactions', 'Activity 999']);
  assert.equal(result.jobs.find(row => row.jobId === 2).runs, 20); assert(!Object.hasOwn(result.summary, 'runs'));
  assert.equal(result.jobs.find(row => row.jobId === 1).status, 'active'); assert.equal(result.jobs.find(row => row.jobId === 7).activityLabel, 'Activity 999');
});
test('due counts use common completion time and only active jobs in the exact next-24-hour interval', async () => {
  const completed = now + 3600000;
  const rows = [job(1), job(2, { end_date: new Date(completed + 86400000).toISOString() }), job(3, { end_date: new Date(completed + 86400001).toISOString() }), job(4, { status: 'paused', end_date: new Date(completed + 1000).toISOString() })];
  const result = await get(harness({ now: () => completed, read: async (entity, input) => envelope(entity, input, rows) }));
  assert.equal(result.generatedAt, new Date(completed).toISOString()); assert.equal(result.summary.activePastEnd, 1); assert.equal(result.summary.activeDueWithin24h, 1); assert.equal(result.freshness.state, 'stale');
});
test('unknown public types and absent research products stay explicit without extra reads', async () => {
  const h = harness({ item: () => null, read: async (entity, input) => envelope(entity, input, [job(1), job(2, { activity_id: 3, product_type_id: undefined })]) });
  const result = await get(h);
  assert.equal(result.status, 'partial'); assert.equal(result.summary.unknownBlueprintNames, 2); assert.equal(result.summary.unknownProductNames, 1);
  assert.equal(result.jobs[0].blueprintName, 'Type 10001'); assert.equal(result.jobs[0].productName, 'Type 10002'); assert.equal(result.jobs[1].productTypeId, null); assert.equal(result.jobs[1].productName, null); assert.equal(h.calls.length, 2);
});
test('projection excludes installer, completing-character, locations, costs and all untrusted free text', async () => {
  const result = await get(harness());
  const allowed = ['jobId', 'activityId', 'activityLabel', 'status', 'blueprintTypeId', 'blueprintName', 'productTypeId', 'productName', 'runs', 'durationSeconds', 'startAt', 'endAt', 'pauseAt', 'completedAt'].sort();
  assert.deepEqual(Object.keys(result.jobs[0]).sort(), allowed); assert(!JSON.stringify(result).includes(marker));
  for (const forbidden of ['90009999', '90008888', '70000001', '60000001', '60000002', '60000003', '60000004']) assert(!JSON.stringify(result.jobs).includes(forbidden));
});
test('offset and fractional timestamps normalize to UTC without equating reported duration with wall time', async () => {
  const result = await get(harness({ read: async (entity, input) => envelope(entity, input, [job(1, { start_date: '2025-12-31T23:00:00-01:00', end_date: '2026-01-01T02:00:00.123456789+01:00', duration: 999, pause_date: '2026-01-01T00:30:00Z', completed_date: '2026-01-01T01:30:00Z' })]) }));
  assert.equal(result.jobs[0].startAt, stamp); assert.equal(result.jobs[0].endAt, '2026-01-01T01:00:00.123Z'); assert.equal(result.jobs[0].durationSeconds, 999); assert.equal(result.jobs[0].pauseAt, '2026-01-01T00:30:00.000Z'); assert.equal(result.jobs[0].completedAt, '2026-01-01T01:30:00.000Z');
});
test('empty successful response produces known zero counts while unavailable data has no counts', async () => {
  const result = await get(harness({ read: async (entity, input) => envelope(entity, input, []) }));
  assert.equal(result.status, 'ready'); assert.equal(result.summary.jobs, 0); assert.equal(result.statusCounts.length, 6); assert(result.statusCounts.every(row => row.count === 0)); assert.deepEqual(plain(result.activityCounts), []); assert.deepEqual(plain(result.jobs), []);
});
test('malformed, duplicate and oversized job responses fail wholly without partial charts', async () => {
  const variants = [[job(), job()], Array.from({ length: 5001 }, (_, index) => job(index + 1))];
  for (const extra of [{ job_id: 0 }, { job_id: 1.1 }, { activity_id: -1 }, { activity_id: '1' }, { blueprint_type_id: 0 }, { product_type_id: '10002' }, { runs: -1 }, { runs: Infinity }, { duration: NaN }, { status: 'invented' }, { start_date: '2026-02-30T00:00:00Z' }, { end_date: '2026-01-01' }, { end_date: '2025-12-31T23:59:59Z' }, { pause_date: 'bad' }, { completed_date: 123 }]) variants.push([job(1, extra)]);
  for (const rows of variants) { const result = await get(harness({ read: async (entity, input) => envelope(entity, input, rows) })); assert.equal(result.status, 'error'); assert.equal(result.summary, null); assert.deepEqual(plain(result.jobs), []); assert.deepEqual(plain(result.statusCounts), []); }
});
test('maximum bounded response is accepted without silent truncation', async () => {
  const result = await get(harness({ read: async (entity, input) => envelope(entity, input, Array.from({ length: 5000 }, (_, index) => job(index + 1))) }));
  assert.equal(result.status, 'ready'); assert.equal(result.summary.jobs, 5000); assert.equal(result.jobs.length, 5000); assert.equal(result.coverage.rows, 5000);
});
test('selected identity, entity, dataset and paging contradictions cannot cross context', async () => {
  for (const [entity, extra] of [
    ['character', { characterId: characterId + 1 }], ['character', { entity: 'corporation', corporationId }], ['character', { corporationId }], ['character', { dataset: 'assets' }], ['character', { retrievedAt: '2026-01-01T00:01:01Z' }], ['character', { pagination: { kind: 'page', nextPage: null } }], ['character', { pagination: { kind: 'none', page: 1 } }],
    ['corporation', { entity: 'character' }], ['corporation', { corporationId: null }], ['corporation', { pagination: { kind: 'page', page: 2, pages: 2, nextPage: null } }], ['corporation', { pagination: { kind: 'page', page: 1, pages: 2, nextPage: null } }], ['corporation', { pagination: { kind: 'page', page: 1, pages: null, nextPage: 2 } }], ['corporation', { pagination: { kind: 'page', page: 1, pages: 1, nextPage: null, after: 'unexpected-cursor' } }],
  ]) { const result = await get(harness({ read: async (current, input) => envelope(current, input, [job()], extra) }), { ...args, entity }); assert.equal(result.status, 'error'); assert.equal(result.summary, null); assert.deepEqual(plain(result.jobs), []); }
});
test('cache age, max-age, no-store and missing metadata cannot overstate freshness', async () => {
  for (const [extra, state] of [[{ cacheExpires: null }, 'unknown'], [{ cacheExpires: 'Sun, 30 Feb 2026 00:05:00 GMT' }, 'unknown'], [{ cacheAge: '-1' }, 'unknown'], [{ cacheControl: 'max-age=300', responseDate: 'Thu, 01 Jan 2026 00:00:00 GMT', cacheAge: '301' }, 'stale'], [{ cacheControl: 'private, no-store' }, 'stale'], [{ cacheControl: 'no-cache' }, 'stale'], [{ cacheExpires: null, cacheControl: 'public, max-age=300', responseDate: 'Thu, 01 Jan 2026 00:00:00 GMT', cacheAge: '0' }, 'fresh']]) {
    const result = await get(harness({ read: async (entity, input) => envelope(entity, input, [job()], extra) })); assert.equal(result.freshness.state, state); assert.equal(result.status, state === 'fresh' ? 'ready' : 'partial');
  }
});
test('denials, authorization changes, rate limits and unexpected failures expose only generic errors', async () => {
  for (const code of [401, 403, 404, 409, 429, 500]) {
    const h = harness({ read: async (_entity, _input, _signal, EveError) => { throw new EveError(marker, code); } }), result = await get(h, { ...args, entity: 'corporation' });
    assert.equal(result.status, code === 500 ? 'error' : 'unavailable'); assert.equal(result.summary, null); assert(!JSON.stringify(result).includes(marker)); assert.equal(h.calls.length, 2);
  }
  const result = await get(harness({ read: async () => { throw Error(marker); } })); assert.equal(result.status, 'error'); assert(!JSON.stringify(result).includes(marker));
});
test('shared deadline releases a hanging connection lookup without starting an ESI read', async () => {
  const h = harness({ connect: deadline => new Promise(() => { queueMicrotask(() => deadline.abort()); }) });
  const result = await get(h); assert.equal(result.status, 'unavailable'); assert.equal(h.calls.length, 1); assert.equal(result.summary, null);
});
test('shared deadline releases an uncooperative reader and external cancellation returns no late data', async () => {
  const h = harness({ read: async (_entity, _input, _signal, _EveError, deadline) => new Promise(() => { queueMicrotask(() => deadline.abort()); }) });
  const result = await get(h); assert.equal(result.status, 'unavailable'); assert.equal(result.summary, null); assert.equal(h.calls.length, 2);
  const controller = new AbortController(), other = harness({ read: async (entity, input) => { controller.abort(); return envelope(entity, input); } });
  const cancelled = await get(other, args, { signal: controller.signal }); assert.equal(cancelled.status, 'unavailable'); assert.equal(cancelled.summary, null);
});
test('pre-cancelled requests do not read connection metadata', async () => {
  const controller = new AbortController(); controller.abort(); const h = harness(); await assert.rejects(get(h, args, { signal: controller.signal })); assert.equal(h.calls.length, 0);
});
test('independent requests replace their summaries without retaining earlier account data', async () => {
  let sequence = 0;
  const h = harness({ read: async (entity, input) => envelope(entity, input, sequence++ ? [] : [job()]) });
  const first = await get(h), second = await get(h);
  assert.equal(first.summary.jobs, 1); assert.equal(second.summary.jobs, 0); assert.equal(second.jobs.length, 0); assert.equal(h.calls.length, 4);
});
