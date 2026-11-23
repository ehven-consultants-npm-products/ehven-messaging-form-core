import { OperationFailure as RequestFailure, withDeadline as deadline } from './execution.mjs';

const defaultFields = ['first_name', 'last_name', 'email', 'email_confirmation', 'source', 'website'];
const mediaTypes = new Set(['application/x-www-form-urlencoded', 'multipart/form-data']);
const noStore = { 'Cache-Control': 'no-store' };
const safePath = path => typeof path === 'string' && /^\/(?!\/)/.test(path) && !/[\u0000-\u0020\\\u007f]/.test(path);

/** Read only up to the configured bound, cancelling the stream on rejection. */
export async function readBoundedFormData(request, { maxRequestBytes = 32768, maxFields = 64, timeoutMs = 15000 } = {}) {
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1 || maxRequestBytes > 1048576 || !Number.isSafeInteger(maxFields) || maxFields < 1 || maxFields > 1024 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new TypeError('Invalid request limits.');
  const type = (request.headers.get('Content-Type') ?? '').split(';', 1)[0].trim().toLowerCase();
  if (!mediaTypes.has(type)) throw new RequestFailure(415, 'unsupported_media_type');
  const length = request.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) throw new RequestFailure(400, 'invalid_content_length');
  if (length !== null && Number(length) > maxRequestBytes) throw new RequestFailure(413, 'payload_too_large');
  if (!request.body) throw new RequestFailure(400, 'invalid_form');
  const reader = request.body.getReader(), chunks = [];
  let size = 0, complete = false;
  try {
    await deadline(async signal => {
      const cancel = () => { reader.cancel().catch(() => {}); };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (signal.aborted) throw new RequestFailure(408, 'request_aborted');
          if (done) { complete = true; break; }
          size += value.byteLength;
          if (size > maxRequestBytes) throw new RequestFailure(413, 'payload_too_large');
          chunks.push(value);
        }
      } finally { signal.removeEventListener('abort', cancel); }
    }, timeoutMs, request.signal);
  } finally {
    if (!complete) reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let form;
  try { form = await new Request(request.url, { method: 'POST', headers: { 'Content-Type': request.headers.get('Content-Type') }, body: bytes }).formData(); }
  catch { throw new RequestFailure(400, 'invalid_form'); }
  let count = 0;
  for (const [, value] of form) {
    if (++count > maxFields) throw new RequestFailure(413, 'too_many_fields');
    if (typeof value !== 'string') throw new RequestFailure(422, 'files_not_supported');
  }
  return form;
}

const defaultCopy = Object.freeze({
  accepted: 'Thank you. Your submission has been received.',
  simulated: 'Simulation complete. Nothing was delivered.',
  invalid: 'Please review the highlighted fields and try again.',
  verification: 'Please complete the security check and try again.',
  unavailable: 'Form processing is temporarily unavailable.',
  delivery: 'Delivery could not be confirmed. Please wait before trying again.',
  request: 'The form could not be processed.',
});

