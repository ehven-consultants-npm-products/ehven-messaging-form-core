import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(
  new URL('../scripts/release.mjs', import.meta.url),
);
const repository = 'ehven-consultants-npm-products/ehven-messaging-form-core';
function fixture(
  t,
  repository = 'ehven-consultants-npm-products/ehven-messaging-form-core',
) {
  const root = mkdtempSync(join(tmpdir(), 'messaging-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['bin', 'release', 'remote']) mkdirSync(join(root, dir));
  const bytes = Buffer.from('synthetic package'),
    head = 'a'.repeat(40),
    hash = (b, alg = 'sha256', encoding = 'hex') =>
      createHash(alg).update(b).digest(encoding);
  const candidate = {
    schemaVersion: 1,
    repository,
    name: '@ehven/messaging-form-core',
    version: '1.0.0',
    tag: 'v1.0.0',
    tarball: 'ehven-messaging-form-core-1.0.0.tgz',
    integrity: 'sha512-' + hash(bytes, 'sha512', 'base64'),
  };
  const values = {
    'ehven-messaging-form-core-1.0.0.tgz': bytes,
    SHA256SUMS: Buffer.from('synthetic checksums'),
  };
  candidate.assets = Object.entries(values).map(([name, value]) => {
    writeFileSync(join(root, 'release', name), value);
    return { name, sha256: hash(value) };
  });
  writeFileSync(
    join(root, 'release/candidate.json'),
    JSON.stringify(candidate),
  );
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: candidate.name,
      version: candidate.version,
      publishConfig: { access: 'public' },
      repository: { url: 'git+https://github.com/' + repository + '.git' },
    }),
  );
  const state = {
    head,
    ci: 'success',
    tag: null,
    release: null,
    assets: [],
    calls: [],
  };
  const save = () =>
    writeFileSync(join(root, 'state.json'), JSON.stringify(state));
  save();
  const executable = (name, code) =>
    writeFileSync(
      join(root, 'bin', name),
      '#!' + process.execPath + '\n' + code,
      { mode: 0o700 },
    );
  executable('git', `console.log(${JSON.stringify(head)});`);
  executable(
    'gh',
    `const fs=require('node:fs'),p=require('node:path'),root=process.env.FIXTURE_ROOT,file=p.join(root,'state.json'),s=JSON.parse(fs.readFileSync(file)),a=process.argv.slice(2);s.calls.push(a);const save=()=>fs.writeFileSync(file,JSON.stringify(s)),out=v=>{save();console.log(JSON.stringify(v))},bad=()=>{save();console.error('HTTP 404');process.exit(1)};
 if(a[0]==='api'){
  if(a[1]==='--method'){s.tag=s.head;out({});}
  else if(a[1].endsWith('/git/ref/heads/main'))out({object:{sha:s.head}});
  else if(a[1].includes('/actions/workflows/'))out({workflow_runs:[{id:1,name:'CI',head_sha:s.head,head_branch:'main',event:'push',status:'completed',conclusion:s.ci}]});
  else if(a[1].includes('/compare/'))out({status:s.ancestor?'ahead':'diverged',behind_by:s.ancestor?0:1});
  else if(a[1].includes('/git/ref/tags/')){if(!s.tag)bad();out({object:{type:'commit',sha:s.tag}});}else bad();
 }else if(a[1]==='view'){if(!s.release){save();console.error('release not found');process.exit(1)}out({...s.release,assets:s.assets.map(name=>({name}))});}
 else if(a[1]==='create'){s.release={databaseId:12,isDraft:true,isImmutable:false,tagName:a[2],name:a[a.indexOf('--title')+1],body:a[a.indexOf('--notes')+1]};out({});}
 else if(a[1]==='upload'){const src=a.at(-1),name=p.basename(src);if(s.assets.includes(name))process.exit(2);fs.copyFileSync(src,p.join(root,'remote',name));s.assets.push(name);out({});}
 else if(a[1]==='download'){fs.copyFileSync(p.join(root,'remote',a[a.indexOf('--pattern')+1]),a.at(-1));out({});}else bad();`,
  );
  executable(
    'npm',
    `const fs=require('node:fs'),p=require('node:path'),a=process.argv.slice(2);if(a[0]==='--version'){console.log('12.2.2');process.exit(0)};fs.writeFileSync(p.join(${JSON.stringify(root)},'stage-observation.json'),JSON.stringify({args:a,hasGithubToken:!!process.env.GH_TOKEN,hasNpmToken:!!process.env.NODE_AUTH_TOKEN,provenance:Object.fromEntries(['GITHUB_EVENT_NAME','GITHUB_REPOSITORY_ID','GITHUB_REPOSITORY_OWNER_ID','RUNNER_ENVIRONMENT'].map(key=>[key,process.env[key]]))}));console.log(JSON.stringify({'@ehven/messaging-form-core':{name:'@ehven/messaging-form-core',version:'1.0.0',integrity:${JSON.stringify(candidate.integrity)},stageId:'12345678-1234-1234-1234-123456789abc'}}));`,
  );
  const run = (operation, overrides = {}) =>
    spawnSync(process.execPath, [script, operation], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        PATH: join(root, 'bin') + ':' + process.env.PATH,
        FIXTURE_ROOT: root,
        GITHUB_REPOSITORY: repository,
        GITHUB_SHA: head,
        GITHUB_REF: 'refs/heads/main',
        EXPECTED_SOURCE: head,
        EXPECTED_INTEGRITY: candidate.integrity,
        RUNNER_ENVIRONMENT: 'github-hosted',
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_REPOSITORY_ID: '1459109285',
        GITHUB_REPOSITORY_OWNER_ID: '357065375',
        GH_TOKEN: 'synthetic-gh',
        NODE_AUTH_TOKEN: 'synthetic-npm',
        ...overrides,
      },
    });
  const remote = () => JSON.parse(readFileSync(join(root, 'state.json')));
  return { root, state, save, run, remote };
}

