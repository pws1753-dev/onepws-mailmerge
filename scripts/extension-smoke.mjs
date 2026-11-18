// Runs the real unpacked extension in an isolated Chromium profile. No OAuth or email is sent.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const id = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)].map(char => String.fromCharCode(97 + parseInt(char, 16))).join('');
const cache = join(homedir(), 'AppData/Local/ms-playwright');
const candidates = existsSync(cache) ? readdirSync(cache).filter(name => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])).map(name => join(cache, name, 'chrome-win64/chrome.exe')) : [];
const executable = process.env.CHROMIUM_PATH || candidates.find(existsSync);
if (!executable) throw new Error('Set CHROMIUM_PATH to Chromium or Chrome for Testing; regular Chrome no longer supports --load-extension.');
const profile = mkdtempSync(join(tmpdir(), 'onepws-real-extension-'));
const browser = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, `--disable-extensions-except=${root}`, `--load-extension=${root}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket;
try {
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
  assert.ok(existsSync(portFile), 'Chromium did not start.');
  const port = readFileSync(portFile, 'utf8').split('\n')[0];
  let targets;
  for (let i = 0; i < 40; i++) {
    targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    if (targets.some(target => target.url === `chrome-extension://${id}/app.html`)) break;
    await sleep(100);
  }
  const target = targets.find(target => target.url === `chrome-extension://${id}/app.html`);
  assert.ok(target, 'The unpacked extension must load and open its workspace.');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map(), errors = [], contexts = [];
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) { const p = pending.get(message.id); pending.delete(message.id); if (message.error) p.reject(new Error(message.error.message)); else p.resolve(message.result); }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') errors.push(message.params.entry.text);
    if (message.method === 'Runtime.executionContextCreated') contexts.push(message.params.context);
    if (message.method === 'Fetch.requestPaused') cdp('Fetch.fulfillRequest', {
      requestId: message.params.requestId, responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
      body: Buffer.from('<!doctype html><html><head><title>OnePWS isolated launcher test</title></head><body>Local Gmail-origin test fixture. No Gmail account or message is loaded.</body></html>').toString('base64')
    }).catch(error => errors.push(error.message));
  };
  function cdp(method, params = {}) {
    return new Promise((resolve, reject) => {
      const callId = ++sequence;
      const timer = setTimeout(() => { pending.delete(callId); reject(new Error(`Timed out: ${method}`)); }, 15000);
      pending.set(callId, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
      socket.send(JSON.stringify({ id: callId, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  await cdp('Runtime.enable'); await cdp('Log.enable');
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await evaluate(`typeof document.getElementById('import')?.onclick === 'function'`)) break;
    await sleep(100);
  }
  assert.equal(await evaluate(`typeof document.getElementById('import')?.onclick`), 'function', 'The real workspace must initialize.');
  assert.equal(await evaluate('chrome.runtime.id'), id);
  assert.equal(await evaluate('chrome.runtime.getManifest().version'), '1.2.0');
  const status = await evaluate(`chrome.runtime.sendMessage({ type: 'STATUS' })`);
  assert.equal(status.ok, true); assert.equal(status.result.configured, true); assert.equal(status.result.email, '');
  await evaluate('document.fonts.ready');
  assert.ok(await evaluate(`document.fonts.check('400 12px "Be Vietnam Pro"')`));
  await evaluate(`document.getElementById('csv').value = 'Email,FirstName\\nalex@example.com,Alex'; document.getElementById('import').click()`);
  await sleep(200);
  assert.equal(await evaluate(`chrome.storage.local.get('workspace').then(data => data.workspace.draft.csv)`), 'Email,FirstName\nalex@example.com,Alex');
  await evaluate(`document.getElementById('privacy-open').click(); document.getElementById('remember-workspace').click()`);
  await sleep(200);
  assert.equal(await evaluate(`chrome.storage.local.get('workspace').then(data => data.workspace)`), undefined);
  assert.ok(await evaluate(`chrome.storage.session.get('workspace').then(data => !!data.workspace)`));
  await evaluate(`document.getElementById('privacy-dialog').close(); document.getElementById('setup-open').click()`);
  assert.equal(await evaluate(`document.getElementById('extension-id').textContent`), id);
  await evaluate(`document.getElementById('setup-close').click()`);
  assert.equal(await evaluate(`document.getElementById('setup-dialog').open`), false);
  await cdp('Page.enable');
  await cdp('Page.reload'); await sleep(300);
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await evaluate(`typeof document.getElementById('import')?.onclick === 'function'`)) break;
    await sleep(100);
  }
  assert.equal(await evaluate(`document.getElementById('csv').value`), 'Email,FirstName\nalex@example.com,Alex');
  assert.equal(await evaluate(`document.getElementById('remember-workspace').checked`), false);
  assert.equal(await evaluate(`document.getElementById('stat-contacts').textContent`), '1');
  await evaluate(`document.getElementById('csv').value = 'Email,FirstName\\nnew@example.com,New'; document.getElementById('csv').dispatchEvent(new Event('input'));`);
  await sleep(400); await cdp('Page.reload'); await sleep(300);
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await evaluate(`typeof document.getElementById('import')?.onclick === 'function'`)) break;
    await sleep(100);
  }
  assert.equal(await evaluate(`document.getElementById('stat-contacts').textContent`), '0', 'CSV edits must not become active recipients on reload before explicit import.');
  assert.equal(await evaluate(`document.getElementById('csv').value`), 'Email,FirstName\nnew@example.com,New');
  const cleared = await evaluate(`chrome.runtime.sendMessage({ type: 'CLEAR_DATA' })`);
  assert.equal(cleared.ok, true);
  assert.deepEqual(await evaluate(`chrome.storage.local.get(null)`), {});
  assert.deepEqual(await evaluate(`chrome.storage.session.get(null)`), {});
  // Serve a local fixture at Gmail's origin, exercising the real content-script boundary without loading Gmail.
  await cdp('Fetch.enable', { patterns: [{ urlPattern: 'https://mail.google.com/*', requestStage: 'Request' }] });
  await cdp('Page.navigate', { url: 'https://mail.google.com/mail/u/0/' });
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await evaluate(`!!document.getElementById('onepws-launcher')`)) break;
    await sleep(100);
  }
  assert.equal(await evaluate(`document.getElementById('onepws-launcher')?.textContent`), 'OnePWS');
  await evaluate('document.fonts.ready');
  assert.ok(await evaluate(`document.fonts.check('500 14px "OnePWS Be Vietnam Pro"')`));
  const contentContext = contexts.findLast(context => context.origin === `chrome-extension://${id}` && context.auxData?.isDefault === false);
  assert.ok(contentContext, 'Gmail launcher must run in the extension isolated world. Contexts: ' + JSON.stringify(contexts));
  const boundary = await cdp('Runtime.evaluate', { contextId: contentContext.id, expression: `chrome.runtime.sendMessage({ type: 'STATUS' })`, awaitPromise: true, returnByValue: true });
  assert.equal(boundary.result.value.ok, false, 'The Gmail content script must not access privileged actions.');
  const access = await cdp('Runtime.evaluate', { contextId: contentContext.id, expression: `chrome.storage.local.get('workspace').then(() => 'allowed', () => 'denied')`, awaitPromise: true, returnByValue: true });
  assert.equal(access.result.value, 'denied', 'Personal extension storage must be inaccessible to Gmail content scripts.');
  assert.deepEqual(errors, []);
  console.log(`Real extension checks passed in Chromium: ID ${id}, manifest/service worker, runtime messaging, bundled fonts/CSP, CSV persistence, session-only migration/reload recovery, setup dialog, Gmail launcher/font, content-script authorization, and private-storage isolation. Gmail origin used an intercepted local fixture. No OAuth or email sending was performed.`);
} finally { socket?.close(); browser.kill(); }
