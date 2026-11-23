export class OperationFailure extends Error {
  constructor(status, code) { super(code); this.name = 'OperationFailure'; this.status = status; this.code = code; }
}

/** Bound asynchronous work; cancellation cannot undo an external side effect. */
export async function withDeadline(task, milliseconds, signal) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 120000) throw new TypeError('Invalid operation deadline.');
  const controller = new AbortController();
  let timer, rejectAbort;
  const abort = () => { controller.abort(); rejectAbort?.(new OperationFailure(408, 'request_aborted')); };
  const stop = new Promise((_, reject) => {
    rejectAbort = reject;
    timer = setTimeout(() => { controller.abort(); reject(new OperationFailure(504, 'operation_timeout')); }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
  try {
    return await Promise.race([Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new OperationFailure(408, 'request_aborted');
      return task(controller.signal);
    }), stop]);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
