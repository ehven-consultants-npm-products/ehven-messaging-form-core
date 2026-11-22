import assert from 'node:assert/strict';
import test from 'node:test';
import { handleMessagingRequest } from '../src/server/index.mjs';
import { validateFormIdentity } from '../src/index.mjs';
const values = { first_name: 'Example', last_name: 'Person', email: 'user@example.org', email_confirmation: 'user@example.org', source: 'support', website: '' };
const request = (delta = {}, accept = 'application/json') => new Request('https://example.org/submit', { method: 'POST', headers: { Accept: accept }, body: new URLSearchParams({ ...values, ...delta }) });
const options = { validate: validateFormIdentity, verifyHuman: async () => ({ ok: true }), deliver: async () => ({ ok: true }) };
const run = (opts = {}, req = request()) => handleMessagingRequest(req, {}, { ...options, ...opts });

test('source and server entrypoints import independently without DOM globals or Astro', async () => { assert.equal((await import('../src/browser/index.mjs')).enhanceMessagingForm instanceof Function, true); });
test('method, unsupported media and malformed body failures remain no-store', async () => {
  for (const [req, status] of [[new Request('https://example.org'), 405], [new Request('https://example.org', { method: 'POST', body: '{}' }), 415], [new Request('https://example.org', { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=bad' }, body: 'broken' }), 400]]) {
    const response = await run({}, req);
    assert.equal(response.status, status);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
});
test('streamed oversized bodies are cancelled before consuming the whole upload', async () => {
  let pulled = 0, cancelled = false;
  const body = new ReadableStream({ pull(controller) { pulled++; controller.enqueue(new Uint8Array(4096)); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  const response = await run({ maxRequestBytes: 8192 }, new Request('https://example.org', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, duplex: 'half' }));
  assert.equal(response.status, 413);
  assert.equal(cancelled, true);
  assert.ok(pulled <= 3, `read ${pulled} chunks`);
});
test('slow body and non-cooperating verification are bounded', async () => {
  let cancelled = false;
  const body = new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled = true; } });
  const response = await run({ timeoutMs: 20 }, new Request('https://example.org', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, duplex: 'half' }));
  assert.equal(response.status, 504);
  assert.equal(cancelled, true);
  assert.equal((await run({ timeoutMs: 20, verifyHuman: () => new Promise(() => {}) })).status, 503);
});
test('duplicate scalar values and files cannot bypass validation', async () => {
  const body = new FormData();
  for (const [key, value] of Object.entries(values)) body.append(key, value);
  body.append('email', 'other@example.org');
  let response = await run({}, new Request('https://example.org', { method: 'POST', body }));
  assert.equal((await response.json()).errors[0].code, 'duplicate');
  body.delete('email'); body.set('upload', new Blob(['data']), 'file.txt');
  response = await run({}, new Request('https://example.org', { method: 'POST', body }));
  assert.equal((await response.json()).code, 'files_not_supported');
});
test('missing and malformed validators/verifiers fail closed; operational errors never escape', async () => {
  for (const opts of [{ validate: undefined }, { validate: () => null }, { validate: () => { throw Error('secret'); } }, { verifyHuman: undefined }, { verifyHuman: () => null }, { verifyHuman: () => { throw Error('secret'); } }, { deliver: undefined }]) {
    const response = await run(opts);
    assert.equal(response.status, 503);
    assert.equal((await response.text()).includes('secret'), false);
  }
});
test('invalid fields precede verification; honeypots bypass providers without revealing detection', async () => {
  let calls = 0;
  const opts = { verifyHuman: async () => { calls++; return { ok: true }; }, deliver: async () => { calls++; } };
  assert.equal((await run(opts, request({ email: '' }))).status, 422);
  const response = await run(opts, request({ website: 'bot' }));
  assert.equal(response.status, 202); assert.equal(calls, 0);
  assert.equal((await response.text()).includes('spam'), false);
});
test('unsuccessful delivery return values cannot masquerade as receipts', async () => {
  for (const value of [{ ok: false }, null, false, { ok: true, outcome: 'unknown' }]) assert.equal((await run({ deliver: async () => value })).status, 502);
  assert.equal((await run({ deliver: async () => undefined })).status, 202);
});
test('simulation is explicit and native simulation never falls back to a real sent route', async () => {
  const opts = { deliver: async () => ({ ok: true, outcome: 'simulated' }), successLocation: () => '/?sent=true' };
  assert.equal((await (await run(opts)).json()).outcome, 'simulated');
  const native = await run(opts, request({}, 'text/html'));
  assert.equal(native.status, 200); assert.equal(native.headers.get('Location'), null);
  assert.match(await native.text(), /Nothing was delivered/);
});
test('native redirects reject external, control-character and backslash destinations', async () => {
  for (const path of ['//evil.example', '/\\evil.example', '/\t/evil.example', 'https://evil.example']) {
    const response = await run({ successLocation: () => path, successFallback: '/done' }, request({}, 'text/html'));
    assert.equal(response.status, 303); assert.equal(response.headers.get('Location'), '/done');
  }
  const response = await run({ successLocation: () => { throw Error('route'); } }, request({}, 'text/html'));
  assert.equal(response.status, 303);
});
test('custom schemas consume declared extra fields without contact/request dependencies', async () => {
  let delivered;
  await run({ fields: ['topic'], validate(values, form) { const result = validateFormIdentity(values); return { ...result, data: { ...result.data, topic: form.get('topic') } }; }, deliver: async data => { delivered = data; } }, request({ topic: 'Setup' }));
  assert.equal(delivered.topic, 'Setup'); assert.equal('message' in delivered, false);
});
test('server never automatically retries a timed-out delivery', async () => {
  let calls = 0, signal;
  const response = await run({ timeoutMs: 20, deliver: (_data, context) => { calls++; signal = context.signal; return new Promise(() => {}); } });
  assert.equal(response.status, 502); assert.equal(calls, 1); assert.equal(signal.aborted, true);
});
