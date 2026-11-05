import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync('app/lib/blueprint-reconciliation-stream.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
class EveError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const module = { exports: {} };
vm.runInNewContext(code, { module, exports: module.exports, Response, ReadableStream, AbortSignal, AbortController, TextEncoder,
  require: path => {
    if (path === './eve') return { EveError };
    assert.equal(path, './blueprint-reconciliation');
    return { readBlueprintReconciliation: async () => { throw Error('Use a synthetic reader'); }, validateBlueprintReconciliationArgs: input => {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'characterId') || !Number.isSafeInteger(input.characterId) || input.characterId < 1) throw new EveError('Choose a connected character.');
      return { characterId: input.characterId };
    } };
  },
});
const respond = module.exports.createBlueprintReconciliationResponder;
const args = { characterId: 90000001 }, progress = { pagesRead: 0, pagesExpected: null, rowsReceived: 0, uniqueRecords: 0, duplicateRecords: 0, pageLimit: 50, rowLimit: 50000 };
async function events(response) { const raw = await response.text(); return { raw, rows: raw.trim() ? raw.trim().split('\n').map(line => JSON.parse(line)) : [] }; }

test('reconciliation stream refuses unauthenticated, invalid and already-aborted requests before invoking a reader', () => {
  let calls = 0; const reader = respond(async () => { calls++; return {}; });
  for (const user of ['', null, undefined, 12]) assert.throws(() => reader(user, args), error => error.status === 401);
  for (const input of [{}, { characterId: 0 }, { characterId: 90000001, page: 1 }]) assert.throws(() => reader('synthetic-owner', input));
  const cancelled = AbortSignal.abort(); assert.throws(() => reader('synthetic-owner', args, cancelled));
  assert.equal(calls, 0);
});

test('one bounded stream preserves progress order and a single final response with no-store protections', async () => {
  const response = respond(async (user, input, context) => {
    assert.equal(user, 'synthetic-owner'); assert.equal(input.characterId, args.characterId);
    context.onProgress(progress); context.onProgress({ ...progress, pagesRead: 1, pagesExpected: 1 });
    return { characterId: args.characterId, synthetic: true };
  })('synthetic-owner', args);
  const value = await events(response);
  assert.deepEqual(value.rows.map(row => row.type), ['progress', 'progress', 'result']);
  assert.equal(value.rows[1].progress.pagesRead, 1); assert.equal(value.rows[2].result.characterId, args.characterId);
  assert.match(response.headers.get('content-type'), /^application\/x-ndjson/);
  assert.match(response.headers.get('cache-control'), /private.*no-store/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('vary'), /Cookie/); assert.match(response.headers.get('vary'), /oai-authenticated-user-id/);
});

test('oversized final output is replaced by one fixed 413 without emitting source data', async () => {
  const value = await events(respond(async () => ({ marker: 'OMIT_PRIVATE_FINAL', payload: 'x'.repeat(16 * 1024 * 1024) }))('synthetic-owner', args));
  assert.equal(value.rows.length, 1); assert.equal(value.rows[0].type, 'error'); assert.equal(value.rows[0].status, 413);
  assert.doesNotMatch(value.raw, /OMIT_PRIVATE_FINAL|payload/); assert(value.raw.length < 512);
});

test('oversized progress aborts the reader and cannot be hidden by a caught callback error', async () => {
  for (const payload of ['x'.repeat(4096), 'π'.repeat(2200)]) {
    let signal;
    const value = await events(respond(async (_user, _input, context) => {
      signal = context.signal;
      try { context.onProgress({ ...progress, marker: 'OMIT_PRIVATE_PROGRESS', payload }); } catch {}
      return { marker: 'OMIT_PRIVATE_RESULT' };
    })('synthetic-owner', args));
    assert(signal.aborted); assert.equal(value.rows.length, 1); assert.equal(value.rows[0].type, 'error'); assert.equal(value.rows[0].status, 413);
    assert.doesNotMatch(value.raw, /OMIT_PRIVATE|payload/);
  }
});

test('progress event budget stops a looping producer after 256 messages', async () => {
  let signal;
  const value = await events(respond(async (_user, _input, context) => {
    signal = context.signal;
    for (let index = 0; index < 257; index++) { try { context.onProgress(progress); } catch {} }
    return { marker: 'OMIT_PRIVATE_RESULT' };
  })('synthetic-owner', args));
  assert(signal.aborted); assert.equal(value.rows.filter(row => row.type === 'progress').length, 256);
  assert.equal(value.rows.length, 257); assert.equal(value.rows.at(-1).type, 'error'); assert.equal(value.rows.at(-1).status, 413);
  assert.doesNotMatch(value.raw, /OMIT_PRIVATE/);
});

test('unknown or unsafe-status failures become fixed terminal errors without raw messages', async () => {
  for (const error of [new Error('OMIT_PRIVATE_EXCEPTION'), new EveError('OMIT_PRIVATE_EXCEPTION', 999), new EveError('OMIT_PRIVATE_EXCEPTION', 404)]) {
    const value = await events(respond(async () => { throw error; })('synthetic-owner', args));
    assert.equal(value.rows.length, 1); assert.equal(value.rows[0].type, 'error');
    assert.equal(value.rows[0].status, error.status === 404 ? 404 : 502);
    assert.doesNotMatch(value.raw, /OMIT_PRIVATE/);
  }
});

test('response-body cancellation reaches pending work and suppresses late callback/result', async () => {
  let context, release;
  const response = respond(async (_user, _input, value) => {
    context = value; value.onProgress(progress);
    await new Promise(resolve => { release = resolve; });
    value.onProgress({ ...progress, pagesRead: 1 }); return { marker: 'OMIT_PRIVATE_LATE' };
  })('synthetic-owner', args);
  const reader = response.body.getReader(); assert.equal((await reader.read()).done, false);
  await reader.cancel(); assert(context.signal.aborted);
  release(); await Promise.resolve(); await Promise.resolve(); assert.equal((await reader.read()).done, true);
});

test('originating request cancellation suppresses late output even when a reader ignores abort', async () => {
  const controller = new AbortController(); let context, release;
  const response = respond(async (_user, _input, value) => {
    context = value; await new Promise(resolve => { release = resolve; });
    value.onProgress(progress); return { marker: 'OMIT_PRIVATE_LATE' };
  })('synthetic-owner', args, controller.signal);
  controller.abort(); assert(context.signal.aborted); release();
  assert.equal((await events(response)).raw, '');
});
