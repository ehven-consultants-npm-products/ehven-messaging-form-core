const instances = new WeakMap();
let sequence = 0;
const defaultCopy = Object.freeze({
  working: 'Sending your submission…', accepted: 'Thank you. Your submission has been received.',
  simulated: 'Simulation complete. Nothing was delivered.',
  failure: 'Your submission could not be confirmed. Review the form before trying again.',
  network: 'Delivery could not be confirmed because of a network problem. Please wait before trying again.',
});
const attribute = (element, name, value) => value === null ? element.removeAttribute(name) : element.setAttribute(name, value);

/** Enhance an existing HTML form without owning its renderer or provider. */
export function enhanceMessagingForm(form, options = {}) {
  if (!form?.ownerDocument || form.tagName !== 'FORM') throw new TypeError('An HTML form is required.');
  if (instances.has(form)) return instances.get(form);
  const doc = form.ownerDocument, view = doc.defaultView;
  const { status = form.querySelector('[data-form-status]'), timeoutMs = 30000, verification, resetOnSuccess = true, allowCrossOrigin = false } = options;
  if (!status || !form.contains(status)) throw new TypeError('A status element inside the form is required.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new TypeError('Invalid request timeout.');
  const endpoint = new URL(options.endpoint ?? form.getAttribute('action') ?? doc.URL, doc.baseURI);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || (!allowCrossOrigin && endpoint.origin !== new URL(doc.URL).origin)) throw new TypeError('The endpoint must use an allowed HTTP origin.');
  if (form.method.toLowerCase() !== 'post') throw new TypeError('Messaging forms must use POST.');
  const fetchImpl = options.fetchImpl ?? view.fetch.bind(view);
  const copy = { ...defaultCopy, ...options.messages };
  if (Object.values(copy).some(value => typeof value !== 'string' || value.length > 2000)) throw new TypeError('Form messages must be bounded strings.');
  const original = { nodes: [...status.childNodes], hidden: status.hidden, kind: status.getAttribute('data-kind'), id: status.getAttribute('id'), live: status.getAttribute('aria-live'), busy: form.getAttribute('aria-busy') };
  if (!status.id || [...doc.querySelectorAll('[id]')].some(node => node !== status && node.id === status.id)) {
    do { status.id = `messaging-status-${++sequence}`; } while (doc.getElementById(status.id) !== status);
  }
  if (!status.hasAttribute('aria-live')) status.setAttribute('aria-live', 'polite');
  const statusId = status.id, events = new view.AbortController(), errors = new Map();
  let active, destroyed = false;
  const show = (message, kind) => { status.textContent = message; status.dataset.kind = kind; status.hidden = false; };
  const controls = name => [...form.elements].filter(field => field.name === name && typeof field.setCustomValidity === 'function');
  const clear = field => {
    const before = errors.get(field);
    if (!before) return;
    if (field.validity.customError && field.validationMessage === before.message) field.setCustomValidity(before.validity);
    if (field.getAttribute('aria-invalid') === 'true') attribute(field, 'aria-invalid', before.invalid);
    const current = (field.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    if (!before.hadDescription) {
      const remaining = current.filter(id => id !== statusId);
      attribute(field, 'aria-describedby', remaining.length ? remaining.join(' ') : before.description);
    }
    errors.delete(field);
  };
  const clearAll = () => { for (const field of [...errors.keys()]) clear(field); };
  const input = event => { for (const field of controls(event.target.name)) clear(field); };
  form.addEventListener('input', input, { signal: events.signal });
  form.addEventListener('change', input, { signal: events.signal });
  form.addEventListener('reset', clearAll, { signal: events.signal });
  const setErrors = items => {
    let first;
    for (const error of items) {
      if (typeof error?.field !== 'string' || typeof error.message !== 'string') continue;
      for (const field of controls(error.field).filter(field => !field.disabled && field.type !== 'hidden')) {
        const description = field.getAttribute('aria-describedby');
        const ids = (description ?? '').split(/\s+/).filter(Boolean);
        errors.set(field, { invalid: field.getAttribute('aria-invalid'), description, hadDescription: ids.includes(statusId), validity: field.validity.customError ? field.validationMessage : '', message: error.message });
        field.setCustomValidity(error.message);
        field.setAttribute('aria-invalid', 'true');
        field.setAttribute('aria-describedby', [...new Set([...ids, statusId])].join(' '));
        first ??= field;
      }
    }
    first?.focus();
    first?.reportValidity();
  };
  const settle = operation => {
    for (const [button, disabled] of operation.buttons) button.disabled = disabled;
    attribute(form, 'aria-busy', original.busy);
    if (active === operation) active = undefined;
  };
  async function submit(event) {
    event.preventDefault();
    if (active || destroyed || !form.reportValidity()) return;
    clearAll();
    const buttons = [...form.querySelectorAll('button[type="submit"], button:not([type]), input[type="submit"]')].map(button => [button, button.disabled]);
    const operation = { controller: new view.AbortController(), buttons };
    active = operation;
    for (const [button] of buttons) button.disabled = true;
    form.setAttribute('aria-busy', 'true');
    show(copy.working, 'working');
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        operation.controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        timer = setTimeout(() => operation.controller.abort(), timeoutMs);
      });
      const result = await Promise.race([(async () => {
        const body = new view.FormData(form);
        if (event.submitter?.name) body.append(event.submitter.name, event.submitter.value);
        const response = await fetchImpl(endpoint.href, { method: 'POST', body, headers: { Accept: 'application/json' }, credentials: endpoint.origin === new URL(doc.URL).origin ? 'same-origin' : 'omit', redirect: 'error', signal: operation.controller.signal });
        const result = await response.json().catch(() => null);
        return { response, result };
      })(), timeout]);
      if (destroyed || active !== operation) return;
      if (!result.response.ok || result.result?.ok !== true || !['accepted', 'simulated'].includes(result.result.outcome ?? 'accepted')) {
        show(typeof result.result?.message === 'string' ? result.result.message : copy.failure, 'error');
        setErrors(Array.isArray(result.result?.errors) ? result.result.errors : []);
        return;
      }
      const outcome = result.result.outcome ?? 'accepted';
      if (resetOnSuccess) form.reset();
      show(copy[outcome], outcome === 'simulated' ? 'simulated' : 'success');
      form.dispatchEvent(new view.CustomEvent('messaging:result', { detail: { ok: true, outcome }, bubbles: true }));
    } catch {
      if (!destroyed && active === operation) show(copy.network, 'error');
    } finally {
      clearTimeout(timer);
      if (!destroyed) {
        try { Promise.resolve(verification?.reset?.({ form })).catch(() => {}); } catch { /* Provider recovery must not leave Submit disabled. */ }
        settle(operation);
      }
    }
  }
  form.addEventListener('submit', submit, { signal: events.signal });
  const controller = Object.freeze({
    get pending() { return Boolean(active); },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      events.abort();
      if (active) { active.controller.abort(); settle(active); }
      clearAll();
      status.replaceChildren(...original.nodes);
      status.hidden = original.hidden;
      attribute(status, 'data-kind', original.kind);
      attribute(status, 'id', original.id);
      attribute(status, 'aria-live', original.live);
      attribute(form, 'aria-busy', original.busy);
      instances.delete(form);
    },
  });
  instances.set(form, controller);
  return controller;
}
