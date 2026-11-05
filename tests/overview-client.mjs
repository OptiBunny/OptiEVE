import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const compile = file => ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const connectionCode = compile('app/lib/connection-client.ts'), overviewCode = compile('app/lib/overview-client.ts');
function harness(fetch = () => { throw Error('Unexpected request'); }, timers = {}) {
  const connection = { exports: {} }, overview = { exports: {} };
  const context = { URL, AbortController, setTimeout, clearTimeout, fetch, ...timers };
  vm.runInNewContext(connectionCode, { ...context, module: connection, exports: connection.exports });
  vm.runInNewContext(overviewCode, { ...context, module: overview, exports: overview.exports, require: () => connection.exports });
  return overview.exports;
}
const args = { characterId: 90000001, view: 'personal' };
const date = '2026-01-01T00:00:00Z';
function fixture() {
  return { ...args, generatedAt: date, coverage: 'One synthetic character.', sections: ['wallet', 'training', 'orders', 'industry', 'contracts', 'freelance'].map(id => ({
    id, title: id, status: 'ready', message: 'Synthetic fixture.', scope: 'esi-fixture.read.v1', metrics: [{ label: 'Count', value: 0, unit: 'count' }],
    retrievedAt: date, cacheExpires: null, lastModified: null, cacheControl: null, coverage: 'complete',
  })) };
}
test('overview validates owner selection and allows legitimate zero values', () => {
  const value = fixture(); assert.equal(harness().overviewResponse(value, args), value);
});
test('corporation overview requires wallet, extraction and freelance sections alongside operations', () => {
  const selected = { ...args, view: 'corporation' }, value = { ...fixture(), ...selected };
  value.sections = ['wallet', 'contracts', 'industry', 'projects', 'extractions', 'freelance'].map(id => ({ ...fixture().sections[0], id }));
  assert.equal(harness().overviewResponse(value, selected), value);
  value.sections.shift(); assert.throws(() => harness().overviewResponse(value, selected), /incomplete response/);
});

test('personal freelance coverage stays separate from corporation extraction schedules', () => {
  const value = fixture();
  value.sections[5].coverage = 'unknown';
  value.sections[5].message = 'Only the selected character’s returned active freelance participation is covered.';
  assert.equal(harness().overviewResponse(value, args), value);
  value.sections[5].id = 'extractions';
  assert.throws(() => harness().overviewResponse(value, args), /incomplete response/);
});

test('new corporation sections allow missing permission without inventing metrics', () => {
  const selected = { ...args, view: 'corporation' }, value = { ...fixture(), ...selected };
  value.sections = ['wallet', 'contracts', 'industry', 'projects', 'extractions', 'freelance'].map(id => ({ ...fixture().sections[0], id }));
  for (const section of value.sections.slice(4)) Object.assign(section, {
    status: 'needs_permission', coverage: 'unavailable', metrics: [], retrievedAt: null,
    message: 'Choose this optional read permission and authorize a character with the required corporation role.',
  });
  assert.equal(harness().overviewResponse(value, selected), value);
  value.sections[5].id = 'orders';
  assert.throws(() => harness().overviewResponse(value, selected), /incomplete response/);
});
for (const [name, mutate] of [
  ['wrong character', value => { value.characterId++; }],
  ['wrong workspace', value => { value.view = 'corporation'; }],
  ['missing section', value => { value.sections.pop(); }],
  ['duplicate section', value => { value.sections[0] = value.sections[1]; }],
  ['unknown section', value => { value.sections[0].id = '__proto__'; }],
  ['invalid timestamp', value => { value.generatedAt = 'invalid'; }],
  ['invalid corporation', value => { value.corporationId = -1; }],
  ['unknown status', value => { value.sections[0].status = 'constructor'; }],
  ['coerced status', value => { value.sections[0].status = ['ready']; }],
  ['coerced section ID', value => { value.sections[0].id = ['wallet']; }],
  ['coerced coverage', value => { value.sections[0].coverage = ['complete']; }],
  ['coerced unit', value => { value.sections[0].metrics[0].unit = ['ISK']; }],
  ['non-finite amount', value => { value.sections[0].metrics[0] = { label: 'Cash', value: Infinity, unit: 'ISK' }; }],
  ['string money', value => { value.sections[0].metrics[0] = { label: 'Cash', value: '100', unit: 'ISK' }; }],
  ['negative count', value => { value.sections[0].metrics[0].value = -1; }],
  ['invalid date metric', value => { value.sections[0].metrics[0] = { label: 'Time', value: 'invalid', unit: 'datetime' }; }],
  ['unbounded text', value => { value.sections[0].message = 'x'.repeat(2049); }],
]) test(`overview rejects ${name}`, () => {
  const value = fixture(); mutate(value); assert.throws(() => harness().overviewResponse(value, args), /incomplete response/);
});
test('overview reads use POST body, no-store and an abort signal', async () => {
  let calls = 0;
  const client = harness(async (url, init) => {
    calls++; assert.equal(url, '/api/eve/overview'); assert.equal(init.method, 'POST'); assert.equal(init.cache, 'no-store');
    assert.deepEqual(JSON.parse(init.body), args); assert.ok(init.signal instanceof AbortSignal);
    return Response.json(fixture());
  });
  const result = await client.overviewRequest(args, new AbortController().signal);
  assert.equal(result.characterId, args.characterId); assert.equal(calls, 1);
});
test('gateway authentication errors are actionable without exposing HTML', async () => {
  const client = harness(async () => new Response('<html>synthetic gateway details</html>', { status: 401 }));
  await assert.rejects(client.overviewRequest(args, new AbortController().signal), error => error.status === 401 && /Sign in/.test(error.message) && !/synthetic/.test(error.message));
});

