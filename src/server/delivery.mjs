import { OperationFailure, withDeadline } from './execution.mjs';

export class DeliveryPipelineError extends Error {
  constructor(code = 'primary_failed') { super('Primary delivery could not be confirmed.'); this.name = 'DeliveryPipelineError'; this.code = code; }
}

/** One required acceptance operation, followed by an optional, non-blocking receipt. */
export function createDeliveryPipeline(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Delivery options must be an object.');
  for (const key of Object.keys(options)) if (!['accept', 'acknowledge', 'timeoutMs', 'acknowledgmentTimeoutMs', 'onDiagnostic'].includes(key)) throw new TypeError('Unknown delivery option.');
  const { accept, acknowledge, timeoutMs = 15000, acknowledgmentTimeoutMs = 5000, onDiagnostic } = options;
  if (typeof accept !== 'function' || acknowledge !== undefined && typeof acknowledge !== 'function' || onDiagnostic !== undefined && typeof onDiagnostic !== 'function') throw new TypeError('Delivery operations must be functions.');
  for (const value of [timeoutMs, acknowledgmentTimeoutMs]) if (!Number.isSafeInteger(value) || value < 1 || value > 120000) throw new TypeError('Invalid delivery timeout.');
  const diagnostic = event => {
    try { Promise.resolve(onDiagnostic?.(Object.freeze(event))).catch(() => {}); } catch { /* Diagnostics cannot invalidate a receipt. */ }
  };
  return async function deliver(data, context = {}) {
    const correlationId = crypto.randomUUID();
    let primary;
    try {
      primary = await withDeadline(signal => accept(data, { ...context, signal, correlationId }), timeoutMs, context.signal);
      if (primary !== undefined && (!primary || primary.ok !== true || primary.outcome !== undefined && !['accepted', 'simulated'].includes(primary.outcome))) throw new DeliveryPipelineError();
    } catch (error) {
      const code = error instanceof OperationFailure ? error.code : 'primary_failed';
      diagnostic({ correlationId, phase: 'primary', code });
      throw new DeliveryPipelineError(code);
    }
    const outcome = primary?.outcome ?? 'accepted';
    // Inform the HTTP processor as soon as the irreversible primary operation succeeds.
    // Its outer timeout must never turn a subsequent receipt problem into a retry invitation.
    context.markAccepted?.(outcome);
    const result = { ok: true, outcome, correlationId, acknowledgment: { status: 'skipped' } };
    if (outcome === 'simulated' || !acknowledge || context.signal?.aborted) return result;
    try {
      const receipt = await withDeadline(signal => acknowledge(data, { ...context, signal, correlationId, primaryResult: primary }), acknowledgmentTimeoutMs, context.signal);
      if (receipt !== undefined && (!receipt || receipt.ok !== true || receipt.outcome !== undefined && receipt.outcome !== 'skipped')) throw new Error('Receipt failed.');
      result.acknowledgment = { status: receipt?.outcome === 'skipped' ? 'skipped' : 'sent' };
    } catch (error) {
      const code = error instanceof OperationFailure ? error.code : 'acknowledgment_failed';
      result.acknowledgment = { status: 'failed', code };
      diagnostic({ correlationId, phase: 'acknowledgment', code });
    }
    return result;
  };
}
