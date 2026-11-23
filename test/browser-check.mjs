import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const executable = process.env.CHROMIUM_EXECUTABLE ?? ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
if (!executable) throw new Error('Set CHROMIUM_EXECUTABLE to an installed Chromium browser.');
const root = resolve(import.meta.dirname, '..');
const form = id => `<form id="${id}" action="/submit" method="post"><label>Email<input type="email" name="email" aria-describedby="help-${id}" required value="user@example.org"></label><p id="help-${id}">Existing help</p><p data-form-status hidden><em>Original status</em></p><button type="submit">Send</button></form>`;
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Messaging fixture</title><style>label{display:block}form{max-width:30rem;margin-block:1rem}</style><body>${form('one')}${form('two')}<div id="reveal" hidden><input value="retained"></div></body></html>`;
const server = createServer(async (request, response) => {
  try {
    if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
    if (request.url === '/submit') { request.resume(); response.writeHead(303, {Location:'/native-success'}); response.end(); return; }
    if (request.url === '/native-success') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Received</title><p id="native-success">Native submission received</p>'); return; }
    const path = new URL(request.url, 'http://localhost').pathname;
    if (!/^\/src\/[a-zA-Z0-9/_.-]+$/.test(path) || path.includes('..')) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', 'text/javascript'); response.end(await readFile(root + path));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = mkdtempSync(join(tmpdir(), 'messaging-chrome-'));
const browser = spawn(executable, ['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-background-networking','--no-first-run','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'], {stdio:['ignore','ignore','pipe']});
let socket, nextId = 0;
const pending = new Map();
try {
  const endpoint = await new Promise((accept, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(Error('Chromium startup timed out.')), 15000);
    browser.stderr.on('data', chunk => { stderr += chunk; const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/); if (match) { clearTimeout(timer); accept(match[1]); } });
    browser.once('error', error => { clearTimeout(timer); reject(error); });
    browser.once('exit', code => { clearTimeout(timer); reject(Error(`Chromium exited before connection (${code}). ${stderr.slice(-1500)}`)); });
  });
  socket = new WebSocket(endpoint);
  await new Promise((accept, reject) => { socket.addEventListener('open', accept, {once:true}); socket.addEventListener('error', reject, {once:true}); });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data), item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer);
    message.error ? item.reject(Error(message.error.message)) : item.accept(message.result);
  });
  const call = (method, params = {}, sessionId) => new Promise((accept, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id,{accept,reject,timer}); socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));
  });
  const {targetId} = await call('Target.createTarget',{url:'about:blank'});
  const {sessionId} = await call('Target.attachToTarget',{targetId,flatten:true});
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId);
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  await call('Page.enable',{},sessionId);
  await call('Page.navigate',{url:origin},sessionId);
  for (let i=0;i<100;i++) { if(await evaluate('document.readyState === "complete" && Boolean(document.getElementById("one"))'))break; await new Promise(done=>setTimeout(done,20)); }
  const checks = await evaluate(`(async () => {
    const {enhanceMessagingForm,revealMessagingFields,restoreMessagingFields} = await import('/src/browser/index.mjs');
    const check=(value,message)=>{if(!value)throw Error(message);};
    const wait=async condition=>{for(let i=0;i<400;i++){if(condition())return;await new Promise(done=>setTimeout(done,5));}throw Error('UI condition timed out');};
    const one=document.getElementById('one'),two=document.getElementById('two');
    const original=one.querySelector('em'),input=one.elements.email,status=one.querySelector('[data-form-status]');
    let fixture={ok:false},calls=[],resets=[];
    const setup=form=>enhanceMessagingForm(form,{timeoutMs:50,fetchImpl:async(_url,init)=>{calls.push({form:form.id,signal:init.signal});if(fixture.hang)return new Promise(()=>{});return Response.json(fixture.ok?{ok:true,outcome:fixture.outcome??'accepted'}:{ok:false,message:'Review email',errors:[{field:'email',message:'Check this email.'}]},{status:fixture.ok?202:422});},verification:{reset:({form})=>resets.push(form.id)}});
    const first=setup(one),second=setup(two);
    check(enhanceMessagingForm(one)===first,'Initialization must be idempotent');
    check(status.id!==two.querySelector('[data-form-status]').id,'Form statuses need unique identities');
    one.requestSubmit();await wait(()=>!first.pending);
    check(input.getAttribute('aria-invalid')==='true','Server error state');
    check(input.getAttribute('aria-describedby').split(' ').includes('help-one'),'Help association preserved');
    check(document.activeElement===input,'First error receives focus');
    check(two.querySelector('[data-form-status]').hidden,'Other form stays independent');
    check(resets.join(',')==='one','Only originating widget resets');
    input.value='updated@example.org';input.dispatchEvent(new Event('input',{bubbles:true}));
    check(input.getAttribute('aria-describedby')==='help-one'&&!input.hasAttribute('aria-invalid'),'Editing clears owned error only');
    fixture={ok:true,outcome:'simulated'};two.requestSubmit();await wait(()=>!second.pending);
    check(two.querySelector('[data-form-status]').dataset.kind==='simulated','Simulation is distinct');
    check(two.textContent.includes('Nothing was delivered'),'Simulation copy is truthful');
    fixture={hang:true};one.requestSubmit();one.dispatchEvent(new Event('submit',{cancelable:true}));await wait(()=>!first.pending);
    check(calls.filter(item=>item.form==='one').length===2,'Duplicate pending submit suppressed');
    check(calls.at(-1).signal.aborted,'Timeout aborts request');
    check(input.value==='updated@example.org'&&!one.querySelector('button').disabled,'Timeout preserves values and recovers button');
    one.requestSubmit();first.destroy();first.destroy();await new Promise(done=>setTimeout(done,75));
    check(one.querySelector('em')===original&&status.hidden,'Destroy restores original node identity and state');
    check(input.getAttribute('aria-describedby')==='help-one'&&!one.querySelector('button').disabled,'Destroy restores control state');
    let remountCalls=0;
    const remounted=enhanceMessagingForm(one,{fetchImpl:async()=>{remountCalls++;return Response.json({ok:true});}});
    one.requestSubmit();await wait(()=>!remounted.pending);check(remountCalls===1,'Remount has exactly one listener');
    const group=document.getElementById('reveal'),child=group.firstChild;
    revealMessagingFields(group,true,{animate:true});revealMessagingFields(group,false,{animate:true});revealMessagingFields(group,true,{animate:true});
    await Promise.all(group.getAnimations().map(animation=>animation.finished));
    check(!group.hidden&&!group.inert,'Interrupted reveal honors latest selection');
    restoreMessagingFields(group);check(group.hidden&&!group.inert&&group.firstChild===child,'Reveal restores original state and nodes');
    remounted.destroy();second.destroy();
    return 16;
  })()`);
  await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]},sessionId);
  assert.equal(await evaluate(`(async()=>{const {revealMessagingFields}=await import('/src/browser/index.mjs');const group=document.getElementById('reveal');revealMessagingFields(group,true,{animate:true});return group.getAnimations().length;})()`),0);
  await call('Emulation.setDeviceMetricsOverride',{width:375,height:812,deviceScaleFactor:1,mobile:true},sessionId);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'),true);
  await evaluate('document.getElementById("one").requestSubmit()');
  for(let i=0;i<100;i++){if(await evaluate('location.pathname === "/native-success"'))break;await new Promise(done=>setTimeout(done,20));}
  assert.equal(await evaluate('location.pathname'),'/native-success');
  console.log(JSON.stringify({outcome:'PASS',assertions:checks+3,browser:(await call('Browser.getVersion')).product,scope:'Synthetic HTML forms, Chromium DOM/focus/recovery/reduced motion/native POST. No live provider, framework or full accessibility certification.'},null,2));
} finally {
  for(const item of pending.values()){clearTimeout(item.timer);item.reject(Error('Browser check ended.'));}
  socket?.close(); browser.kill('SIGTERM');
  await new Promise(done=>server.close(done));
  try {rmSync(profile,{recursive:true,force:true});} catch { /* A browser may still be exiting. */ }
}