test('signed-out overview responses release the unread body', async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const client = harness(async () => new Response(body, { status: 401 }));
  await assert.rejects(client.overviewRequest(args, new AbortController().signal), error => error.status === 401);
  assert.equal(cancelled, true);
});
test('invalid JSON never becomes a raw upstream error', async () => {
  const client = harness(async () => new Response('synthetic private upstream text', { status: 502 }));
  await assert.rejects(client.overviewRequest(args, new AbortController().signal), error => /unreadable/.test(error.message) && !/synthetic/.test(error.message));
});
test('caller cancellation aborts the in-flight fetch', async () => {
  const controller = new AbortController();
  const client = harness((url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Error('private request details'))); controller.abort();
  }));
  await assert.rejects(client.overviewRequest(args, controller.signal), /cancelled/);
});
test('client timeout aborts rather than continuing an unbounded request', async () => {
  let deadline;
  const client = harness((url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Error('private request details'))); deadline();
  }), { setTimeout: callback => { deadline = callback; return 1; }, clearTimeout: () => {} });
  await assert.rejects(client.overviewRequest(args, new AbortController().signal), /too long/);
});
test('display formatting distinguishes currency from counts', () => {
  const client = harness(); assert.equal(client.formatMetric({ label: 'Count', value: 12, unit: 'count' }), '12');
  assert.match(client.formatMetric({ label: 'Cash', value: 12.25, unit: 'ISK' }), /12[.,]25/);
  assert.match(client.formatMetric({ label: 'Scheduled arrival', value: date, unit: 'datetime' }), /UTC$/);
});

test('actual new overview service sections satisfy the six-card browser contract without extra data reads', async () => {
  const load = (source, context = {}) => {
    const module = { exports: {} };
    vm.runInNewContext(source, { module, exports: module.exports, Date, AbortSignal, ...context });
    return module.exports;
  };
  const summary = load(compile('app/lib/overview-summary.ts'));
  class EveError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
  const service = load(compile('app/lib/overview.ts'), { require: path => path === './overview-summary' ? summary : { EveError } });
  for (const [view, scope, dataset, section] of [
    ['personal', 'esi-characters.read_freelance_jobs.v1', 'freelance_jobs', 'freelance'],
    ['corporation', 'esi-corporations.read_freelance_jobs.v1', 'freelance_jobs', 'freelance'],
    ['corporation', 'esi-industry.read_corporation_mining.v1', 'mining_extractions', 'extractions'],
  ]) {
    const selected = { ...args, view }; let reads = 0;
    const read = async (_owner, request) => {
      reads++; assert.equal(request.dataset, dataset);
      return { characterId: args.characterId, ...(view === 'corporation' ? { corporationId: 98000001 } : {}), dataset,
        retrievedAt: date, cacheExpires: null, cacheControl: null, lastModified: null,
        data: section === 'extractions' ? [{ structure_id: 1000000000001, moon_id: 40000001, extraction_start_time: date,
          chunk_arrival_time: '2026-01-02T00:00:00Z', natural_decay_time: '2026-01-03T00:00:00Z' }]
          : { freelance_jobs: [{ id: '11111111-1111-4111-8111-111111111111', name: 'Synthetic job', state: 'Active', last_modified: date, progress: { current: 25, desired: 100 } }] },
        pagination: section === 'extractions' ? { kind: 'page', page: 1, pages: 2, nextPage: 2 } : { kind: view === 'personal' ? 'none' : 'cursor' },
      };
    };
    const result = await service.createOverviewReader({ connections: async () => [{ characterId: args.characterId, scopes: [scope] }],
      character: read, corporation: read, now: () => Date.parse(date) })('synthetic-owner', selected);
    assert.equal(harness().overviewResponse(result, selected), result);
    assert.equal(result.sections.length, 6); assert.equal(reads, 1);
    assert.ok(['ready', 'partial'].includes(result.sections.find(item => item.id === section).status));
    assert.ok(result.sections.filter(item => item.id !== section).every(item => item.status === 'needs_permission'));
  }
});
