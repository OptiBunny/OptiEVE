import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync('app/lib/manufacturing-market.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const m = { exports: {} }; vm.runInNewContext(code, { module: m, exports: m.exports, Date, AbortSignal, TextDecoder, Set, Map, BigInt });
const market = m.exports, plain = value => JSON.parse(JSON.stringify(value));
const now = Date.parse('2026-01-01T12:00:00Z'), stamp = new Date(now).toISOString();
const base = { regionId: 10000001, typeId: 34, stationId: 60000001, quantity: 10, side: 'buy_materials', excludeOrderIds: [], ownOrdersComplete: true };
const order = (id = 1001, overrides = {}) => ({ order_id: id, type_id: 34, location_id: 60000001, system_id: 30000001, is_buy_order: false, volume_remain: 6, volume_total: 10, min_volume: 1, price: 2.25, duration: 90, issued: '2025-12-31T12:00:00Z', range: 'station', ...overrides });
const headers = extras => ({ date: new Date(now).toUTCString(), 'cache-control': 'public, max-age=300', 'last-modified': new Date(now - 60_000).toUTCString(), ...extras });
function harness(options = {}) {
  const calls = [], state = { now };
  const reader = market.createManufacturingMarketReader({ now: () => options.now ? options.now() : state.now, fetch: async (url, init) => {
    const parsed = new URL(url); calls.push({ url, init });
    assert.equal(parsed.origin, 'https://esi.evetech.net'); assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual');
    assert.equal(init.headers['X-Compatibility-Date'], '2026-10-31'); assert.equal(init.headers.Authorization, undefined); assert.equal(init.body, undefined);
    assert.ok(init.signal instanceof AbortSignal);
    const override = options.fetch && await options.fetch(parsed, init, calls, state);
    if (override !== undefined) return override;
    let data;
    if (parsed.pathname.startsWith('/universe/stations/')) data = { station_id: 60000001, system_id: 30000001, services: ['market'], name: 'OMIT_PUBLIC_NAME' };
    else if (parsed.pathname.startsWith('/universe/systems/')) data = { system_id: 30000001, constellation_id: 20000001, name: 'OMIT_PUBLIC_NAME' };
    else if (parsed.pathname.startsWith('/universe/constellations/')) data = { constellation_id: 20000001, region_id: 10000001, systems: [30000001], name: 'OMIT_PUBLIC_NAME' };
    else if (parsed.pathname.endsWith('/orders')) data = [order(1001), order(1002, { price: 2.50, volume_remain: 10 })];
    else if (parsed.pathname.endsWith('/history')) data = [{ date: '2025-12-31', volume: 1000, order_count: 15, lowest: 1.25, highest: 3.75, average: 2.12345 }];
    else if (parsed.pathname === '/industry/systems') data = [{ solar_system_id: 30000001, cost_indices: [{ activity: 'manufacturing', cost_index: 0.03456 }] }];
    else if (parsed.pathname === '/markets/prices') data = [{ type_id: 34, adjusted_price: 4.123456789, average_price: 5.2 }];
    else throw Error('Unexpected synthetic route');
    return Response.json(data, { headers: headers(parsed.pathname.endsWith('/orders') ? { 'x-pages': '1' } : {}) });
  } });
  return { reader, calls, state };
}
const isOrder = url => url.pathname.endsWith('/orders');
const orderResponse = (rows, extra = {}) => Response.json(rows, { headers: headers({ 'x-pages': '1', ...extra }) });

test('station quote consumes exact-depth sells in increasing price order with cent-exact totals', async () => {
  const h = harness(); const result = await h.reader.quote(base);
  assert.equal(result.grossISK, '23.50'); assert.equal(result.filledQuantity, 10); assert.equal(result.unfilledQuantity, 0);
  assert.equal(result.averageUnitISK, '2.35'); assert.equal(result.worstUnitISK, '2.50'); assert.equal(result.estimateReady, true);
  assert.equal(result.coverage, 'complete'); assert.equal(result.sourceFreshness, 'fresh'); assert.equal(h.calls.length, 4);
  assert.deepEqual(plain(result.priceLevels), [{ priceISK: '2.25', quantity: 6, minimumFill: 1 }, { priceISK: '2.50', quantity: 4, minimumFill: 1 }]);
  assert.ok(!JSON.stringify(result).includes('OMIT_PUBLIC_NAME')); assert.ok(!Object.hasOwn(result, 'excludeOrderIds'));
});

test('sell quote sorts buys highest first and keeps fees separate', async () => {
  const h = harness({ fetch: url => isOrder(url) ? orderResponse([order(2, { is_buy_order: true, price: 2.25, volume_remain: 10 }), order(1, { is_buy_order: true, price: 3.10 })]) : undefined });
  const result = await h.reader.quote({ ...base, side: 'sell_output' });
  assert.equal(result.grossISK, '27.60'); assert.equal(result.priceLevels[0].priceISK, '3.10'); assert.equal(result.estimateReady, true);
  assert.ok(result.limitations.some(text => text.includes('Sales tax')));
  assert.ok(h.calls.at(-1).url.includes('order_type=buy'));
});

test('quote exposes earliest allocated-order expiry independently of a still-fresh page cache', async () => {
  const h = harness({ fetch: url => isOrder(url) ? orderResponse([
    order(1, { price: 1, duration: 1, issued: '2025-12-31T12:00:10Z' }),
    order(2, { price: 2, duration: 1, issued: '2025-12-31T12:00:20Z' }),
  ]) : undefined });
  const result = await h.reader.quote(base);
  assert.equal(result.validUntil, '2026-01-01T12:00:10.000Z'); assert.equal(result.estimateReady, true);
  assert.ok(Date.parse(result.sources.at(-1).cacheExpires) > Date.parse(result.validUntil));
  h.state.now = now + 10_000;
  const later = await h.reader.quote(base);
  assert.equal(later.sourceFreshness, 'fresh'); assert.equal(later.filledQuantity, 6); assert.equal(later.estimateReady, false);
  assert.equal(later.validUntil, '2026-01-01T12:00:20.000Z');
  h.state.now = now + 20_000;
  const empty = await h.reader.quote(base);
  assert.equal(empty.validUntil, null); assert.equal(empty.filledQuantity, 0); assert.equal(empty.estimateReady, false);
});

test('excluded, skipped-minimum and unallocated orders cannot shorten a quote order deadline', async () => {
  const h = harness({ fetch: url => isOrder(url) ? orderResponse([
    order(1, { price: 1, duration: 1, issued: '2025-12-31T12:00:01Z' }),
    order(2, { price: 2, volume_remain: 10, min_volume: 10, duration: 1, issued: '2025-12-31T12:00:02Z' }),
    order(3, { price: 3, duration: 1, issued: '2025-12-31T12:00:30Z' }),
    order(4, { price: 4, duration: 1, issued: '2025-12-31T12:00:03Z' }),
  ]) : undefined });
  const result = await h.reader.quote({ ...base, quantity: 5, excludeOrderIds: [1] });
  assert.equal(result.validUntil, '2026-01-01T12:00:30.000Z'); assert.equal(result.estimateReady, true);
  assert.equal(result.minimumSkippedOrders, 1); assert.equal(result.excludedOwnedOrders, 1);
});

for (const input of [null, {}, { ...base, regionId: '../private' }, { ...base, typeId: 0 }, { ...base, stationId: 1.5 }, { ...base, quantity: 0 }, { ...base, quantity: 1e12 + 1 }, { ...base, side: 'place_order' }, { ...base, excludeOrderIds: undefined }, { ...base, excludeOrderIds: [1, 1] }, { ...base, ownOrdersComplete: undefined }, { ...base, ownOrdersComplete: 'true' }, { ...base, maxPages: 0 }, { ...base, maxPages: 21 }, { ...base, characterId: 90000001 }, { ...base, url: 'https://example.invalid' }]) {
  test('invalid quote selection is rejected before any public fetch: ' + JSON.stringify(input), async () => {
    const h = harness(); await assert.rejects(h.reader.quote(input), market.ManufacturingMarketError); assert.equal(h.calls.length, 0);
  });
}

test('same request-scoped reader reuses public geography and same book for cash-deficit quantities', async () => {
  const h = harness(); const full = await h.reader.quote(base), deficit = await h.reader.quote({ ...base, quantity: 3 });
  assert.equal(h.calls.length, 4); assert.equal(full.grossISK, '23.50'); assert.equal(deficit.grossISK, '6.75');
  const another = harness(); await another.reader.quote(base); assert.equal(another.calls.length, 4);
});

test('owned orders, other stations and expired orders are excluded', async () => {
  const rows = [order(1, { price: 0.01 }), order(2, { price: 0.02, location_id: 60000002 }), order(3, { price: 0.03, issued: '2025-01-01T00:00:00Z' }), order(4, { volume_remain: 10, price: 4 })];
  const h = harness({ fetch: url => isOrder(url) ? orderResponse(rows) : undefined });
  const result = await h.reader.quote({ ...base, excludeOrderIds: [1] });
  assert.equal(result.grossISK, '40.00'); assert.equal(result.excludedOwnedOrders, 1); assert.equal(result.expiredOrders, 1);
  const incomplete = await h.reader.quote({ ...base, excludeOrderIds: [1], ownOrdersComplete: false });
  assert.equal(incomplete.exclusionsVerified, false); assert.equal(incomplete.estimateReady, false);
});

test('minimum fill uses final order remainder and skips unfillable orders conservatively', async () => {
  const h = harness({ fetch: url => isOrder(url) ? orderResponse([order(1, { is_buy_order: true, min_volume: 8, volume_remain: 10, price: 10 }), order(2, { is_buy_order: true, min_volume: 8, volume_remain: 3, price: 9 }), order(3, { is_buy_order: true, volume_remain: 10, price: 5 })]) : undefined });
  const result = await h.reader.quote({ ...base, side: 'sell_output', quantity: 7 });
  assert.equal(result.minimumSkippedOrders, 1); assert.equal(result.grossISK, '47.00');
  assert.deepEqual(plain(result.priceLevels), [{ priceISK: '9.00', quantity: 3, minimumFill: 3 }, { priceISK: '5.00', quantity: 4, minimumFill: 1 }]);
});

test('partial depth never becomes a full-batch estimate', async () => {
  const h = harness(); const result = await h.reader.quote({ ...base, quantity: 50 });
  assert.equal(result.filledQuantity, 16); assert.equal(result.unfilledQuantity, 34); assert.equal(result.estimateReady, false); assert.equal(result.coverage, 'partial'); assert.equal(result.grossISK, '38.50');
});

test('all pages are read before selecting station price priority', async () => {
  const h = harness({ fetch: url => isOrder(url) ? orderResponse([order(Number(url.searchParams.get('page')), { price: url.searchParams.get('page') === '1' ? 10 : 1, volume_remain: 10 })], { 'x-pages': '2' }) : undefined });
  const result = await h.reader.quote(base); assert.equal(result.grossISK, '10.00'); assert.equal(result.pagination.pagesRead, 2); assert.equal(result.completePages, true); assert.equal(h.calls.length, 5);
});

test('page cap, missing page count and changing page count cannot claim complete book', async () => {
  for (const mode of ['cap', 'missing', 'changing']) {
    const h = harness({ fetch: url => isOrder(url) ? Response.json([order(Number(url.searchParams.get('page')), { volume_remain: 10 })], { headers: headers(mode === 'missing' ? {} : { 'x-pages': mode === 'changing' && url.searchParams.get('page') === '2' ? '3' : '2' }) }) : undefined });
    const result = await h.reader.quote({ ...base, maxPages: mode === 'cap' ? 1 : 3 });
    assert.equal(result.completePages, false); assert.equal(result.estimateReady, false); assert.equal(result.coverage, mode === 'cap' ? 'partial' : 'unknown');
  }
});

test('partial page HTTP errors and duplicates fail instead of exposing trustworthy-looking totals', async () => {
  for (const mode of ['error', 'duplicate']) {
    const h = harness({ fetch: url => isOrder(url) ? url.searchParams.get('page') === '2' && mode === 'error' ? Response.json({ private: 'OMIT_UPSTREAM' }, { status: 503 }) : orderResponse([order(1)], { 'x-pages': '2' }) : undefined });
    await assert.rejects(h.reader.quote(base), error => error instanceof market.ManufacturingMarketError && !error.message.includes('OMIT_UPSTREAM'));
  }
});

test('public region orders still require an explicit boolean side', async () => {
  for (const side of ['buy_materials', 'sell_output']) for (const value of [undefined, null, 'false', 0]) {
    const malformed = order(1, { is_buy_order: value });
    if (value === undefined) delete malformed.is_buy_order;
    const h = harness({ fetch: url => isOrder(url) ? orderResponse([malformed]) : undefined });
    await assert.rejects(h.reader.quote({ ...base, side }), market.ManufacturingMarketError);
  }
});
for (const override of [{ type_id: 35 }, { is_buy_order: true }, { order_id: 0 }, { volume_remain: 11 }, { min_volume: 0 }, { price: 1.234 }, { price: -1 }, { price: 1e12 + 1 }, { duration: 0 }, { issued: 'not-a-time' }, { range: 'private' }, { system_id: 30000002 }]) {
  test('malformed quote order fails safely: ' + JSON.stringify(override), async () => {
    const h = harness({ fetch: url => isOrder(url) ? orderResponse([order(1, override)]) : undefined }); await assert.rejects(h.reader.quote(base), market.ManufacturingMarketError);
  });
}

test('invalid calendar and time rollover cannot produce an estimate-ready quote', async () => {
  const completedAt = Date.parse('2026-03-05T12:00:00Z');
  for (const issued of ['2026-02-30T00:00:00Z', '2026-02-29T00:00:00+01:00', '2026-04-31T00:00:00-05:00', '2026-03-01T24:00:00Z', '2026-03-01T00:60:00Z', '2026-03-01T00:00:60Z', '2026-03-01T00:00:00+24:00', '2026-03-01T00:00:00+01:60']) {
    const h = harness({ now: () => completedAt, fetch: url => isOrder(url) ? orderResponse([order(1, { issued, volume_remain: 10 })], { date: new Date(completedAt).toUTCString() }) : undefined });
    await assert.rejects(h.reader.quote(base), market.ManufacturingMarketError);
  }
});

test('valid leap-day timestamps with UTC and timezone offsets retain executable depth', async () => {
  const completedAt = Date.parse('2024-03-01T12:00:00Z');
  for (const issued of ['2024-02-29T00:00:00Z', '2024-02-29T23:59:59.999+05:30', '2024-02-29T23:59:59-05:00']) {
    const h = harness({ now: () => completedAt, fetch: url => isOrder(url) ? orderResponse([order(1, { issued, volume_remain: 10 })], { date: new Date(completedAt).toUTCString() }) : undefined });
    const result = await h.reader.quote(base);
    assert.equal(result.estimateReady, true); assert.equal(result.filledQuantity, 10); assert.equal(result.expiredOrders, 0);
  }
});

for (const scenario of ['wrong_station', 'no_market', 'wrong_system', 'wrong_region']) {
  test('NPC station geography is validated: ' + scenario, async () => {
    const h = harness({ fetch: url => {
      if (scenario === 'wrong_station' && url.pathname.startsWith('/universe/stations/')) return Response.json({ station_id: 60000002, system_id: 30000001, services: ['market'] });
      if (scenario === 'no_market' && url.pathname.startsWith('/universe/stations/')) return Response.json({ station_id: 60000001, system_id: 30000001, services: [] });
      if (scenario === 'wrong_system' && url.pathname.startsWith('/universe/systems/')) return Response.json({ system_id: 30000002, constellation_id: 20000001 });
      if (scenario === 'wrong_region' && url.pathname.startsWith('/universe/constellations/')) return Response.json({ constellation_id: 20000001, region_id: 10000002, systems: [30000001] });
    } });
    await assert.rejects(h.reader.quote(base), market.ManufacturingMarketError); assert.equal(h.calls.some(call => call.url.includes('/orders?')), false);
  });
}

test('stale, missing and aged cache metadata remain explicit', async () => {
  for (const [extra, expected] of [[{ expires: new Date(now - 1).toUTCString() }, 'stale'], [{ date: '', 'cache-control': '' }, 'unknown'], [{ age: '-1' }, 'unknown'], [{ age: '301' }, 'stale'], [{ 'cache-control': 'no-store' }, 'stale']]) {
    const h = harness({ fetch: url => isOrder(url) ? orderResponse([order(1, { volume_remain: 10 })], extra) : undefined });
    const result = await h.reader.quote(base); assert.equal(result.sourceFreshness, expected); assert.equal(result.estimateReady, false);
  }
});

test('cached request-scoped book is reclassified at final completion time', async () => {
  const h = harness(); assert.equal((await h.reader.quote(base)).estimateReady, true);
  h.state.now += 300000; const result = await h.reader.quote(base);
  assert.equal(result.sourceFreshness, 'stale'); assert.equal(result.estimateReady, false); assert.equal(h.calls.length, 4);
});

test('no HTTP redirect, raw upstream error or oversized body is accepted', async () => {
  for (const response of [new Response('OMIT_PRIVATE', { status: 302, headers: { location: 'https://example.invalid' } }), Response.json({ error: 'OMIT_PRIVATE' }, { status: 429 }), new Response('OMIT_PRIVATE', { headers: { 'content-length': String(20 * 1024 * 1024) } }), new Response('{invalid')]) {
    const h = harness({ fetch: () => response }); await assert.rejects(h.reader.history({ regionId: 1, typeId: 1 }), error => error instanceof market.ManufacturingMarketError && !error.message.includes('OMIT_PRIVATE'));
  }
});

test('caller cancellation prevents public requests and interrupts in-flight processing', async () => {
  const controller = new AbortController(); controller.abort(); const h = harness();
  await assert.rejects(h.reader.quote(base, { signal: controller.signal })); assert.equal(h.calls.length, 0);
  const active = new AbortController(), during = harness({ fetch: url => { if (isOrder(url)) active.abort(); } });
  await assert.rejects(during.reader.quote(base, { signal: active.signal }));
});

test('history is regional, preserves decimal prices and does not impute missing days', async () => {
  const h = harness(); const result = await h.reader.history({ regionId: 10000001, typeId: 34, days: 7 });
  assert.equal(result.window.startUTC, '2025-12-25'); assert.equal(result.window.endExclusiveUTC, '2026-01-01'); assert.equal(result.window.reportedDays, 1); assert.equal(result.window.missingDays, 6);
  assert.equal(result.rows[0].averageISK, '2.12345'); assert.equal(result.totalReportedVolume, '1000'); assert.equal(result.averageVolumePerReportedDay, '1000.00'); assert.equal(h.calls.length, 1);
  assert.ok(result.limitations[0].includes('not station-specific'));
});

test('history excludes current/future dates and sums large safe per-day volumes exactly', async () => {
  const rows = ['2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02'].map(date => ({ date, volume: Number.MAX_SAFE_INTEGER, order_count: 1, lowest: 1, average: 1, highest: 1 }));
  const h = harness({ fetch: () => Response.json(rows, { headers: headers() }) }); const result = await h.reader.history({ regionId: 1, typeId: 34 });
  assert.equal(result.rows.length, 2); assert.equal(result.totalReportedVolume, '18014398509481982');
});

for (const override of [{ date: '2025-02-30' }, { volume: -1 }, { volume: Number.MAX_SAFE_INTEGER + 1 }, { order_count: 1.5 }, { lowest: 5, highest: 1 }, { average: 9 }]) {
  test('invalid history record is rejected: ' + JSON.stringify(override), async () => {
    const h = harness({ fetch: () => Response.json([{ date: '2025-12-31', volume: 1, order_count: 1, lowest: 1, average: 2, highest: 3, ...override }]) });
    await assert.rejects(h.reader.history({ regionId: 1, typeId: 34 }), market.ManufacturingMarketError);
  });
}

test('history validates bounds and prevents arbitrary public paths', async () => {
  for (const args of [{ regionId: 1, typeId: 34, days: 91 }, { regionId: 1, typeId: 34, days: 0 }, { regionId: 1, typeId: 34, stationId: 2 }, { regionId: '1', typeId: 34 }]) {
    const h = harness(); await assert.rejects(h.reader.history(args), market.ManufacturingMarketError); assert.equal(h.calls.length, 0);
  }
});

test('industry costs preserve decimal adjusted values, missing values and public provenance', async () => {
  const h = harness(); const result = await h.reader.costs({ solarSystemId: 30000001, typeIds: [34, 35] });
  assert.equal(result.manufacturingCostIndex, '0.03456'); assert.equal(result.adjustedPrices[0].adjustedPriceISK, '4.123456789');
  assert.equal(result.adjustedPrices[1].adjustedPriceISK, null); assert.deepEqual(plain(result.missingAdjustedTypeIds), [35]); assert.equal(result.complete, false);
  await h.reader.costs({ solarSystemId: 30000001, typeIds: [34] }); assert.equal(h.calls.length, 2);
});

test('industry missing system index remains null rather than zero', async () => {
  const h = harness(); const result = await h.reader.costs({ solarSystemId: 30000002, typeIds: [34] }); assert.equal(result.manufacturingCostIndex, null); assert.equal(result.complete, false);
});

test('industry decimal exponent inputs expand without rounding away small values', async () => {
  const h = harness({ fetch: url => url.pathname === '/markets/prices' ? Response.json([{ type_id: 34, adjusted_price: 1e-8 }], { headers: headers() }) : undefined });
  const result = await h.reader.costs({ solarSystemId: 30000001, typeIds: [34] }); assert.equal(result.adjustedPrices[0].adjustedPriceISK, '0.00000001'); assert.equal(result.adjustedPrices[0].averagePriceISK, null);
});

for (const args of [{ solarSystemId: 1, typeIds: [] }, { solarSystemId: 1, typeIds: [34, 34] }, { solarSystemId: 1, typeIds: [0] }, { solarSystemId: 1, typeIds: [34], structureId: 100000000001 }]) {
  test('industry selection rejects private structure or invalid material inputs', async () => { const h = harness(); await assert.rejects(h.reader.costs(args), market.ManufacturingMarketError); assert.equal(h.calls.length, 0); });
}

test('duplicate adjusted prices and manufacturing indices fail safely', async () => {
  for (const target of ['prices', 'systems']) {
    const h = harness({ fetch: url => target === 'prices' && url.pathname === '/markets/prices' ? Response.json([{ type_id: 34 }, { type_id: 34 }]) : target === 'systems' && url.pathname === '/industry/systems' ? Response.json([{ solar_system_id: 30000001, cost_indices: [{ activity: 'manufacturing', cost_index: 0.1 }, { activity: 'manufacturing', cost_index: 0.2 }] }]) : undefined });
    await assert.rejects(h.reader.costs({ solarSystemId: 30000001, typeIds: [34] }), market.ManufacturingMarketError);
  }
});
