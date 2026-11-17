import test from 'node:test';
import assert from 'node:assert/strict';

let handler, memory, fetchCalls, responses, tokenCalls;
const originalFetch = globalThis.fetch;
const id = '12345678-1234-1234-1234-123456789abc';
const origin = 'chrome-extension://onepws/app.html';
function area() { return {
  async get(key) { return key ? Object.fromEntries((Array.isArray(key) ? key : [key]).map(item => [item, memory[item]])) : { ...memory }; },
  async set(data) { Object.assign(memory, structuredClone(data)); },
  async remove(key) { for (const item of Array.isArray(key) ? key : [key]) delete memory[item]; }, async setAccessLevel() {}
}; }
async function setup() {
  memory = {}; fetchCalls = []; responses = []; tokenCalls = 0;
  globalThis.chrome = {
    runtime: { getURL: path => `chrome-extension://onepws/${path}`, getManifest: () => ({ oauth2: { client_id: '123-test.apps.googleusercontent.com' } }),
      onInstalled: { addListener() {} }, onMessage: { addListener(fn) { handler = fn; } } },
    action: { onClicked: { addListener() {} } },
    storage: { local: area(), session: area() },
    identity: { async getAuthToken() { tokenCalls++; return { token: 'test-token' }; }, async removeCachedAuthToken() {}, async clearAllCachedAuthTokens() {} },
    tabs: { async query() { return []; }, async create() {} }
  };
  globalThis.fetch = async (url, init) => {
    if (url.includes('userinfo')) return Response.json({ email: 'sender@example.com' });
    fetchCalls.push({ url, init });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response || Response.json({ id: 'gmail-1' });
  };
  await import(`../background_service.js?fixture=${crypto.randomUUID()}`);
}
function call(data, url = origin) {
  return new Promise(resolve => handler(data, { url }, resolve));
}
function send(overrides = {}) {
  return call({ type: 'SEND', id, from: 'sender@example.com', to: 'to@example.com', subject: 'Hello', body: 'OnePWS test', ...overrides });
}

