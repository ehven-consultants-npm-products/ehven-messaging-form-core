import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createIdentityValidator, validateFormIdentity } from '../src/index.mjs';
const fields = { first_name: '  Example   Person ', last_name: 'אבני', email: 'User@example.org', email_confirmation: 'user@EXAMPLE.org', source: 'support', website: '' };
test('identity preserves Unicode and normalizes whitespace without changing the delivered email', () => {
  const result = validateFormIdentity(fields);
  assert.equal(result.ok, true);
  assert.equal(result.data.firstName, 'Example Person');
  assert.equal(result.data.email, 'User@example.org');
  assert.equal(result.data.lastName, 'אבני');
  assert.equal('emailConfirmation' in result.data, false);
});
test('identity rules are declarative and field names/messages can be localized', () => {
  const validate = createIdentityValidator({ fieldNames: { firstName: 'given' }, required: { lastName: false }, emailConfirmation: false, allowedSources: ['support'], messages: { 'firstName.required': 'שם נדרש' } });
  assert.equal(validate({ ...fields, given: 'Dana', last_name: '' }).ok, true);
  assert.equal(validate({ ...fields, given: '' }).errors[0].message, 'שם נדרש');
  assert.equal(validate({ ...fields, given: 'Dana', source: 'spoofed' }).ok, false);
});
test('invalid values, limits, confirmation and control characters are rejected', () => {
  for (const delta of [{ first_name: '\0hidden' }, { email: 'invalid' }, { email_confirmation: 'other@example.org' }, { last_name: 'x'.repeat(81) }, { first_name: new Blob(['file']) }]) assert.equal(validateFormIdentity({ ...fields, ...delta }).ok, false);
  assert.equal(validateFormIdentity({ ...fields, website: 'bot' }).spam, true);
});
test('invalid configuration cannot silently alter validation', () => {
  for (const config of [{ limits: { email: 0 } }, { fieldNames: { firstName: 'email' } }, { emailConfirmation: 'false' }, { required: { email: 'yes' } }, { allowedSources: 'support' }, { unknown: true }]) assert.throws(() => createIdentityValidator(config));
});
test('language-neutral contract vectors remain available for PHP conformance', async () => {
  const fixtures = JSON.parse(await readFile(new URL('./fixtures/identity.json', import.meta.url)));
  for (const fixture of fixtures) assert.deepEqual(validateFormIdentity(fixture.values, fixture.options), fixture.expected, fixture.name);
});
