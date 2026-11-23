import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeliveryPipeline, DeliveryPipelineError, handleMessagingRequest } from '../src/server/index.mjs';
import { validateFormIdentity } from '../src/index.mjs';

test('the primary operation completes before acknowledgment and supplies its context', async () => {
  const events = [];
  const deliver = createDeliveryPipeline({ accept: async () => { events.push('record'); return { ok: true, id: 'synthetic-record' }; }, acknowledge: async (_data, context) => { assert.equal(context.primaryResult.id, 'synthetic-record'); events.push('receipt'); } });
  const result = await deliver({ firstName: 'Example' });
  assert.deepEqual(events, ['record', 'receipt']);
  assert.equal(result.ok, true); assert.equal(result.acknowledgment.status, 'sent');
});
test('failed or malformed primary results prevent acknowledgment and expose no provider details', async () => {
  let receipts = 0;
  for (const accept of [async () => { throw Error('private provider body'); }, async () => ({ ok: false }), async () => null, async () => ({ ok: true, outcome: 'unknown' })]) {
    await assert.rejects(createDeliveryPipeline({ accept, acknowledge: async () => { receipts++; } })({}), error => error instanceof DeliveryPipelineError && !error.message.includes('private'));
  }
  assert.equal(receipts, 0);
});
test('receipt failures preserve acceptance; diagnostics cannot break successful recording', async () => {
  const events = [];
  const deliver = createDeliveryPipeline({ accept: async () => {}, acknowledge: async () => { throw Error('email address or provider data'); }, onDiagnostic(event) { events.push(event); throw Error('logger outage'); } });
  const result = await deliver({ email: 'private@example.org' });
  assert.equal(result.ok, true); assert.equal(result.acknowledgment.status, 'failed');
  assert.deepEqual(Object.keys(events[0]).sort(), ['code', 'correlationId', 'phase']);
  assert.equal(JSON.stringify(events).includes('private@example.org'), false);
});
test('receipts can be omitted, explicitly skipped or suppressed during simulation', async () => {
  assert.equal((await createDeliveryPipeline({ accept: async () => {} })({})).acknowledgment.status, 'skipped');
  assert.equal((await createDeliveryPipeline({ accept: async () => {}, acknowledge: async () => ({ ok: true, outcome: 'skipped' }) })({})).acknowledgment.status, 'skipped');
  let sent = false;
  const result = await createDeliveryPipeline({ accept: async () => ({ ok: true, outcome: 'simulated' }), acknowledge: async () => { sent = true; } })({});
  assert.equal(result.outcome, 'simulated'); assert.equal(sent, false);
});
test('primary timeout and cancellation never invoke a receipt or retry the primary operation', async () => {
  let count = 0, sent = 0, signal;
  const deliver = createDeliveryPipeline({ timeoutMs: 15, accept: (_data, context) => { count++; signal = context.signal; return new Promise(() => {}); }, acknowledge: async () => { sent++; } });
  await assert.rejects(deliver({}), error => error.code === 'operation_timeout');
  assert.equal(signal.aborted, true); assert.equal(count, 1); assert.equal(sent, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(deliver({}, { signal: controller.signal }), error => error.code === 'request_aborted');
  assert.equal(count, 1);
});
test('receipt deadline returns accepted, even if a transport ignores cancellation', async () => {
  const result = await createDeliveryPipeline({ acknowledgmentTimeoutMs: 15, accept: async () => {}, acknowledge: () => new Promise(() => {}) })({});
  assert.equal(result.ok, true); assert.equal(result.acknowledgment.code, 'operation_timeout');
});
test('an outer HTTP timeout during acknowledgment cannot turn recorded data into failure', async () => {
  let primary = 0;
  const deliver = createDeliveryPipeline({ accept: async () => { primary++; }, acknowledge: () => new Promise(() => {}), acknowledgmentTimeoutMs: 1000 });
  const request = new Request('https://example.org/submit', { method: 'POST', body: new URLSearchParams({ first_name: 'Example', last_name: 'Person', email: 'user@example.org', email_confirmation: 'user@example.org', source: 'fixture' }) });
  const response = await handleMessagingRequest(request, {}, { timeoutMs: 25, validate: validateFormIdentity, verifyHuman: async () => ({ ok: true }), deliver });
  assert.equal(response.status, 202); assert.equal((await response.json()).outcome, 'accepted'); assert.equal(primary, 1);
});
test('invalid pipeline configuration fails before side effects', () => {
  for (const options of [{}, { accept: true }, { accept: () => {}, timeoutMs: -1 }, { accept: () => {}, acknowledge: false }, { accept: () => {}, queue: true }]) assert.throws(() => createDeliveryPipeline(options));
});