test('background delivery and authorization', async t => {
  try {
    await t.test('Gmail content scripts cannot request authentication or send email', async () => {
      await setup();
      const result = await call({ type: 'CONNECT' }, 'https://mail.google.com/mail/u/0/');
      assert.equal(result.ok, false); assert.equal(tokenCalls, 0);
    });
    await t.test('connect stores the verified sender without storing an access token', async () => {
      await setup(); const result = await call({ type: 'CONNECT' });
      assert.equal(result.result.email, 'sender@example.com');
      assert.equal(memory.connectedEmail, 'sender@example.com');
      assert.ok(!JSON.stringify(memory).includes('test-token'));
    });
    await t.test('repeated delivery IDs return the saved receipt and do not send twice', async () => {
      await setup();
      assert.equal((await send()).result.status, 'sent');
      assert.equal((await send()).result.status, 'sent');
      assert.equal(fetchCalls.length, 1);
      assert.ok(JSON.parse(fetchCalls[0].init.body).raw);
    });
    await t.test('401 refresh retries once following definitive rejection', async () => {
      await setup(); responses.push(Response.json({ error: { message: 'Expired' } }, { status: 401 }));
      assert.equal((await send()).result.status, 'sent');
      assert.equal(fetchCalls.length, 2); assert.equal(tokenCalls, 2);
    });
    await t.test('network interruption stays unconfirmed and never automatically retries', async () => {
      await setup(); responses.push(new Error('Network disconnected'));
      assert.equal((await send()).result.status, 'unknown');
      assert.equal((await send()).result.status, 'unknown');
      assert.equal(fetchCalls.length, 1);
    });
    await t.test('server errors stay unconfirmed, quota errors pause as failed', async () => {
      await setup(); responses.push(Response.json({}, { status: 503 }));
      assert.equal((await send()).result.status, 'unknown');
      await setup(); responses.push(Response.json({ error: { message: 'Daily limit' } }, { status: 429 }));
      const result = await send(); assert.equal(result.result.status, 'failed'); assert.equal(result.result.error, 'Daily limit');
    });
    await t.test('an interrupted worker receipt cannot duplicate delivery', async () => {
      await setup(); memory[`delivery:${id}`] = { status: 'sending' };
      assert.equal((await send()).result.status, 'unknown'); assert.equal(fetchCalls.length, 0);
    });
    await t.test('sender mismatch and malformed MIME are rejected before network dispatch', async () => {
      await setup(); assert.equal((await send({ from: 'other@example.com' })).result.status, 'failed');
      assert.equal(fetchCalls.length, 0);
      await setup();
      assert.equal((await send({ subject: 'Hi\r\nBcc: attacker@example.com' })).result.status, 'failed');
      assert.equal(fetchCalls.length, 0);
    });
    await t.test('a delivery ID cannot be reused for another payload or overwrite its sent receipt', async () => {
      await setup();
      assert.equal((await send()).result.status, 'sent');
      const saved = structuredClone(memory[`delivery:${id}`]);
      assert.equal((await send({ body: 'Different content' })).result.status, 'failed');
      assert.deepEqual(memory[`delivery:${id}`], saved);
      assert.equal((await send()).result.status, 'sent');
      assert.equal(fetchCalls.length, 1);
    });
    await t.test('new receipts store no recipient address or message body', async () => {
      await setup(); await send();
      const record = memory[`delivery:${id}`];
      assert.equal(record.fingerprint.length, 64);
      assert.ok(!JSON.stringify(record).includes('to@example.com'));
      assert.ok(!JSON.stringify(record).includes('OnePWS test'));
    });
    await t.test('HTTP request timeouts stay unconfirmed instead of being retried', async () => {
      await setup(); responses.push(Response.json({}, { status: 408 }));
      assert.equal((await send()).result.status, 'unknown');
      assert.equal((await send()).result.status, 'unknown');
      assert.equal(fetchCalls.length, 1);
    });
    await t.test('clear data requires the workspace origin and clears only app data', async () => {
      await setup(); memory.workspace = { private: true }; memory.templates = ['private']; memory.preferences = {}; memory.other = 'keep'; memory.connectedEmail = 'sender@example.com';
      memory[`delivery:${id}`] = { status: 'sent' };
      assert.equal((await call({ type: 'CLEAR_DATA' }, 'https://mail.google.com')).ok, false);
      assert.ok(memory.workspace);
      assert.equal((await call({ type: 'CLEAR_DATA' })).ok, true);
      assert.deepEqual(memory, { other: 'keep' }); assert.equal(fetchCalls.length, 0);
    });
    await t.test('expired user-info tokens are refreshed before any delivery', async () => {
      await setup();
      const normalFetch = globalThis.fetch; let checks = 0;
      globalThis.fetch = async (url, init) => {
        if (url.includes('userinfo') && ++checks === 1) return Response.json({}, { status: 401 });
        return normalFetch(url, init);
      };
      assert.equal((await send()).result.status, 'sent');
      assert.equal(tokenCalls, 2); assert.equal(fetchCalls.length, 1);
    });
    await t.test('concurrent deliveries are rejected while the first request is active', async () => {
      await setup();
      const first = send();
      const second = await send({ id: '22345678-1234-1234-1234-123456789abc' });
      assert.equal(second.ok, false);
      assert.match(second.error, /in progress/);
      assert.equal((await first).result.status, 'sent'); assert.equal(fetchCalls.length, 1);
    });
    await t.test('failure to persist the send intent stops the request before Gmail dispatch', async () => {
      await setup(); chrome.storage.local.set = async () => { throw new Error('Storage quota exceeded'); };
      assert.equal((await send()).ok, false); assert.equal(fetchCalls.length, 0);
    });
  } finally { globalThis.fetch = originalFetch; delete globalThis.chrome; }
});