/** Provider-neutral POST processing. Authorization and rate limiting belong to the host. */
export async function handleMessagingRequest(request, env, options = {}) {
  const { validate, verifyHuman, deliver, successLocation, simulationLocation, successFallback = '/', fields = [], timeoutMs = 15000, verificationField = 'cf-turnstile-response' } = options;
  const copy = { ...defaultCopy, ...options.messages };
  if (Object.values(copy).some(value => typeof value !== 'string' || value.length > 2000)) throw new TypeError('Response copy must contain bounded strings.');
  if (!Array.isArray(fields) || fields.some(field => typeof field !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(field)) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new TypeError('Invalid transport configuration.');
  const html = !(request.headers.get('Accept') ?? '').includes('application/json') && (request.headers.get('Accept') ?? '').includes('text/html');
  const failure = (status, code, message, errors = [], headers = {}) => html
    ? new Response(message, { status, headers: { ...noStore, 'Content-Type': 'text/plain; charset=utf-8', ...headers } })
    : Response.json({ ok: false, code, message, errors }, { status, headers: { ...noStore, ...headers } });
  const success = (data, outcome = 'accepted') => {
    if (html) {
      let location;
      try { location = (outcome === 'simulated' ? simulationLocation : successLocation)?.(data.source); } catch { /* A receipt must survive a failing presentation callback. */ }
      if (outcome === 'simulated' && !safePath(location)) return new Response(copy.simulated, { status: 200, headers: { ...noStore, 'Content-Type': 'text/plain; charset=utf-8' } });
      return new Response(null, { status: 303, headers: { ...noStore, Location: safePath(location) ? location : safePath(successFallback) ? successFallback : '/' } });
    }
    return Response.json({ ok: true, outcome, message: copy[outcome] }, { status: outcome === 'simulated' ? 200 : 202, headers: noStore });
  };
  if (request.method !== 'POST') return failure(405, 'method_not_allowed', copy.request, [], { Allow: 'POST' });
  let formData;
  try { formData = await readBoundedFormData(request, { maxRequestBytes: options.maxRequestBytes, maxFields: options.maxFields, timeoutMs }); }
  catch (error) { return failure(error instanceof RequestFailure ? error.status : 400, error instanceof RequestFailure ? error.code : 'invalid_form', copy.request); }
  const selectedFields = [...new Set([...defaultFields, ...fields])];
  const duplicates = selectedFields.filter(name => formData.getAll(name).length > 1);
  if (duplicates.length) return failure(422, 'invalid_fields', copy.invalid, duplicates.map(field => ({ field, code: 'duplicate', message: 'Provide one value for this field.' })));
  if (typeof validate !== 'function') return failure(503, 'validation_unavailable', copy.unavailable);
  let validation;
  try {
    validation = await deadline(signal => validate(Object.fromEntries(selectedFields.map(name => [name, formData.get(name)])), formData, { signal }), timeoutMs, request.signal);
    if (!validation || typeof validation.ok !== 'boolean' || !validation.data || typeof validation.data !== 'object' || !Array.isArray(validation.errors) || validation.errors.some(e => !e || typeof e.field !== 'string' || typeof e.code !== 'string' || typeof e.message !== 'string')) throw new TypeError('Invalid validator result.');
  } catch { return failure(503, 'validation_unavailable', copy.unavailable); }
  if (validation.spam === true) return success(validation.data);
  if (!validation.ok) return failure(422, 'invalid_fields', copy.invalid, validation.errors);
  if (typeof verifyHuman !== 'function') return failure(503, 'verification_unavailable', copy.unavailable);
  let human;
  try { human = await deadline(signal => verifyHuman({ request, env, formData, signal }), timeoutMs, request.signal); }
  catch { return failure(503, 'verification_unavailable', copy.unavailable); }
  if (!human || typeof human.ok !== 'boolean') return failure(503, 'verification_unavailable', copy.unavailable);
  if (!human.ok) return failure(422, 'verification_failed', copy.verification, [{ field: verificationField, code: 'verification_failed', message: copy.verification }]);
  if (typeof deliver !== 'function') return failure(503, 'delivery_unavailable', copy.unavailable, [], { 'Retry-After': '3600' });
  let acceptedOutcome, deliveryActive = true;
  const markAccepted = outcome => {
    if (!['accepted', 'simulated'].includes(outcome)) throw new TypeError('Invalid acceptance outcome.');
    if (deliveryActive && acceptedOutcome === undefined) acceptedOutcome = outcome;
  };
  try {
    const result = await deadline(signal => deliver(validation.data, { request, env, formData, signal, markAccepted }), timeoutMs, request.signal);
    // Undefined retains compatibility with existing throw-on-failure delivery callbacks.
    if (result !== undefined && (!result || result.ok !== true || result.outcome !== undefined && !['accepted', 'simulated'].includes(result.outcome))) throw new TypeError('Delivery failed.');
    return success(validation.data, acceptedOutcome ?? result?.outcome ?? 'accepted');
  } catch { return acceptedOutcome ? success(validation.data, acceptedOutcome) : failure(502, 'delivery_unconfirmed', copy.delivery); }
  finally { deliveryActive = false; }
}
