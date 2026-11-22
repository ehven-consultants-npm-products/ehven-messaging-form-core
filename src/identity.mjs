export const MESSAGING_FIELD_LIMITS = Object.freeze({ firstName: 80, lastName: 80, email: 254, source: 80 });
const names = Object.freeze({ firstName: 'first_name', lastName: 'last_name', email: 'email', confirmation: 'email_confirmation', source: 'source', honeypot: 'website' });
const labels = { firstName: 'first name', lastName: 'last name', email: 'email address', confirmation: 'email address again', source: 'form source' };
const unsafe = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const emailShape = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Compile consumer-owned identity choices without importing host or provider configuration. */
export function createIdentityValidator(options = {}) {
  if (!record(options)) throw new TypeError('Identity options must be an object.');
  for (const key of Object.keys(options)) if (!['fieldNames', 'limits', 'required', 'emailConfirmation', 'allowedSources', 'messages'].includes(key)) throw new TypeError('Unknown identity option.');
  const fields = { ...names }, limits = { ...MESSAGING_FIELD_LIMITS }, required = { firstName: true, lastName: true, email: true, source: true };
  for (const key of ['fieldNames', 'limits', 'required']) if (options[key] !== undefined && !record(options[key])) throw new TypeError('Identity mappings must be objects.');
  for (const [key, value] of Object.entries(options.fieldNames ?? {})) {
    if (!Object.hasOwn(names, key) || typeof value !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(value)) throw new TypeError('Invalid identity field mapping.');
    fields[key] = value;
  }
  if (new Set(Object.values(fields)).size !== Object.keys(fields).length) throw new TypeError('Identity field names must be distinct.');
  for (const [key, value] of Object.entries(options.limits ?? {})) {
    if (!Object.hasOwn(limits, key) || !Number.isSafeInteger(value) || value < 1 || value > 32768) throw new TypeError('Invalid identity limit.');
    limits[key] = value;
  }
  for (const [key, value] of Object.entries(options.required ?? {})) {
    if (!Object.hasOwn(required, key) || typeof value !== 'boolean') throw new TypeError('Invalid identity requirement.');
    required[key] = value;
  }
  if (options.emailConfirmation !== undefined && typeof options.emailConfirmation !== 'boolean') throw new TypeError('emailConfirmation must be boolean.');
  const confirm = options.emailConfirmation !== false;
  if (options.allowedSources !== undefined && (!Array.isArray(options.allowedSources) || options.allowedSources.some(value => typeof value !== 'string' || !value || unsafe.test(value)))) throw new TypeError('allowedSources must be a string array.');
  const allowed = options.allowedSources && new Set(options.allowedSources);
  if (options.messages !== undefined && (!record(options.messages) || Object.values(options.messages).some(v => typeof v !== 'string' || v.length > 2000))) throw new TypeError('messages must contain strings.');
  const messages = { ...options.messages };
  return function validateIdentity(values) {
    if (!record(values)) throw new TypeError('Identity values must be an object.');
    const errors = [], data = {};
    const add = (key, code, fallback) => errors.push({ field: fields[key], code, message: messages[`${key}.${code}`] ?? fallback });
    for (const key of ['firstName', 'lastName', 'email', 'source']) {
      const raw = values[fields[key]];
      const validType = raw == null || typeof raw === 'string';
      const value = validType ? (raw ?? '').trim().replace(/\s+/gu, ' ') : '';
      data[key] = value;
      if (!validType || (typeof raw === 'string' && unsafe.test(raw))) add(key, 'invalid', `Enter a valid ${labels[key]}.`);
      else if (!value && required[key]) add(key, 'required', `Enter your ${labels[key]}.`);
      else if (value.length > limits[key]) add(key, 'too_long', `Your ${labels[key]} is too long.`);
      else if (key === 'email' && value && !emailShape.test(value)) add(key, 'invalid', 'Enter a valid email address.');
      else if (key === 'source' && allowed && !allowed.has(value)) add(key, 'invalid', 'The form source is invalid.');
    }
    if (confirm) {
      const raw = values[fields.confirmation];
      const value = typeof raw === 'string' ? raw.trim() : '';
      if (raw != null && typeof raw !== 'string' || typeof raw === 'string' && unsafe.test(raw)) add('confirmation', 'invalid', 'Enter a valid confirmation email.');
      else if (!value && (required.email || data.email)) add('confirmation', 'required', 'Enter your email address again.');
      else if (value.length > limits.email) add('confirmation', 'too_long', 'Your confirmation email is too long.');
      else if (value.toLowerCase() !== data.email.toLowerCase()) add('confirmation', 'mismatch', 'The email addresses do not match.');
    }
    const honey = values[fields.honeypot];
    return { ok: errors.length === 0, spam: honey != null && (typeof honey !== 'string' || honey.trim() !== ''), errors, data };
  };
}

const defaultValidator = createIdentityValidator();
export function validateFormIdentity(values, options) {
  return options === undefined ? defaultValidator(values) : createIdentityValidator(options)(values);
}