test('draft preparation creates a source tag, reads back all assets and resumes without replacement', (t) => {
  const f = fixture(t);
  let result = f.run('draft');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.remote().assets.length, 2);
  assert.equal(f.remote().release.isDraft, true);
  result = f.run('draft');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.remote().calls.filter((x) => x[1] === 'upload').length, 2);
});
test('failed CI and conflicting source tags prevent all draft creation', (t) => {
  for (const change of [
    (s) => (s.ci = 'failure'),
    (s) => (s.tag = 'b'.repeat(40)),
  ]) {
    const f = fixture(t);
    change(f.state);
    f.save();
    assert.notEqual(f.run('draft').status, 0);
    assert.equal(f.remote().release, null);
  }
});
test('conflicting existing assets are never overwritten', (t) => {
  const f = fixture(t);
  assert.equal(f.run('draft').status, 0);
  writeFileSync(join(f.root, 'remote/SHA256SUMS'), 'different');
  const before = f.remote().calls.filter((x) => x[1] === 'upload').length;
  assert.notEqual(f.run('draft').status, 0);
  assert.equal(
    f.remote().calls.filter((x) => x[1] === 'upload').length,
    before,
  );
});
test('stage submission preserves required provenance fields while stripping unrelated credentials', (t) => {
  const f = fixture(t),
    result = f.run('stage');
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.published, false);
  const observed = JSON.parse(
    readFileSync(join(f.root, 'stage-observation.json')),
  );
  assert.deepEqual(observed.args.slice(0, 2), ['stage', 'publish']);
  assert.ok(observed.args.includes('--provenance'));
  assert.ok(!observed.args.includes('approve'));
  assert.equal(observed.hasGithubToken, false);
  assert.equal(observed.hasNpmToken, false);
  assert.deepEqual(observed.provenance, {
    RUNNER_ENVIRONMENT: 'github-hosted',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REPOSITORY_ID: '1459109285',
    GITHUB_REPOSITORY_OWNER_ID: '357065375',
  });
});
test('changed candidate bytes and unsuccessful CI cannot be staged', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'release/SHA256SUMS'), 'different');
  assert.notEqual(f.run('stage').status, 0);
  const g = fixture(t);
  g.state.ci = 'failure';
  g.save();
  assert.notEqual(g.run('stage').status, 0);
});
test('release preparation derives a different product repository from package metadata', (t) => {
  const repository =
      'ehven-consultants-npm-products/ehven-messaging-form-extender-request',
    f = fixture(t, repository);
  const result = f.run('draft');
  assert.equal(result.status, 0, result.stderr);
  for (const call of f.remote().calls)
    if (call[0] === 'api')
      assert.ok(
        call.some((arg) => arg.includes(repository)),
        JSON.stringify(call),
      );
  assert.equal(f.remote().release.name, '@ehven/messaging-form-core 1.0.0');
});
test('an identical complete unpublished draft can advance its tag without replacing assets', (t) => {
  const f = fixture(t);
  assert.equal(f.run('draft').status, 0);
  let s = f.remote();
  s.tag = 'b'.repeat(40);
  s.ancestor = true;
  writeFileSync(join(f.root, 'state.json'), JSON.stringify(s));
  const result = f.run('draft');
  assert.equal(result.status, 0, result.stderr);
  s = f.remote();
  assert.equal(s.tag, s.head);
  assert.equal(s.calls.filter((x) => x[1] === 'upload').length, 2);
  const update = s.calls.find((x) => x.includes('PATCH'));
  assert.ok(update);
  assert.ok(update.includes('force=false'));
  assert.equal(JSON.parse(result.stdout).tagAdvancedFrom, 'b'.repeat(40));
});
test('published, divergent, incomplete or changed drafts cannot advance their tags', (t) => {
  for (const scenario of [
    { change: (s) => (s.release.isDraft = false) },
    { change: (s) => (s.release.isImmutable = true) },
    { change: (s) => (s.ancestor = false) },
    { change: (s) => s.assets.pop() },
    { change: (s) => {}, corrupt: true },
  ]) {
    const f = fixture(t);
    assert.equal(f.run('draft').status, 0);
    const s = f.remote();
    s.tag = 'b'.repeat(40);
    s.ancestor = true;
    scenario.change(s);
    writeFileSync(join(f.root, 'state.json'), JSON.stringify(s));
    if (scenario.corrupt)
      writeFileSync(join(f.root, 'remote/SHA256SUMS'), 'changed');
    assert.notEqual(f.run('draft').status, 0);
    assert.equal(f.remote().tag, 'b'.repeat(40));
    assert.equal(
      f.remote().calls.some((x) => x.includes('PATCH')),
      false,
    );
  }
});

test('draft preparation requires the reviewed source, tarball integrity and main branch', (t) => {
  for (const overrides of [
    { EXPECTED_SOURCE: 'b'.repeat(40) },
    { EXPECTED_INTEGRITY: 'sha512-unreviewed' },
    { GITHUB_REF: 'refs/heads/test' },
  ]) {
    const f = fixture(t);
    assert.notEqual(f.run('draft', overrides).status, 0);
    assert.equal(f.remote().release, null);
  }
});
