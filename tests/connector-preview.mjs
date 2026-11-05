import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { connectorPreview } from '../scripts/vite/connector-preview-plugin.mjs';

function setup(serverOptions = {}) {
  const plugin = connectorPreview();
  const configured = plugin.config({ server: serverOptions });
  const server = { port: 5173, ...serverOptions, host: configured.server.host };
  plugin.configResolved({ root: process.cwd(), server });
  const handlers = new Map();
  plugin.configureServer({ config: { server }, middlewares: { use(path, handler) { handlers.set(path, handler); } } });
  return { plugin, configured, handlers, server };
}

async function adapterRequests(fixture) {
  const code = fixture.plugin.load.call({ environment: { name: 'rsc' } }, '\0virtual:sites-connector-preview', { ssr: true });
  const binding = (await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))).default;
  const originalFetch = globalThis.fetch, calls = [];
  globalThis.fetch = async (target, options) => { calls.push({ target: new URL(target), options }); return Response.json({ status: 'binding_unavailable' }); };
  try { await binding.getContext(); await binding.invoke('synthetic', 'read', {}); }
  finally { globalThis.fetch = originalFetch; }
  return calls;
}

for (const [name, host, expected] of [
  ['default', undefined, '127.0.0.1'], ['IPv4 loopback', '127.0.0.1', '127.0.0.1'],
  ['IPv4 wildcard', '0.0.0.0', '127.0.0.1'], ['wildcard shorthand', true, '127.0.0.1'],
  ['localhost', 'localhost', 'localhost'], ['local shorthand', false, 'localhost'],
  ['IPv6 loopback', '::1', '[::1]'], ['IPv6 wildcard', '::', '[::1]'],
]) test(`preview bridge uses a compatible local address for ${name}`, async () => {
  const fixture = setup(host === undefined ? {} : { host });
  const calls = await adapterRequests(fixture);
  assert.equal(calls.length, 2);
  for (const { target, options } of calls) {
    assert.equal(target.protocol, 'http:'); assert.equal(target.hostname, expected); assert.equal(target.port, '5173');
    assert.match(options.headers['X-Sites-Preview'], /^[0-9a-f-]{36}$/);
  }
  assert.equal(calls[0].target.pathname, '/__sites_connector_preview/context');
  assert.equal(calls[1].target.pathname, '/__sites_connector_preview/invoke');
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(fixture.configured.server.strictPort, true);
  assert(fixture.configured.server.fs.deny.includes('**/.sites-runtime/**'));
});

for (const https of [true, {}]) test('HTTPS preview configuration is rejected explicitly before exposing a bridge', () => {
  assert.throws(() => setup({ https }), /HTTP/i);
});

for (const host of ['untrusted.example', '192.0.2.8', '[::1]', '', '127.1']) test('unsupported listener settings cannot send the bridge secret to another host', () => {
  assert.throws(() => setup({ host }), /host/i);
});

for (const port of [0, -1, 65536, 1.5, '5173', NaN, Infinity]) test('preview rejects unstable or invalid listener ports', () => {
  assert.throws(() => setup({ port }), /port/i);
});

test('CLI/resolved configuration overrides receive the same safety checks', () => {
  const plugin = connectorPreview(); plugin.config({});
  assert.throws(() => plugin.configResolved({ root: process.cwd(), server: { host: 'untrusted.example', port: 5173 } }), /host/i);
  assert.throws(() => plugin.configResolved({ root: process.cwd(), server: { host: '127.0.0.1', https: {}, port: 5173 } }), /HTTP/i);
});

test('client transforms still cannot access the bridge capability', () => {
  const { plugin } = setup();
  assert.throws(() => plugin.load.call({ environment: { name: 'client' } }, '\0virtual:sites-connector-preview', { ssr: true }), /server routes/);
  assert.throws(() => plugin.load.call({}, '\0virtual:sites-connector-preview', { ssr: false }), /server routes/);
});

test('the bridge still rejects missing or incorrect authentication before reading a session', async () => {
  const { handlers } = setup();
  for (const [endpoint, method] of [['/__sites_connector_preview/context', 'GET'], ['/__sites_connector_preview/invoke', 'POST']]) {
    const req = Readable.from([Buffer.from('{}')]); Object.assign(req, { method, headers: { host: 'untrusted.example', origin: 'https://untrusted.example', 'x-sites-preview': 'invalid' } });
    let body, status;
    const res = { setHeader() {}, set statusCode(value) { status = value; }, end(value) { body = value; } };
    await handlers.get(endpoint)(req, res);
    assert.equal(status, 403); assert.equal(JSON.parse(body).status, 'binding_unavailable');
  }
});
