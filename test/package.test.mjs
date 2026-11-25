import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('the packed artifact installs offline and exposes independent root/browser/server imports', () => {
  const root = resolve(import.meta.dirname, '..');
  const temporary = mkdtempSync(join(tmpdir(), 'messaging-package-'));
  try {
    const [pack] = Object.values(JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', temporary, '--json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })));
    const consumer = join(temporary, 'consumer'); mkdirSync(consumer);
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    execFileSync('npm', ['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', join(temporary, pack.filename)], { cwd: consumer, stdio: 'pipe' });
    writeFileSync(join(consumer, 'smoke.mjs'), `import assert from 'node:assert/strict';
import {createIdentityValidator,MESSAGING_PROTOCOL_VERSION} from '@ehven/messaging-form-core';
import {handleMessagingRequest,createDeliveryPipeline} from '@ehven/messaging-form-core/server';
import {enhanceMessagingForm,revealMessagingFields} from '@ehven/messaging-form-core/browser';
assert.equal(MESSAGING_PROTOCOL_VERSION,1);assert.equal(typeof enhanceMessagingForm,'function');assert.equal(typeof revealMessagingFields,'function');
const fields={first_name:'Example',last_name:'Person',email:'user@example.org',email_confirmation:'user@example.org',source:'support'};
const response=await handleMessagingRequest(new Request('https://example.org',{method:'POST',body:new URLSearchParams(fields)}),{}, {validate:createIdentityValidator({allowedSources:['support']}),verifyHuman:async()=>({ok:true}),deliver:createDeliveryPipeline({accept:async()=>({ok:true,outcome:'simulated'})})});
assert.equal(response.status,200);assert.equal((await response.json()).outcome,'simulated');`);
    execFileSync(process.execPath, ['smoke.mjs'], { cwd: consumer, stdio: 'pipe' });
    assert.equal(pack.files.some(file => /\.astro$|^test\/|\.ehven|AGENTS|SKILL/.test(file.path)), false);
    assert.ok(pack.size <= 32768, 'Compressed package exceeds the 32 KiB candidate budget.');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
