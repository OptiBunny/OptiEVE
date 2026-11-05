import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const fixtureModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(readFileSync('app/lib/request-body.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, { module: fixtureModule, exports: fixtureModule.exports, TextDecoder, Uint8Array });
const { readRequestBody, drainRequestBody, RequestBodyTooLargeError } = fixtureModule.exports;
const encoder = new TextEncoder();

function streamed(chunks) {
  let index = 0, cancelled = false;
  const body = new ReadableStream({
    pull(controller) { if (index < chunks.length) controller.enqueue(chunks[index++]); else controller.close(); },
    cancel() { cancelled = true; },
  });
  return {
    request: new Request('https://example.chatgpt.site/', { method: 'POST', duplex: 'half', body }),
    consumed: () => index,
    cancelled: () => cancelled,
  };
}

test('empty bodies and exact byte limits are accepted', async () => {
  assert.equal(await readRequestBody(new Request('https://example.chatgpt.site/'), 0), '');
  const { request } = streamed([encoder.encode('test')]);
  assert.equal(await readRequestBody(request, 4), 'test');
});

test('UTF-8 characters split across chunks decode correctly', async () => {
  const bytes = encoder.encode('aé🙂z');
  const fixture = streamed(Array.from(bytes, byte => Uint8Array.of(byte)));
  assert.equal(await readRequestBody(fixture.request, bytes.length), 'aé🙂z');
  assert.equal(fixture.consumed(), bytes.length);
});

test('UTF-8 byte limits cannot be bypassed with multibyte text', async () => {
  const fixture = streamed([encoder.encode('éé')]);
  await assert.rejects(readRequestBody(fixture.request, 3), error => error instanceof RequestBodyTooLargeError);
  assert.equal(fixture.cancelled(), false);
});

test('overflow drains all subsequent chunks without cancelling', async () => {
  const chunks = Array.from({ length: 128 }, () => new Uint8Array(1024));
  const fixture = streamed(chunks);
  await assert.rejects(readRequestBody(fixture.request, 4096), error => error instanceof RequestBodyTooLargeError);
  assert.equal(fixture.consumed(), chunks.length);
  assert.equal(fixture.cancelled(), false);
  assert.equal(fixture.request.body.locked, false);
});

test('overflow waits for draining to finish, preserving the local transport', async () => {
  let streamController;
  const body = new ReadableStream({ start(controller) { streamController = controller; } });
  const request = new Request('https://example.chatgpt.site/', { method: 'POST', duplex: 'half', body });
  let settled = false;
  const reading = readRequestBody(request, 4).finally(() => { settled = true; });
  const rejected = assert.rejects(reading, error => error instanceof RequestBodyTooLargeError);
  streamController.enqueue(new Uint8Array(4096));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  streamController.close();
  await rejected;
});

test('retained data is copied rather than keeping an oversized backing buffer', async () => {
  const backing = new Uint8Array(1024 * 1024);
  backing.set(encoder.encode('test'));
  let pulled = 0, released = false;
  // A controlled reader avoids ReadableStream's eager prefetch changing the
  // source buffer before the consumer has received its first chunk.
  const request = { body: { getReader: () => ({
    async read() {
      if (pulled++ === 0) return { done: false, value: backing.subarray(0, 4) };
      backing.fill(0);
      return { done: true };
    },
    releaseLock() { released = true; },
  }) } };
  assert.equal(await readRequestBody(request, 4), 'test');
  assert.equal(released, true);
});

test('rejected request draining consumes a body and never cancels it', async () => {
  const fixture = streamed([encoder.encode('one'), encoder.encode('two')]);
  await drainRequestBody(fixture.request);
  assert.equal(fixture.consumed(), 2);
  assert.equal(fixture.cancelled(), false);
  assert.equal(fixture.request.body.locked, false);
  await drainRequestBody(fixture.request);
});

test('stream errors release the reader and do not replace a rejected response', async () => {
  const broken = () => new Request('https://example.chatgpt.site/', {
    method: 'POST', duplex: 'half', body: new ReadableStream({ pull(controller) { controller.error(new Error('Synthetic stream failure')); } }),
  });
  const reading = broken();
  await assert.rejects(readRequestBody(reading, 4096), /Synthetic stream failure/);
  assert.equal(reading.body.locked, false);
  const draining = broken();
  await drainRequestBody(draining);
  assert.equal(draining.body.locked, false);
});
