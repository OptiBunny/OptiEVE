import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const compile = name => ts.transpileModule(readFileSync(`app/lib/${name}.ts`, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const source = compile('blueprint-collection'), analytics = compile('blueprint-analytics'), summaryModule = { exports: {} };
vm.runInNewContext(compile('overview-summary'), { module: summaryModule, exports: summaryModule.exports, Date });
const stamp = '2026-01-01T00:00:00.000Z', now = Date.parse(stamp), characterId = 90000001, corporationId = 98000001;
const scope = 'esi-corporations.read_blueprints.v1', args = { characterId }, marker = 'OMIT_PRIVATE_COLLECTION';
const plain = value => JSON.parse(JSON.stringify(value));
const row = (item_id = 70000001, extra = {}) => ({ item_id, type_id: 10001, quantity: -1, runs: -1, material_efficiency: 10, time_efficiency: 20, location_id: 60000001, location_flag: 'Hangar', name: marker, owner_id: 90009999, ...extra });
const pagination = (page, pages) => ({ kind: 'page', page, pages, nextPage: pages !== null && page < pages && page < 500 ? page + 1 : null, pageLimit: 500, morePagesAvailable: pages === null ? null : page < pages, pageLimitReached: page === 500 && pages !== page, after: null, before: null });
const envelope = (input, data = [row(70000000 + input.parameters.page)], extra = {}) => ({ characterId: input.characterId, entity: 'corporation', corporationId, dataset: 'blueprints', data,
  retrievedAt: stamp, cacheExpires: 'Thu, 01 Jan 2026 01:00:00 GMT', responseDate: 'Thu, 01 Jan 2026 00:00:00 GMT', cacheControl: 'private, max-age=3600', cacheAge: '0', lastModified: 'Wed, 31 Dec 2025 23:00:00 GMT',
  pagination: pagination(input.parameters.page, 3), source: marker, ...extra });
function harness(options = {}) {
  class EveError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
  const calls = [], deadline = new AbortController(); let active = 0, maxActive = 0;
  const deps = {
    connections: async user => { calls.push({ operation: 'connections', user }); return options.connect ? options.connect(deadline) : options.connections ?? [{ characterId, scopes: [scope] }]; },
    corporation: async (user, input, signal) => {
      calls.push({ operation: 'corporation', user, input, signal }); active++; maxActive = Math.max(maxActive, active);
      try { return options.read ? await options.read(input, signal, EveError, deadline) : envelope(input); } finally { active--; }
    }, now: options.now ?? (() => now),
  };
  const eve = { EveError, listConnections: deps.connections, readCorporationData: deps.corporation, readCharacterData: () => { throw new Error('Unexpected character read'); } };
  const clock = { any: AbortSignal.any.bind(AbortSignal), timeout: ms => { assert.equal(ms, 55000); return deadline.signal; } };
  const projected = { exports: {} }, service = { exports: {} };
  vm.runInNewContext(analytics, { module: projected, exports: projected.exports, Date, AbortSignal: clock, require: name => name === './overview-summary' ? summaryModule.exports : name === './manufacturing-catalog' ? { findPublishedManufacturingItem: options.item ?? (id => id === 10001 || id === 10002 ? { name: `Synthetic blueprint ${id}` } : null) } : eve });
  vm.runInNewContext(source, { module: service, exports: service.exports, Date, AbortSignal: clock, require: name => name === './blueprint-analytics' ? projected.exports : eve });
  return { read: service.exports.createBlueprintCollectionReader(deps), calls, deadline, maxActive: () => maxActive };
}
const get = (h, options, selected = args) => h.read('synthetic-owner', selected, options);
const pages = h => h.calls.filter(value => value.operation === 'corporation').map(value => value.input.parameters.page);
function invariants(value) {
  const c = value.coverage;
  assert.deepEqual(plain(c.completedPages), Array.from({ length: c.pagesRead }, (_, i) => i + 1));
  assert.equal(c.rowsReceived, c.uniqueRecords + c.duplicateRecords);
  assert(c.rowsReceived <= c.pagesRead * 1000 && c.pagesRead <= 50 && c.rowsReceived <= 50000);
  assert.equal(c.providerCeilingPossible, c.rowsReceived >= 25000);
  assert.equal(value.blueprints.length, c.uniqueRecords);
  if (!value.summary) { assert.equal(c.pagesRead, 0); return; }
  assert.equal(value.summary.records, c.uniqueRecords);
  assert.equal(value.summary.records, value.summary.originalRecords + value.summary.copyRecords + value.summary.originalStackRecords);
  for (const counts of [value.kindCounts, value.materialEfficiencyCounts, value.timeEfficiencyCounts]) assert.equal(counts.reduce((sum, item) => sum + item.count, 0), c.uniqueRecords);
  assert.equal(value.typeCounts.reduce((sum, item) => sum + item.records, 0), c.uniqueRecords);
  assert.equal(value.summary.types, value.typeCounts.length);
  assert.deepEqual(plain(value.blueprints.map(value => value.row)), Array.from({ length: c.uniqueRecords }, (_, i) => i + 1));
  if (c.kind === 'all_reported_pages') { assert.equal(c.pagesRead, c.pagesExpected); assert.equal(c.consistency, 'consistent'); assert.equal(c.stopReason, 'complete'); assert.equal(c.duplicateRecords, 0); }
}

test('only an owned positive character selector and signed-in caller are accepted', async () => {
  for (const selected of [null, [], {}, Object.create(args), { characterId: 0 }, { characterId: '90000001' }, { characterId: Number.MAX_SAFE_INTEGER + 1 }, { ...args, entity: 'corporation' }, { ...args, page: 1 }, { ...args, corporationId }, { ...args, write: true }, { ...args, [Symbol('extra')]: true }]) {
    const h = harness(); await assert.rejects(get(h, undefined, selected), error => error.status === 400); assert.equal(h.calls.length, 0);
  }
  for (const user of ['', null, 1]) { const h = harness(); await assert.rejects(h.read(user, args), error => error.status === 401); assert.equal(h.calls.length, 0); }
  const h = harness({ connections: [{ characterId: characterId + 1, scopes: [scope] }] }); await assert.rejects(get(h), error => error.status === 404); assert.deepEqual(pages(h), []);
});
test('missing exact read grant and failed connection check are blank and issue no dataset read', async () => {
  for (const [options, status] of [[{ connections: [{ characterId, scopes: ['esi-characters.read_blueprints.v1'] }] }, 'needs_permission'], [{ connect: () => { throw new Error(marker); } }, 'unavailable']]) {
    const h = harness(options), progress = [], value = await get(h, { onProgress: value => progress.push(value) }); invariants(value);
    assert.equal(value.status, status); assert.equal(value.corporationId, null); assert.equal(value.summary, null); assert.deepEqual(pages(h), []); assert.equal(progress.length, 0);
    assert.deepEqual(plain(value.coverage), { pagesRead: 0, pagesExpected: null, rowsReceived: 0, uniqueRecords: 0, duplicateRecords: 0, pageLimit: 50, rowLimit: 50000, kind: 'unavailable', completedPages: [], consistency: 'unknown', stopReason: 'provider_error', failedPage: null, providerCeilingPossible: false });
    assert(!JSON.stringify(value).includes(marker));
  }
});
test('every advertised page is collected once sequentially with visible monotonic progress', async () => {
  const progress = [], h = harness(), value = await get(h, { onProgress: value => progress.push(plain(value)) }); invariants(value);
  assert.deepEqual(pages(h), [1, 2, 3]); assert.equal(h.maxActive(), 1); assert.equal(value.status, 'ready'); assert.equal(value.corporationId, corporationId);
  assert.equal(value.coverage.kind, 'all_reported_pages'); assert.equal(value.coverage.failedPage, null); assert.equal(value.summary.records, 3);
  assert.deepEqual(progress.map(value => [value.pagesRead, value.pagesExpected, value.rowsReceived, value.uniqueRecords]), [[0, null, 0, 0], [1, 3, 1, 1], [2, 3, 2, 2], [3, 3, 3, 3]]);
  for (const call of h.calls.filter(value => value.operation === 'corporation')) {
    assert.deepEqual(plain(call.input), { characterId, dataset: 'blueprints', parameters: { page: call.input.parameters.page } }); assert.equal(call.signal, h.deadline.signal); assert.equal(call.user, 'synthetic-owner');
  }
});
test('collection charts use actual unique record totals and retain runs only per copy', async () => {
  const h = harness({ read: input => envelope(input, input.parameters.page === 1 ? [row(), row(70000002, { quantity: -2, runs: 3, material_efficiency: 0, time_efficiency: 0 })] : [row(70000002 + input.parameters.page, { type_id: 10002, quantity: input.parameters.page === 2 ? 4 : -2, runs: input.parameters.page === 2 ? -1 : 9, material_efficiency: 5, time_efficiency: 10 })]) });
  const value = await get(h); invariants(value);
  assert.deepEqual(plain(value.summary), { records: 4, types: 2, originalRecords: 1, copyRecords: 2, originalStackRecords: 1, unknownTypeRecords: 0 });
  assert.equal(value.blueprints[2].units, 4); assert.equal(value.blueprints[1].copyRuns, 3); assert.equal(value.blueprints[3].copyRuns, 9); assert(!Object.hasOwn(value.summary, 'runs')); assert(!Object.hasOwn(value.summary, 'units'));
});
test('identical IDs within and between pages count once, without merging distinct identical blueprints', async () => {
  const h = harness({ read: input => envelope(input, input.parameters.page === 1 ? [row(), row(), row(70000002)] : input.parameters.page === 2 ? [row(), row(70000003), row(70000003)] : [row(70000004)]) });
  const value = await get(h); invariants(value); assert.deepEqual(pages(h), [1, 2, 3]);
  assert.equal(value.summary.records, 4); assert.equal(value.coverage.rowsReceived, 7); assert.equal(value.coverage.duplicateRecords, 3); assert.equal(value.coverage.consistency, 'inconsistent'); assert.equal(value.coverage.kind, 'partial'); assert.equal(value.coverage.stopReason, 'complete'); assert.equal(value.freshness.lastModified, null);
});
test('conflicting duplicates reject the whole affected page and never admit its new rows', async () => {
  for (const data of [[row(70000003), row(70000001, { runs: 2, quantity: -2 })], [row(70000003), row(70000004), row(70000004, { material_efficiency: 9 })]]) {
    const progress = [], h = harness({ read: input => envelope(input, input.parameters.page === 1 ? [row()] : data) }), value = await get(h, { onProgress: value => progress.push(value) }); invariants(value);
    assert.deepEqual(pages(h), [1, 2]); assert.equal(value.coverage.stopReason, 'conflicting_duplicate'); assert.equal(value.coverage.pagesRead, 1); assert.equal(value.coverage.failedPage, 2); assert.equal(value.summary.records, 1); assert.equal(value.coverage.consistency, 'inconsistent'); assert.equal(progress.length, 2);
  }
});
test('changes to private location fields still detect conflicting duplicate identities', async () => {
  for (const extra of [{ location_id: 60000002 }, { location_flag: 'CorpSAG1' }, { type_id: 10002 }, { quantity: 2 }, { time_efficiency: 19 }]) {
    const h = harness({ read: input => envelope(input, [row(70000001, input.parameters.page === 1 ? {} : extra)]) }), value = await get(h); invariants(value);
    assert.equal(value.coverage.stopReason, 'conflicting_duplicate'); assert.equal(value.coverage.pagesRead, 1);
  }
});
test('an invalid later row or oversized page cannot leak a partly accepted page', async () => {
  for (const data of [[row(70000003), row(70000004, { runs: 4 })], [row(70000003), null], Array.from({ length: 1001 }, (_, i) => row(71000000 + i))]) {
    const h = harness({ read: input => envelope(input, input.parameters.page === 1 ? [row()] : data) }), value = await get(h); invariants(value);
    assert.equal(value.coverage.stopReason, 'invalid_page'); assert.equal(value.coverage.pagesRead, 1); assert.equal(value.coverage.rowsReceived, 1); assert.equal(value.coverage.failedPage, 2); assert.deepEqual(pages(h), [1, 2]);
  }
});
test('missing first page count stops as unknown without guessing page two', async () => {
  const h = harness({ read: input => envelope(input, [row()], { pagination: pagination(1, null) }) }), value = await get(h); invariants(value);
  assert.equal(value.coverage.kind, 'unknown'); assert.equal(value.coverage.stopReason, 'missing_page_count'); assert.equal(value.coverage.pagesExpected, null); assert.deepEqual(pages(h), [1]);
});
test('increased, decreased and missing later page counts reject the entire changed page', async () => {
  for (const count of [4, 1, null]) {
    const h = harness({ read: input => envelope(input, undefined, { pagination: pagination(input.parameters.page, input.parameters.page === 1 ? 3 : count) }) }), value = await get(h); invariants(value);
    assert.equal(value.coverage.stopReason, 'pagination_changed'); assert.equal(value.coverage.pagesExpected, 3); assert.equal(value.coverage.pagesRead, 1); assert.equal(value.coverage.consistency, 'inconsistent'); assert.deepEqual(pages(h), [1, 2]);
  }
});
test('changed Last-Modified rejects that page while per-page ETags may differ', async () => {
  const changed = harness({ read: input => envelope(input, undefined, { lastModified: input.parameters.page === 1 ? 'Wed, 31 Dec 2025 23:00:00 GMT' : 'Wed, 31 Dec 2025 23:30:00 GMT' }) }), bad = await get(changed); invariants(bad);
  assert.equal(bad.coverage.stopReason, 'snapshot_changed'); assert.equal(bad.coverage.pagesRead, 1); assert.equal(bad.coverage.consistency, 'inconsistent'); assert.equal(bad.freshness.lastModified, null);
  const h = harness({ read: input => envelope(input, undefined, { etag: `page-${input.parameters.page}` }) }), value = await get(h); invariants(value); assert.equal(value.coverage.kind, 'all_reported_pages');
});
test('missing or invalid snapshot timestamp may finish pages but never claim consistent completion', async () => {
  for (const missing of [null, undefined, 'invalid timestamp']) {
    const h = harness({ read: input => envelope(input, undefined, input.parameters.page === 2 ? { lastModified: missing } : {}) }), value = await get(h); invariants(value);
    assert.deepEqual(pages(h), [1, 2, 3]); assert.equal(value.coverage.stopReason, 'complete'); assert.equal(value.coverage.kind, 'unknown'); assert.equal(value.coverage.consistency, 'unknown'); assert.equal(value.freshness.lastModified, null); assert.equal(value.status, 'partial');
  }
});
test('corporation membership is checked on every page and a change excludes that page', async () => {
  const h = harness({ read: input => envelope(input, undefined, { corporationId: input.parameters.page === 1 ? corporationId : corporationId + 1 }) }), value = await get(h); invariants(value);
  assert.equal(value.corporationId, corporationId); assert.equal(value.coverage.stopReason, 'corporation_changed'); assert.equal(value.coverage.pagesRead, 1); assert.equal(value.coverage.consistency, 'inconsistent'); assert.deepEqual(pages(h), [1, 2]);
});
test('earliest page expiry is reassessed after the final page completes', async () => {
  let clock = now;
  const h = harness({ now: () => clock, read: input => { if (input.parameters.page === 3) clock += 2000; return envelope(input, undefined, { cacheExpires: input.parameters.page === 1 ? 'Thu, 01 Jan 2026 00:00:01 GMT' : 'Thu, 01 Jan 2026 01:00:00 GMT' }); } }), value = await get(h); invariants(value);
  assert.equal(value.coverage.kind, 'all_reported_pages'); assert.equal(value.freshness.state, 'stale'); assert.equal(value.freshness.cacheExpires, '2026-01-01T00:00:01.000Z'); assert.equal(value.status, 'partial'); assert.equal(value.generatedAt, '2026-01-01T00:00:02.000Z');
});
test('unknown expiry remains unknown unless another accepted page is already stale', async () => {
  for (const stale of [false, true]) {
    const h = harness({ read: input => envelope(input, undefined, input.parameters.page === 1 ? { cacheExpires: null, cacheControl: null } : stale ? { cacheExpires: stamp } : {}) }), value = await get(h); invariants(value);
    assert.equal(value.freshness.state, stale ? 'stale' : 'unknown'); assert.equal(value.freshness.cacheExpires, stale ? stamp : null); assert.equal(value.status, 'partial');
  }
});
test('final chart aggregation is included in freshness, deadline and cancellation checks', async () => {
  for (const outcome of ['stale', 'deadline', 'cancelled']) {
    const controller = new AbortController(); let finalProgress = false, finalClockReads = 0;
    const h = harness({ now: () => {
      if (!finalProgress || ++finalClockReads === 1) return now;
      if (outcome === 'cancelled') controller.abort();
      return now + (outcome === 'deadline' ? 56000 : 2000);
    }, read: input => envelope(input, undefined, { cacheExpires: 'Thu, 01 Jan 2026 00:00:01 GMT' }) });
    const value = await get(h, { signal: controller.signal, onProgress: value => { if (value.pagesRead === 3) finalProgress = true; } }); invariants(value);
    assert.equal(value.coverage.pagesRead, 3); assert.equal(value.freshness.state, 'stale'); assert.equal(value.status, 'partial');
    assert.equal(value.coverage.stopReason, outcome === 'stale' ? 'complete' : outcome);
    assert.equal(value.coverage.kind, outcome === 'stale' ? 'all_reported_pages' : 'partial');
    assert.equal(value.generatedAt, outcome === 'deadline' ? '2026-01-01T00:00:56.000Z' : '2026-01-01T00:00:02.000Z');
  }
});
test('later provider failure preserves only earlier pages without retrying or exposing upstream errors', async () => {
  const h = harness({ read: (input, _signal, EveError) => { if (input.parameters.page === 2) throw new EveError(marker, 503); return envelope(input); } }), value = await get(h); invariants(value);
  assert.equal(value.coverage.stopReason, 'provider_error'); assert.equal(value.coverage.pagesRead, 1); assert.equal(value.coverage.failedPage, 2); assert.equal(value.status, 'partial'); assert.deepEqual(pages(h), [1, 2]); assert(!JSON.stringify(value).includes(marker));
});
test('first read failures distinguish role/rate status without surfacing raw errors or inventing holdings', async () => {
  for (const [status, expected] of [[401, 'unavailable'], [403, 'unavailable'], [404, 'unavailable'], [409, 'unavailable'], [429, 'unavailable'], [500, 'error']]) {
    const h = harness({ read: (_input, _signal, EveError) => { throw new EveError(marker, status); } }), value = await get(h); invariants(value);
    assert.equal(value.status, expected); assert.equal(value.summary, null); assert.equal(value.coverage.failedPage, 1); assert.equal(value.coverage.pagesExpected, null); assert.equal(value.coverage.stopReason, 'provider_error'); assert.deepEqual(pages(h), [1]); assert(!JSON.stringify(value).includes(marker));
    if (status === 403) assert.match(value.message, /Director/); if (status === 429) assert.match(value.message, /rate limiting/);
  }
});
test('a pre-aborted caller starts neither connection checks nor page scheduling', async () => {
  const controller = new AbortController(); controller.abort(new Error('synthetic cancellation')); const h = harness(); await assert.rejects(get(h, { signal: controller.signal })); assert.equal(h.calls.length, 0);
});
test('cancellation at progress prevents further pages and never accepts an in-flight late result', async () => {
  for (const cancelAt of [0, 1, 3]) {
    const controller = new AbortController(), h = harness(), value = await get(h, { signal: controller.signal, onProgress: value => { if (value.pagesRead === cancelAt) controller.abort(); } }); invariants(value);
    assert.equal(value.coverage.stopReason, 'cancelled'); assert.equal(value.coverage.pagesRead, cancelAt); assert.equal(value.status, cancelAt ? 'partial' : 'unavailable'); assert.deepEqual(pages(h), Array.from({ length: cancelAt }, (_, i) => i + 1));
  }
  const controller = new AbortController(), h = harness({ read: async input => { controller.abort(); return envelope(input); } }), value = await get(h, { signal: controller.signal }); invariants(value); assert.equal(value.coverage.pagesRead, 0); assert.equal(value.coverage.stopReason, 'cancelled'); assert.equal(value.coverage.failedPage, 1);
});
test('shared deadline races an uncooperative connection check and page promise', async () => {
  const pending = () => new Promise(() => {});
  const connecting = harness({ connect: deadline => { queueMicrotask(() => deadline.abort()); return pending(); } }), blank = await get(connecting); invariants(blank); assert.equal(blank.coverage.stopReason, 'deadline'); assert.equal(blank.coverage.failedPage, null); assert.deepEqual(pages(connecting), []);
  for (const failedPage of [1, 2]) {
    const h = harness({ read: (input, _signal, _EveError, deadline) => { if (input.parameters.page === failedPage) { queueMicrotask(() => deadline.abort()); return pending(); } return envelope(input); } }), value = await get(h); invariants(value);
    assert.equal(value.coverage.stopReason, 'deadline'); assert.equal(value.coverage.failedPage, failedPage); assert.equal(value.coverage.pagesRead, failedPage - 1); assert.deepEqual(pages(h), failedPage === 1 ? [1] : [1, 2]);
  }
});
test('the application stops at 50 pages and 50000 accepted rows, even if more are advertised', async () => {
  const h = harness({ read: input => envelope(input, Array.from({ length: 1000 }, (_, i) => row(70000000 + input.parameters.page * 1000 + i)), { pagination: pagination(input.parameters.page, 501) }) }), value = await get(h); invariants(value);
  assert.equal(pages(h).length, 50); assert.equal(pages(h).at(-1), 50); assert.equal(value.coverage.pagesExpected, 501); assert.equal(value.coverage.pagesRead, 50); assert.equal(value.coverage.rowsReceived, 50000); assert.equal(value.coverage.stopReason, 'page_limit'); assert.equal(value.coverage.kind, 'partial'); assert.equal(value.coverage.providerCeilingPossible, true);
});
test('historical provider warning uses actual received rows and never invents additional holdings', async () => {
  for (const count of [24999, 25000]) {
    const h = harness({ read: input => envelope(input, Array.from({ length: input.parameters.page === 25 ? count - 24000 : 1000 }, (_, i) => row(70000000 + input.parameters.page * 1000 + i)), { pagination: pagination(input.parameters.page, 25) }) }), value = await get(h); invariants(value);
    assert.equal(value.coverage.rowsReceived, count); assert.equal(value.coverage.providerCeilingPossible, count >= 25000); assert.equal(value.coverage.kind, 'all_reported_pages'); assert.equal(value.status, count >= 25000 ? 'partial' : 'ready');
    assert.match(value.limitations.join(' '), /not proof of additional holdings/); assert.match(value.limitations.join(' '), /password-protected containers/);
  }
});
test('provider warning counts accepted raw duplicates before identity deduplication', async () => {
  const h = harness({ read: input => envelope(input, Array.from({ length: 1000 }, () => row()), { pagination: pagination(input.parameters.page, 25) }) }), value = await get(h); invariants(value);
  assert.equal(value.coverage.rowsReceived, 25000); assert.equal(value.coverage.uniqueRecords, 1); assert.equal(value.coverage.duplicateRecords, 24999); assert.equal(value.coverage.providerCeilingPossible, true); assert.equal(value.coverage.consistency, 'inconsistent');
});
test('valid empty pages are distinct from unavailable results; unknown public types stay explicit', async () => {
  const h = harness({ read: input => envelope(input, [], { pagination: pagination(input.parameters.page, 1) }) }), empty = await get(h); invariants(empty); assert.equal(empty.summary.records, 0); assert.equal(empty.status, 'ready'); assert.equal(empty.coverage.kind, 'all_reported_pages'); assert.equal(empty.kindCounts.length, 3);
  const unknown = await get(harness({ item: () => null })); invariants(unknown); assert.equal(unknown.status, 'partial'); assert.equal(unknown.summary.unknownTypeRecords, 3); assert.equal(unknown.blueprints[0].name, 'Type 10001');
});
test('results and progress contain no raw item/location IDs, flags, provider errors, URLs or private names', async () => {
  const progress = [], value = await get(harness(), { onProgress: value => progress.push(value) }); invariants(value); const json = JSON.stringify({ value, progress });
  for (const secret of [marker, '70000001', '60000001', '90009999', 'location_flag', 'location_id', 'item_id', 'owner_id', 'Hangar', '"source"']) assert(!json.includes(secret), secret);
  for (const event of progress) assert.deepEqual(Object.keys(event).sort(), ['duplicateRecords', 'pageLimit', 'pagesExpected', 'pagesRead', 'rowLimit', 'rowsReceived', 'uniqueRecords']);
});
