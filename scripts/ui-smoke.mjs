import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const executable = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium'
].find(existsSync);
if (!executable) throw new Error('Set CHROME_PATH to a Chrome or Edge executable.');
const mime = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.ttf': 'font/ttf' };
const server = http.createServer((request, response) => {
  const file = resolve(root, '.' + decodeURIComponent(new URL(request.url, 'http://localhost').pathname));
  if (!file.startsWith(root) || !existsSync(file)) { response.writeHead(404).end(); return; }
  response.setHeader('Content-Type', mime[extname(file)] || 'text/plain');
  if (extname(file) === '.html') response.setHeader('Content-Security-Policy', JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).content_security_policy.extension_pages);
  response.end(readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const profile = mkdtempSync(join(tmpdir(), 'onepws-ui-'));
const browser = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
let socket;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
  assert.ok(existsSync(portFile), 'Chrome debugging endpoint did not start.');
  const debugPort = readFileSync(portFile, 'utf8').split('\n')[0];
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map(), errors = [], requests = [];
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const promise = pending.get(message.id); pending.delete(message.id);
      if (message.error) promise?.reject(new Error(message.error.message)); else promise?.resolve(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') errors.push(message.params.entry.text);
    if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request.url);
  };
  function cdp(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 15000);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Log.enable'); await cdp('Network.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `
    const memory = {}, session = {};
    const area = data => ({
      async get(key) { return key === null ? structuredClone(data) : Object.fromEntries((Array.isArray(key) ? key : [key]).map(k => [k, structuredClone(data[k])])); },
      async set(value) { Object.assign(data, structuredClone(value)); },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; }
    });
    window.__sends = []; window.__memory = memory; window.__session = session;
    window.chrome = { runtime: { id: 'onepws-test', async sendMessage(message) {
      if (message.type === 'STATUS') return { ok: true, result: { configured: true, email: '' } };
      if (message.type === 'CONNECT') return { ok: true, result: { email: 'owner@example.com' } };
      if (message.type === 'SEND') {
        window.__sends.push(message);
        const receipt = { status: 'sent', messageId: 'mock-' + window.__sends.length, at: new Date().toISOString() };
        memory['delivery:' + message.id] = receipt;
        return { ok: true, result: receipt };
      }
      if (message.type === 'CLEAR_DATA') { for (const key of Object.keys(memory)) delete memory[key]; for (const key of Object.keys(session)) delete session[key]; }
      return { ok: true, result: {} };
    } }, storage: { local: area(memory), session: area(session) } };
    window.confirm = () => true;
  ` });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/app.html` });
  await sleep(500);
  assert.equal(await evaluate('document.title'), 'OnePWS · Mail Merge');
  await evaluate('document.fonts.ready');
  assert.ok(await evaluate(`document.fonts.check('400 12px "Be Vietnam Pro"')`), 'Bundled Be Vietnam Pro must load.');
  for (const selector of ['body', 'button', 'input', 'textarea', 'select']) assert.match(await evaluate(`getComputedStyle(document.querySelector('${selector}')).fontFamily`), /Be Vietnam Pro/);
  assert.equal(await evaluate(`navigator.locks.request('onepws-workspace', { ifAvailable: true }, lock => lock === null)`), true, 'Workspace must hold the browser-wide lock.');
  await evaluate(`document.getElementById('connect').click()`);
  await sleep(100);
  assert.equal(await evaluate(`document.getElementById('account').textContent`), 'owner@example.com');
  await evaluate(`
    document.getElementById('csv').value = 'Email,FirstName,Company\\na@example.com,Alex,Example Co\\nb@example.com,Sam,Sample Studio\\nA@example.com,Duplicate,Other';
    document.getElementById('import').click();
  `);
  await sleep(100);
  assert.match(await evaluate(`document.getElementById('contact-summary').textContent`), /2 unique contacts · 1 duplicates removed/);
  await evaluate(`const search = document.getElementById('contact-search'); search.value = 'Sample Studio'; search.dispatchEvent(new Event('input'));`);
  assert.equal(await evaluate(`document.querySelectorAll('#contact-rows tr').length`), 1);
  await evaluate(`document.getElementById('contact-search').value = ''; document.getElementById('contact-search').dispatchEvent(new Event('input'));`);
  await evaluate(`document.getElementById('csv').value = 'Email,Name\\na@example.com,"unfinished'; document.getElementById('import').click()`);
  await sleep(100);
  assert.equal(await evaluate(`document.getElementById('review').disabled`), true, 'Malformed import must discard the previous active recipients.');
  await evaluate(`
    document.getElementById('csv').value = 'Email,FirstName,Company\\na@example.com,Alex,Example Co\\nb@example.com,Sam,Sample Studio';
    document.getElementById('import').click();
  `);
  await sleep(100);
  await evaluate(`
    const subject = document.getElementById('subject'); subject.value = 'Hi {{FirstName}} — OnePWS'; subject.dispatchEvent(new Event('input'));
    const body = document.getElementById('body'); body.value = 'Hi {{FirstName}},\\n\\nA personal hello to {{Company}}.\\n\\nBest,\\nOnePWS'; body.dispatchEvent(new Event('input'));
    document.getElementById('delay').value = '1';
  `);
  assert.equal(await evaluate(`document.getElementById('preview-subject').textContent`), 'Hi Alex — OnePWS');
  assert.match(await evaluate(`document.getElementById('preview-body').textContent`), /A personal hello to Example Co/);
  await evaluate(`document.getElementById('preview-next').click()`);
  assert.equal(await evaluate(`document.getElementById('preview-subject').textContent`), 'Hi Sam — OnePWS');
  await evaluate(`document.getElementById('preview-prev').click()`);
  await evaluate(`document.getElementById('template-save').click(); document.getElementById('template-name').value = 'Warm introduction'; document.getElementById('template-form').requestSubmit()`);
  await sleep(100);
  assert.equal(await evaluate('window.__memory.templates.length'), 1);
  assert.equal(await evaluate('window.__memory.templates[0].name'), 'Warm introduction');
  assert.equal(await evaluate('window.__memory.templates[0].csv'), undefined);
  await evaluate(`document.getElementById('subject').value = 'Changed'; document.getElementById('templates-open').click(); document.querySelector('#template-list .secondary').click()`);
  await sleep(100);
  assert.equal(await evaluate(`document.getElementById('subject').value`), 'Hi {{FirstName}} — OnePWS');
  await evaluate(`document.getElementById('privacy-open').click(); document.getElementById('remember-workspace').click()`);
  await sleep(100);
  assert.equal(await evaluate('window.__memory.workspace'), undefined);
  assert.equal(await evaluate('window.__session.workspace.draft.subject'), 'Hi {{FirstName}} — OnePWS');
  await evaluate(`document.getElementById('remember-workspace').click()`);
  await sleep(100);
  assert.equal(await evaluate('window.__session.workspace'), undefined);
  assert.equal(await evaluate('window.__memory.workspace.draft.subject'), 'Hi {{FirstName}} — OnePWS');
  await evaluate(`document.getElementById('privacy-dialog').close()`);
  await evaluate(`document.getElementById('test-email').value = 'owner@example.com'; document.getElementById('test').click()`);
  await sleep(100);
  assert.equal(await evaluate('window.__sends.length'), 1);
  assert.equal(await evaluate('window.__sends[0].to'), 'owner@example.com');
  await evaluate(`document.getElementById('review').click()`);
  assert.equal(await evaluate(`document.getElementById('review-dialog').open`), true);
  assert.match(await evaluate(`document.getElementById('review-summary').textContent`), /Send 2 individual emails/);
  await evaluate(`document.getElementById('confirm-send').click()`);
  await sleep(100);
  await evaluate(`document.getElementById('pause').click()`);
  await sleep(1100);
  assert.equal(await evaluate('window.__sends.length'), 2, 'Pausing must stop after the first campaign email.');
  assert.match(await evaluate(`document.getElementById('progress').textContent`), /1 of 2 sent/);
  await evaluate(`document.getElementById('review').click(); document.getElementById('confirm-send').click()`);
  await sleep(1200);
  assert.equal(await evaluate('window.__sends.length'), 3);
  assert.match(await evaluate(`document.getElementById('progress').textContent`), /2 of 2 sent/);
  assert.equal(await evaluate(`document.getElementById('subject').disabled`), true);
  assert.equal(await evaluate(`document.getElementById('review').disabled`), true);
  await evaluate(`document.getElementById('review').click()`);
  assert.equal(await evaluate('window.__sends.length'), 3, 'Completed campaign must not send twice.');
  await evaluate(`window.scrollTo({ top: 0, behavior: 'instant' })`);
  await sleep(100);
  mkdirSync(join(root, 'docs'), { recursive: true });
  const screenshot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(join(root, 'docs/onepws-preview.png'), Buffer.from(screenshot.data, 'base64'));
  await evaluate(`document.getElementById('new-campaign').click()`);
  await sleep(100);
  await evaluate(`document.getElementById('csv').value = 'Email,FirstName\\ninvalid,Alex'; document.getElementById('import').click()`);
  await sleep(100);
  assert.equal(await evaluate(`document.getElementById('review').disabled`), true);
  await evaluate(`document.getElementById('csv').value = 'Email,FirstName\\na@example.com,<img src=x onerror=alert(1)>'; document.getElementById('import').click()`);
  await sleep(100);
  await evaluate(`document.getElementById('body').value = '{{FirstName}}'; document.getElementById('body').dispatchEvent(new Event('input'));`);
  assert.equal(await evaluate(`document.querySelectorAll('#preview-body img').length`), 0);
  assert.match(await evaluate(`document.getElementById('preview-body').textContent`), /<img src=x/);
  await sleep(350);
  await evaluate(`document.getElementById('privacy-open').click(); document.getElementById('clear-data').click()`);
  await sleep(100);
  assert.deepEqual(await evaluate('Object.keys(window.__memory)'), []);
  assert.deepEqual(await evaluate('Object.keys(window.__session)'), []);
  assert.equal(await evaluate(`document.getElementById('account').textContent`), 'Connect your Gmail');
  assert.equal(await evaluate(`document.getElementById('csv').value`), '');
  assert.equal(await evaluate(`document.getElementById('template-count').textContent`), '0');
  await sleep(400);
  assert.deepEqual(await evaluate('Object.keys(window.__memory)'), [], 'A stale autosave must not restore erased private data.');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Mobile view must not overflow horizontally.');
  assert.deepEqual(errors, []);
  assert.ok(requests.every(url => url.startsWith(`http://127.0.0.1:${port}/`) || url === 'about:blank'), 'No remote fonts, analytics, or unapproved network requests are allowed.');
  console.log('Browser checks passed: local fonts/CSP, account connection, CSV import/search/deduplication, malformed-import blocking, recipient preview navigation, template save/apply, session-only persistence, test send, pause/resume, duplicate prevention, XSS-safe preview, data deletion, workspace lock, and mobile layout.');
  console.log('Only mocked delivery APIs were used. Screenshot: docs/onepws-preview.png');
} finally {
  socket?.close(); browser.kill();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
