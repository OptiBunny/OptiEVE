import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const compile = name => ts.transpileModule(readFileSync(`app/lib/${name}.ts`, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const summaryCode = compile('overview-summary'), serviceCode = compile('overview');
const now = Date.parse('2026-01-01T00:00:00Z');
const stamp = new Date(now).toISOString();
const scopes = {
  wallet_balance: 'esi-wallet.read_character_wallet.v1', skill_queue: 'esi-skills.read_skillqueue.v1', orders: 'esi-markets.read_character_orders.v1',
  industry_jobs: 'esi-industry.read_character_jobs.v1', contracts: 'esi-contracts.read_character_contracts.v1', freelance_jobs: 'esi-characters.read_freelance_jobs.v1',
};
const corpScopes = ['esi-wallet.read_corporation_wallets.v1', 'esi-contracts.read_corporation_contracts.v1', 'esi-industry.read_corporation_jobs.v1', 'esi-corporations.read_projects.v1', 'esi-industry.read_corporation_mining.v1', 'esi-corporations.read_freelance_jobs.v1'];
const personalArgs = { characterId: 90000001, view: 'personal' };
const corporationArgs = { ...personalArgs, view: 'corporation' };
const connection = () => ({ characterId: 90000001, scopes: [...Object.values(scopes), ...corpScopes] });
const plain = value => JSON.parse(JSON.stringify(value));
function load(code, context = {}) {
  const fixtureModule = { exports: {} };
  vm.runInNewContext(code, { module: fixtureModule, exports: fixtureModule.exports, Date, URL, AbortSignal, ...context });
  return fixtureModule.exports;
}
const summary = load(summaryCode);
function harness(options = {}) {
  class EveError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
  const calls = [], deadline = new AbortController();
  const deps = {
    connections: async user => { calls.push({ operation: 'connections', user }); return options.connections ?? [connection()]; },
    character: async (user, args, signal) => { calls.push({ operation: 'character', user, args, signal }); return options.character ? options.character(user, args, signal, EveError, deadline) : response(args); },
    corporation: async (user, args, signal) => { calls.push({ operation: 'corporation', user, args, signal }); return options.corporation ? options.corporation(user, args, signal, EveError, deadline) : response(args, true); },
    now: () => now,
  };
  const service = load(serviceCode, { require: path => path === './overview-summary' ? summary : { EveError, listConnections: deps.connections, readCharacterData: deps.character, readCorporationData: deps.corporation }, AbortSignal: { any: AbortSignal.any.bind(AbortSignal), timeout: milliseconds => { assert.equal(milliseconds, 55000); return deadline.signal; } } });
  return { ...service, read: service.createOverviewReader(deps), calls, EveError, deadline };
}
function response(args, corporation = false) {
  return { characterId: args.characterId, dataset: args.dataset, ...(corporation ? { corporationId: 98000001 } : {}), data: args.dataset === 'wallet_balance' ? 123.45 : args.dataset === 'projects' ? { projects: [] } : args.dataset === 'freelance_jobs' ? { freelance_jobs: [] } : [], retrievedAt: stamp, cacheExpires: 'Thu, 01 Jan 2026 00:05:00 GMT', cacheControl: 'private, max-age=300', lastModified: 'Wed, 31 Dec 2025 23:55:00 GMT', pagination: { kind: args.dataset === 'projects' || corporation && args.dataset === 'freelance_jobs' ? 'cursor' : args.dataset === 'contracts' || args.dataset === 'mining_extractions' || corporation && args.dataset === 'industry_jobs' ? 'page' : 'none', page: 1, pages: 1 } };
}
function metric(result, label) { return result.metrics.find(item => item.label === label)?.value; }
const extraction = (id = 1001, override = {}) => ({ structure_id: id, moon_id: 40000001, extraction_start_time: '2025-12-31T00:00:00Z', chunk_arrival_time: '2026-01-02T00:00:00Z', natural_decay_time: '2026-01-04T00:00:00Z', private_marker: 'OMIT_PRIVATE_FIELDS', ...override });
const freelance = (override = {}) => ({ id: 'abcdef00-0000-0000-0000-000000000001', name: 'Synthetic freelance job', state: 'Active', last_modified: stamp, progress: { current: 3, desired: 20 }, reward: { initial: 1000, remaining: 800 }, creator: { id: 90009999 }, description: 'OMIT_PRIVATE_FIELDS', ...override });

test('new overview cards use one granted feed each without details or participant reads', async () => {
  for (const [view, scope, dataset, sectionId, parameters] of [
    ['personal', 'esi-characters.read_freelance_jobs.v1', 'freelance_jobs', 'freelance', undefined],
    ['corporation', 'esi-corporations.read_freelance_jobs.v1', 'freelance_jobs', 'freelance', { limit: 100 }],
    ['corporation', 'esi-industry.read_corporation_mining.v1', 'mining_extractions', 'extractions', { page: 1 }],
  ]) {
    const h = harness({ connections: [{ ...connection(), scopes: [scope] }] });
    const result = await h.read('synthetic-owner', { ...personalArgs, view });
    assert.equal(h.calls.length, 2); assert.equal(h.calls[1].args.dataset, dataset);
    assert.deepEqual(h.calls[1].args.parameters === undefined ? undefined : plain(h.calls[1].args.parameters), parameters);
    assert.equal(result.sections.find(row => row.id === sectionId).status, view === 'corporation' && dataset === 'freelance_jobs' ? 'partial' : 'ready');
    assert(result.sections.filter(row => row.id !== sectionId).every(row => row.status === 'needs_permission'));
  }
});

test('extraction schedule summaries distinguish arrival and natural fracture without ore claims', () => {
  const result = summary.summarizeOverview('extractions', [extraction(), extraction(1002, { extraction_start_time: '2026-01-02T00:00:00Z' }), extraction(1003, { chunk_arrival_time: stamp }), extraction(1004, { chunk_arrival_time: '2025-12-31T01:00:00Z', natural_decay_time: stamp })], now, false);
  assert.equal(metric(result, 'Extractions in this page'), 4);
  assert.equal(metric(result, 'Starts still pending'), 1); assert.equal(metric(result, 'Arrivals still pending'), 1);
  assert.equal(metric(result, 'Arrival passed before natural fracture'), 1); assert.equal(metric(result, 'Natural fracture time passed'), 1);
  assert.equal(metric(result, 'Next scheduled chunk arrival (UTC)'), '2026-01-02T00:00:00.000Z');
  assert.match(result.message, /automatic fracture/); assert.match(result.message, /Neither timestamp proves ore/);
  assert(!JSON.stringify(result).includes('OMIT_PRIVATE_FIELDS')); assert(!JSON.stringify(result).includes('40000001'));
  assert.equal(metric(summary.summarizeOverview('extractions', [], now, false), 'Next scheduled chunk arrival (UTC)'), undefined);
});

test('malformed extraction identities, duplicate rows and impossible schedules are rejected', () => {
  for (const override of [{ structure_id: 0 }, { moon_id: '40000001' }, { moon_id: Number.MAX_SAFE_INTEGER + 1 }, { extraction_start_time: '2026-02-30T00:00:00Z' }, { chunk_arrival_time: '2025-12-30T00:00:00Z' }, { natural_decay_time: '2026-01-01T00:00:00Z' }, { natural_decay_time: null }, { natural_decay_time: '2026-01-04T00:00:00' }]) assert.throws(() => summary.summarizeOverview('extractions', [extraction(1001, override)], now, false));
  for (const data of [null, {}, [extraction(), extraction()], Array.from({ length: 10001 }, (_, i) => extraction(i + 1))]) assert.throws(() => summary.summarizeOverview('extractions', data, now, false));
});

test('freelance summaries use provider states and reported reward budgets without adding objective units', () => {
  const data = { freelance_jobs: [freelance(), freelance({ id: 'abcdef00-0000-0000-0000-000000000002', state: 'Completed', reward: undefined, progress: { current: 100, desired: 0 } })] };
  for (const personal of [true, false]) {
    const result = summary.summarizeOverview('freelance', data, now, personal);
    assert.equal(metric(result, personal ? 'Participated jobs returned' : 'Freelance jobs in this batch'), 2);
    assert.equal(metric(result, 'Active jobs returned'), 1); assert.equal(metric(result, 'Completed jobs returned'), 1);
    assert.equal(metric(result, 'Jobs with reported reward reserves'), 1); assert.equal(metric(result, 'Remaining reserve for jobs reporting rewards'), 800);
    assert.match(result.message, /not earned, claimable or paid rewards or profit/); assert.match(result.message, /different objectives are not added together/);
    assert(!JSON.stringify(result).includes('Synthetic freelance')); assert(!JSON.stringify(result).includes('OMIT_PRIVATE_FIELDS')); assert(!JSON.stringify(result).includes('90009999'));
  }
  const unavailable = summary.summarizeOverview('freelance', { freelance_jobs: [freelance({ reward: undefined })] }, now);
  assert.equal(metric(unavailable, 'Remaining reserve for jobs reporting rewards'), undefined);
  const empty = summary.summarizeOverview('freelance', { freelance_jobs: [] }, now);
  assert.equal(metric(empty, 'Participated jobs returned'), 0); assert.equal(metric(empty, 'Remaining reserve for jobs reporting rewards'), undefined);
});

test('malformed freelance fields and unbounded batches never become counts or rewards', () => {
  for (const override of [{ id: 'not-a-uuid' }, { name: '' }, { name: '\u0000' }, { state: 'FutureState' }, { last_modified: '2026-02-30T00:00:00Z' }, { progress: { current: -1, desired: 20 } }, { progress: { current: 1.5, desired: 20 } }, { progress: { current: 1 } }, { reward: {} }, { reward: { initial: 1, remaining: -1 } }, { reward: { initial: Infinity, remaining: 1 } }, { reward: null }]) assert.throws(() => summary.summarizeOverview('freelance', { freelance_jobs: [freelance(override)] }, now));
  assert.throws(() => summary.summarizeOverview('freelance', { freelance_jobs: [freelance(), freelance({ id: freelance().id.toUpperCase() })] }, now));
  const batch = { freelance_jobs: Array.from({ length: 101 }, (_, i) => freelance({ id: `abcdef00-0000-0000-0000-${String(i).padStart(12, '0')}` })) };
  assert.throws(() => summary.summarizeOverview('freelance', batch, now, false));
  assert.equal(metric(summary.summarizeOverview('freelance', batch, now, true), 'Participated jobs returned'), 101);
});

test('new overview pagination metadata must match the requested feed before metrics are emitted', async () => {
  for (const [view, dataset, pagination] of [
    ['personal', 'freelance_jobs', { kind: 'cursor' }], ['corporation', 'freelance_jobs', { kind: 'none' }],
    ['corporation', 'freelance_jobs', { kind: 'cursor', after: 'two words' }], ['corporation', 'freelance_jobs', { kind: 'cursor', before: 1 }],
    ['corporation', 'mining_extractions', { kind: 'page', page: 2, pages: 2 }], ['corporation', 'mining_extractions', { kind: 'page', page: 1, pages: -1 }],
    ['corporation', 'mining_extractions', { kind: 'page', page: 1, pages: 1, nextPage: 2 }], ['corporation', 'mining_extractions', null],
  ]) {
    const reader = async (_user, args) => ({ ...response(args, view === 'corporation'), ...(args.dataset === dataset ? { pagination } : {}) });
    const result = await harness({ character: reader, corporation: reader }).read('synthetic-owner', { ...personalArgs, view });
    const section = result.sections.find(row => row.id === (dataset === 'mining_extractions' ? 'extractions' : 'freelance'));
    assert.equal(section.status, 'error'); assert.equal(section.metrics.length, 0);
  }
});

test('corporation change at a new overview card discards all previous corporation metrics', async () => {
  const h = harness({ corporation: async (_user, args) => ({ ...response(args, true), ...(args.dataset === 'mining_extractions' ? { corporationId: 98000002 } : {}) }) });
  const result = await h.read('synthetic-owner', corporationArgs);
  assert.equal(h.calls.length, 6); assert.equal(result.corporationId, undefined); assert(result.sections.every(row => row.status === 'unavailable' && !row.metrics.length));
  assert(!h.calls.some(call => call.args?.dataset === 'freelance_jobs'));
});

test('overview argument errors do not read connection storage or ESI', async () => {
  for (const input of [null, [], {}, { ...personalArgs, extra: true }, { ...personalArgs, characterId: '90000001' }, { ...personalArgs, characterId: -1 }, { ...personalArgs, characterId: Number.MAX_SAFE_INTEGER + 1 }, { ...personalArgs, view: ['personal'] }, { ...personalArgs, view: {} }, { ...personalArgs, view: 1 }, { ...personalArgs, view: 'constructor' }, { ...personalArgs, view: null }, Object.create(personalArgs)]) {
    const h = harness(); await assert.rejects(h.read('synthetic-owner', input), error => error.status === 400); assert.equal(h.calls.length, 0);
  }
});
test('an unconnected or another owner’s character cannot be summarized', async () => {
  const h = harness({ connections: [] });
  await assert.rejects(h.read('synthetic-owner', personalArgs), error => error.status === 404);
  assert.equal(h.calls.length, 1);
});
test('missing scopes skip every corresponding ESI request and never show zero totals', async () => {
  const h = harness({ connections: [{ ...connection(), scopes: [] }] });
  const result = await h.read('synthetic-owner', personalArgs);
  assert.equal(h.calls.length, 1);
  assert.equal(result.sections.length, 6);
  for (const section of result.sections) { assert.equal(section.status, 'needs_permission'); assert.equal(section.metrics.length, 0); assert.equal(section.retrievedAt, null); }
});
test('the overview reads only selected datasets and one selected character, sequentially', async () => {
  let active = 0, maximum = 0;
  const h = harness({ character: async (_user, args) => { active++; maximum = Math.max(maximum, active); await Promise.resolve(); active--; return response(args); } });
  const result = await h.read('synthetic-owner', personalArgs);
  assert.equal(maximum, 1);
  assert.equal(result.sections.length, 6);
  assert.deepEqual(h.calls.slice(1).map(call => call.args.dataset), ['wallet_balance', 'skill_queue', 'orders', 'industry_jobs', 'contracts', 'freelance_jobs']);
  assert(h.calls.every(call => call.user === 'synthetic-owner'));
  assert(h.calls.slice(1).every(call => call.args.characterId === 90000001 && call.signal instanceof AbortSignal));
  assert.deepEqual(plain(h.calls[4].args.parameters), { includeCompleted: false });
});
test('one granted dataset does not trigger other private reads', async () => {
  const h = harness({ connections: [{ ...connection(), scopes: [scopes.wallet_balance] }] });
  const result = await h.read('synthetic-owner', personalArgs);
  assert.equal(h.calls.length, 2); assert.equal(result.sections[0].status, 'ready'); assert.equal(result.sections[1].status, 'needs_permission');
});
test('safe freshness metadata is retained without arbitrary upstream header text', async () => {
  const h = harness({ character: async (_user, args) => ({ ...response(args), cacheControl: 'private, max-age=300, arbitrary-provider-detail, no-store' }) });
  const result = await h.read('synthetic-owner', personalArgs), section = result.sections[0];
  assert.equal(section.retrievedAt, stamp); assert.equal(section.cacheExpires, '2026-01-01T00:05:00.000Z');
  assert.equal(section.lastModified, '2025-12-31T23:55:00.000Z'); assert.equal(section.cacheControl, 'private, max-age=300, no-store');
  assert(!JSON.stringify(result).includes('arbitrary-provider-detail'));
});
test('missing numbered-page counts remain unknown even for an empty response', async () => {
  const h = harness({ character: async (_user, args) => ({ ...response(args), ...(args.dataset === 'contracts' ? { pagination: { kind: 'page', page: 1, pages: null } } : {}) }) });
  const section = (await h.read('synthetic-owner', personalArgs)).sections[4];
  assert.equal(section.coverage, 'unknown'); assert.equal(section.status, 'partial'); assert.match(section.message, /completeness is unknown/);
});
test('first-page figures never claim full coverage when more pages exist', async () => {
  const h = harness({ character: async (_user, args) => ({ ...response(args), ...(args.dataset === 'contracts' ? { pagination: { kind: 'page', page: 1, pages: 8 } } : {}) }) });
  const section = (await h.read('synthetic-owner', personalArgs)).sections[4];
  assert.equal(section.coverage, 'partial'); assert.match(section.message, /page 1 of 8/);
});
test('corrupt summaries fail the affected section without fabricated totals', async () => {
  const h = harness({ character: async (_user, args) => ({ ...response(args), ...(args.dataset === 'wallet_balance' ? { data: NaN } : {}) }) });
  const result = await h.read('synthetic-owner', personalArgs);
  assert.equal(result.sections[0].status, 'error'); assert.equal(result.sections[0].metrics.length, 0);
  assert.equal(result.sections[1].status, 'ready'); assert.equal(h.calls.length, 7);
});
test('denied role or scope is unavailable and does not imply an empty dataset', async () => {
  const h = harness({ character: async (_user, args, _signal, EveError) => { if (args.dataset === 'wallet_balance') throw new EveError('untrusted provider detail', 403); return response(args); } });
  const result = await h.read('synthetic-owner', personalArgs);
  assert.equal(result.sections[0].status, 'unavailable'); assert.equal(result.sections[0].metrics.length, 0); assert.equal(result.sections[1].status, 'ready');
  assert(!JSON.stringify(result).includes('untrusted provider detail'));
});
for (const status of [401, 404, 409, 429]) test(`status ${status} stops all later ESI reads without retry`, async () => {
  const h = harness({ character: async (_user, _args, _signal, EveError) => { throw new EveError('untrusted provider detail', status); } });
  const result = await h.read('synthetic-owner', personalArgs);
  assert.equal(h.calls.length, 2); assert(result.sections.every(section => section.status === 'unavailable' && section.metrics.length === 0));
  assert(!JSON.stringify(result).includes('untrusted provider detail'));
});
test('unexpected exceptions never expose provider text or raw records', async () => {
  const h = harness({ character: async () => { throw new Error('synthetic confidential provider detail'); } });
  const result = await h.read('synthetic-owner', personalArgs);
  assert(!JSON.stringify(result).includes('confidential')); assert(result.sections.every(section => section.status === 'error'));
});
test('corporation overviews use current response identity and only four useful reads', async () => {
  const h = harness(); const result = await h.read('synthetic-owner', corporationArgs);
  assert.equal(result.corporationId, 98000001); assert.equal(result.sections.length, 6);
  assert.deepEqual(h.calls.slice(1).map(call => [call.operation, call.args.dataset]), [['corporation', 'wallet_balances'], ['corporation', 'contracts'], ['corporation', 'industry_jobs'], ['corporation', 'projects'], ['corporation', 'mining_extractions'], ['corporation', 'freelance_jobs']]);
  assert.deepEqual(plain(h.calls[4].args.parameters), { limit: 100, state: 'Active' });
  assert.equal(result.sections[3].coverage, 'unknown');
});
test('a changed corporation discards all previous section values and stops later reads', async () => {
  const h = harness({ corporation: async (_user, args) => ({ ...response(args, true), corporationId: args.dataset === 'contracts' ? 98000001 : 98000002 }) });
  const result = await h.read('synthetic-owner', corporationArgs);
  assert.equal(h.calls.length, 3); assert.equal(result.corporationId, undefined);
  assert(result.sections.every(section => section.status === 'unavailable' && section.metrics.length === 0 && section.retrievedAt === null));
});
test('already-aborted callers never read storage or ESI', async () => {
  const h = harness(), controller = new AbortController(); controller.abort();
  await assert.rejects(h.read('synthetic-owner', personalArgs, { signal: controller.signal })); assert.equal(h.calls.length, 0);
});
test('caller cancellation aborts the in-flight signal and prevents later datasets', async () => {
  const controller = new AbortController();
  const h = harness({ character: async (_user, _args, signal) => { controller.abort(); signal.throwIfAborted(); } });
  const result = await h.read('synthetic-owner', personalArgs, { signal: controller.signal });
  assert.equal(h.calls.length, 2); assert(result.sections.every(section => section.status === 'unavailable')); assert(h.calls[1].signal.aborted);
});
test('the overall deadline is passed to upstream reads and stops the request chain', async () => {
  const h = harness({ character: async (_user, _args, signal, _EveError, deadline) => { deadline.abort(); signal.throwIfAborted(); } });
  const result = await h.read('synthetic-owner', personalArgs);
  assert.equal(h.calls.length, 2); assert(result.sections.every(section => section.status === 'unavailable')); assert(h.calls[1].signal.aborted);
});
test('cancelled successful responses are discarded before any summary is returned', async () => {
  const h = harness({ character: async (_user, args, _signal, _EveError, deadline) => { deadline.abort(); return response(args); } });
  const result = await h.read('synthetic-owner', personalArgs);
  assert(result.sections.every(section => section.metrics.length === 0)); assert.equal(h.calls.length, 2);
});
test('unexpected result identity, dataset, or timestamp fails closed', async () => {
  for (const override of [{ characterId: 90000002 }, { dataset: 'mail' }, { retrievedAt: '2026-02-30T00:00:00Z' }]) {
    const h = harness({ character: async (_user, args) => ({ ...response(args), ...override }) });
    assert((await h.read('synthetic-owner', personalArgs)).sections.every(section => section.status === 'error' && section.metrics.length === 0));
  }
});

test('wallet amounts preserve negative balances but reject nonfinite and unsafe values', () => {
  assert.equal(metric(summary.summarizeOverview('wallet', -10.25, now), 'Wallet balance'), -10.25);
  for (const value of [NaN, Infinity, -Infinity, '10', {}, Number.MAX_VALUE]) assert.throws(() => summary.summarizeOverview('wallet', value, now));
});
test('corporation wallet overview distinguishes all seven divisions from partial balances', async () => {
  const divisions = Array.from({ length: 7 }, (_, index) => ({ division: index + 1, balance: index === 0 ? -1 : 10 }));
  const complete = summary.summarizeOverview('wallet', divisions, now, false);
  assert.equal(metric(complete, 'Balance across all seven divisions'), 59); assert.equal(complete.partial, false);
  const partial = summary.summarizeOverview('wallet', divisions.slice(0, 2), now, false);
  assert.equal(metric(partial, 'Balance of returned divisions'), 9); assert.equal(metric(partial, 'Balance across all seven divisions'), undefined); assert.equal(partial.partial, true);
  const empty = summary.summarizeOverview('wallet', [], now, false);
  assert.equal(empty.metrics.length, 1); assert.equal(metric(empty, 'Wallet divisions returned'), 0); assert.equal(empty.partial, true);
  const h = harness(); const wallet = (await h.read('synthetic-owner', corporationArgs)).sections[0];
  assert.equal(wallet.coverage, 'partial'); assert.equal(wallet.status, 'partial'); assert.match(wallet.message, /Missing divisions are unavailable, not zero/);
});
test('corporation wallet malformed, duplicated and overflowing divisions do not form balances', () => {
  for (const data of [[{ division: 0, balance: 1 }], [{ division: 8, balance: 1 }], [{ division: 1, balance: NaN }], [{ division: 1, balance: 1 }, { division: 1, balance: 2 }], [{ division: 1, balance: Number.MAX_SAFE_INTEGER / 100 }, { division: 2, balance: 1 }]]) assert.throws(() => summary.summarizeOverview('wallet', data, now, false));
});
test('corporation wallet needs its existing finance scope, never a new role or automatic grant', async () => {
  const h = harness({ connections: [{ ...connection(), scopes: corpScopes.filter(scope => !scope.includes('wallet')) }] });
  const result = await h.read('synthetic-owner', corporationArgs);
  assert.equal(result.sections[0].status, 'needs_permission'); assert.equal(result.sections[0].metrics.length, 0);
  assert(!h.calls.some(call => call.args?.dataset === 'wallet_balances'));
});
test('date parsing requires a real RFC3339 instant, including valid offsets', () => {
  assert.equal(summary.overviewDate('2026-01-01T02:00:00+02:00'), stamp);
  assert.equal(summary.overviewDate('2026-01-01T00:00:00.123456Z'), '2026-01-01T00:00:00.123Z');
  for (const value of ['2026-02-30T00:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01', '2026-01-01T00:00:00', '2026-01-01T00:00:00+25:00', '<script>', null]) assert.equal(summary.overviewDate(value), null);
});
test('training sorts positions, separates elapsed schedules, and does not invent a paused horizon', () => {
  const data = [{ queue_position: 2, skill_id: 1003, finished_level: 3, finish_date: null }, { queue_position: 1, skill_id: 1002, finished_level: 2, finish_date: '2026-01-02T00:00:00Z' }, { queue_position: 0, skill_id: 1001, finished_level: 1, finish_date: '2025-12-31T00:00:00Z' }];
  const result = summary.summarizeOverview('training', data, now);
  assert.equal(metric(result, 'Queue entries returned'), 3); assert.equal(metric(result, 'Finished by schedule'), 1); assert.equal(metric(result, 'Entries without an end time'), 1);
  assert.equal(metric(result, 'Next scheduled completion'), '2026-01-02T00:00:00.000Z'); assert.equal(metric(result, 'Last scheduled completion'), undefined);
});
test('valid complete schedules show a finite last completion', () => {
  const result = summary.summarizeOverview('training', [{ queue_position: 0, skill_id: 1001, finished_level: 1, start_date: stamp, finish_date: '2026-01-02T00:00:00Z' }], now);
  assert.equal(metric(result, 'Last scheduled completion'), '2026-01-02T00:00:00.000Z');
});
test('duplicate queue positions and reversed dates cannot inflate training counts', () => {
  const row = { queue_position: 0, skill_id: 1001, finished_level: 1, start_date: '2026-01-02T00:00:00Z', finish_date: stamp };
  assert.throws(() => summary.summarizeOverview('training', [row], now));
  const valid = { ...row, start_date: stamp }; assert.throws(() => summary.summarizeOverview('training', [valid, valid], now));
});
const order = (overrides = {}) => ({ order_id: 1001, is_corporation: false, is_buy_order: false, price: 10, volume_remain: 5, volume_total: 10, duration: 30, issued: '2025-12-20T00:00:00Z', ...overrides });
test('orders separate bid, ask and escrow, excluding corporation holdings', () => {
  const result = summary.summarizeOverview('orders', [order(), order({ order_id: 1002, is_buy_order: true, escrow: 25 }), order({ order_id: 1003, is_corporation: true, price: 9999 })], now);
  assert.equal(metric(result, 'Personal buy orders'), 1); assert.equal(metric(result, 'Personal sell orders'), 1);
  assert.equal(metric(result, 'Remaining sell asking value'), 50); assert.equal(metric(result, 'Remaining buy bid value'), 50); assert.equal(metric(result, 'Buy-order escrow'), 25); assert.equal(metric(result, 'Corporation orders excluded'), 1);
});
test('missing escrow is unavailable rather than zero and expired rows are identified', () => {
  const result = summary.summarizeOverview('orders', [order({ is_buy_order: true, issued: '2025-01-01T00:00:00Z' })], now);
  assert.equal(metric(result, 'Buy-order escrow'), undefined); assert.equal(metric(result, 'Past stated expiry'), 1); assert.match(result.message, /Escrow is unavailable/);
});
test('malformed orders, duplicate IDs and overflowing arithmetic cannot form totals', () => {
  for (const invalid of [order({ price: -1 }), order({ volume_remain: 11 }), order({ is_corporation: undefined }), order({ is_buy_order: 'yes' }), order({ escrow: NaN }), order({ issued: '2026-02-30T00:00:00Z' }), order({ price: 1e13, volume_remain: 10 })]) assert.throws(() => summary.summarizeOverview('orders', [invalid], now));
  assert.throws(() => summary.summarizeOverview('orders', [order(), order()], now));
});
test('industry distinguishes ready jobs from active jobs past the scheduled end', () => {
  const data = [{ job_id: 1, status: 'ready', end_date: stamp }, { job_id: 2, status: 'active', end_date: stamp }, { job_id: 3, status: 'active', end_date: '2026-01-02T00:00:00Z' }, { job_id: 4, status: 'paused', end_date: stamp }];
  const result = summary.summarizeOverview('industry', data, now);
  assert.equal(metric(result, 'Ready according to EVE'), 1); assert.equal(metric(result, 'Active past scheduled end'), 1); assert.equal(metric(result, 'Running by schedule'), 1); assert.equal(metric(result, 'Paused jobs'), 1);
});
test('unknown industry statuses and dates do not become zeros', () => {
  assert.throws(() => summary.summarizeOverview('industry', [{ job_id: 1, status: 'unexpected', end_date: stamp }], now));
  assert.throws(() => summary.summarizeOverview('industry', [{ job_id: 1, status: 'active', end_date: null }], now));
});
test('contracts use offer expiry only for outstanding offers, never as courier delivery deadline', () => {
  const data = [{ contract_id: 1, status: 'outstanding', date_expired: '2026-01-01T12:00:00Z' }, { contract_id: 2, status: 'outstanding', date_expired: stamp }, { contract_id: 3, status: 'in_progress', date_expired: '2025-01-01T00:00:00Z' }];
  const result = summary.summarizeOverview('contracts', data, now);
  assert.equal(metric(result, 'Outstanding before expiry'), 1); assert.equal(metric(result, 'Outstanding expiring within 24h'), 1); assert.equal(metric(result, 'Outstanding past stated expiry'), 1); assert.equal(metric(result, 'In progress'), 1);
  assert.match(result.message, /not an accepted courier/);
});
test('project counts expose no project names, descriptions, progress or contributor data', () => {
  const result = summary.summarizeOverview('projects', { projects: [{ id: '00000000-0000-0000-0000-000000000001', state: 'Active', name: '<script>synthetic title</script>', progress: { synthetic: 1 } }], cursor: { after: 'synthetic-cursor' } }, now);
  assert.equal(metric(result, 'Projects in this batch'), 1); assert.equal(metric(result, 'Active projects in batch'), 1);
  assert(!JSON.stringify(result).includes('synthetic')); assert(!JSON.stringify(result).includes('<script>'));
});
test('project response shapes and repeated identifiers fail safely', () => {
  const row = { id: '00000000-0000-0000-0000-000000000001', state: 'Active' };
  for (const data of [[], { projects: {} }, { projects: [row, row] }, { projects: [{ ...row, state: 'unknown' }] }]) assert.throws(() => summary.summarizeOverview('projects', data, now));
  const caseVariant = { ...row, id: 'abcdef00-0000-0000-0000-000000000001' };
  assert.throws(() => summary.summarizeOverview('projects', { projects: [caseVariant, { ...caseVariant, id: caseVariant.id.toUpperCase() }] }, now));
});

test('orders with omitted side remain unknown and are excluded from side-specific values', () => {
  const result = summary.summarizeOverview('orders', [order({ is_buy_order: undefined, price: 999 }), order({ order_id: 1002 }), order({ order_id: 1003, is_buy_order: true })], now);
  assert.equal(metric(result, 'Personal orders with unknown side'), 1);
  assert.equal(metric(result, 'Personal sell orders'), 1); assert.equal(metric(result, 'Personal buy orders'), 1);
  assert.equal(metric(result, 'Remaining sell asking value'), 50); assert.equal(metric(result, 'Remaining buy bid value'), 50);
  assert.equal(result.partial, true); assert.match(result.message, /omit their side/);
});
test('excluded corporation orders do not create unknown-side personal coverage', () => {
  const result = summary.summarizeOverview('orders', [order(), order({ order_id: 1002, is_corporation: true, is_buy_order: undefined })], now);
  assert.equal(metric(result, 'Personal orders with unknown side'), undefined);
  assert.equal(result.partial, undefined); assert.equal(metric(result, 'Corporation orders excluded'), 1);
});
