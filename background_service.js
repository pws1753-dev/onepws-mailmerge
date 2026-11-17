import { buildMessage, isEmail } from './mail-core.js';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const DASHBOARD_DEFAULT = 'https://mailmerge.onepws.com';
let busy = false;
const storageReady = Promise.all([
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
]);

async function openWorkspace() {
  const url = chrome.runtime.getURL('app.html');
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find(tab => tab.url === url);
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else await chrome.tabs.create({ url });
}

chrome.action.onClicked.addListener(openWorkspace);
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await storageReady;
  if (reason === 'install') await openWorkspace();
});

function configured() {
  return !chrome.runtime.getManifest().oauth2.client_id.startsWith('YOUR_');
}

async function getToken(interactive = false) {
  if (!configured()) throw new Error('Set your Google OAuth client ID first. Open the setup instructions.');
  const result = await chrome.identity.getAuthToken({ interactive });
  const token = typeof result === 'string' ? result : result.token;
  if (!token) throw new Error('Google did not return an access token. Reconnect Gmail.');
  return token;
}

async function profile(token) {
  const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) {
    const error = new Error('Could not confirm your Google account. Disconnect and reconnect Gmail.');
    error.status = response.status; throw error;
  }
  const user = await response.json();
  if (!isEmail(user.email)) throw new Error('Google did not return a valid email address.');
  return user.email;
}

async function verifiedAccount(interactive = false) {
  let token = await getToken(interactive);
  try { return { token, email: await profile(token) }; }
  catch (error) {
    if (error.status !== 401) throw error;
    await chrome.identity.removeCachedAuthToken({ token });
    token = await getToken(interactive);
    return { token, email: await profile(token) };
  }
}

async function connect() {
  if (busy) throw new Error('Wait for the current delivery to finish before connecting.');
  const { email } = await verifiedAccount(true);
  await chrome.storage.session.set({ connectedEmail: email });
  return { email };
}

async function send(message) {
  if (busy) throw new Error('Another delivery is in progress. Wait until it finishes.');
  busy = true;
  let receiptKey;
  let fingerprint;
  let dispatchStarted = false;
  try {
    if (!/^[a-f0-9-]{36}$/.test(message.id || '')) throw new Error('Invalid delivery ID.');
    const key = `delivery:${message.id}`;
    for (const field of ['from', 'to', 'subject', 'body']) if (typeof message[field] !== 'string') throw new Error('The delivery is missing a required text field.');
    fingerprint = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([message.from, message.to, message.subject, message.body]))))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const saved = (await chrome.storage.local.get(key))[key];
    // A delivery ID is bound to its exact payload; never overwrite a previous receipt on mismatch.
    if (saved?.fingerprint && saved.fingerprint !== fingerprint) return { status: 'failed', error: 'This delivery ID belongs to a different message. Start a new campaign.' };
    receiptKey = key;
    if (saved?.status === 'sent') return saved;
    if (saved?.status === 'sending' || saved?.status === 'unknown') {
      return { status: 'unknown', error: 'Delivery is unconfirmed. Check Gmail Sent before sending again.' };
    }
    let { token, email } = await verifiedAccount();
    if (message.from !== email) throw new Error('The connected account changed. Reconnect and review the sender before sending.');
    const raw = buildMessage({ from: email, to: message.to, subject: message.subject, body: message.body });
    await chrome.storage.local.set({ [receiptKey]: { status: 'sending', fingerprint, at: new Date().toISOString() } });
    const request = () => fetch(API, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }), signal: AbortSignal.timeout(25000)
    });
    dispatchStarted = true;
    let response = await request();
    // A 401 is a definitive rejection, so refreshing and retrying cannot duplicate a delivery.
    if (response.status === 401) {
      dispatchStarted = false;
      await chrome.identity.removeCachedAuthToken({ token });
      token = await getToken();
      if (await profile(token) !== email) throw new Error('The Google account changed. Reconnect Gmail.');
      dispatchStarted = true;
      response = await request();
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const record = { status: response.status >= 500 || response.status === 408 ? 'unknown' : 'failed', fingerprint,
        error: result.error?.message || `Gmail returned HTTP ${response.status}.`, at: new Date().toISOString() };
      await chrome.storage.local.set({ [receiptKey]: record });
      return record;
    }
    if (!result.id) throw new Error('Gmail did not confirm delivery. Check your Sent folder.');
    const record = { status: 'sent', fingerprint, messageId: result.id, at: new Date().toISOString() };
    await chrome.storage.local.set({ [receiptKey]: record });
    return record;
  } catch (error) {
    const record = { status: dispatchStarted ? 'unknown' : 'failed', fingerprint, error: error.message, at: new Date().toISOString() };
    if (receiptKey) await chrome.storage.local.set({ [receiptKey]: record });
    return record;
  } finally { busy = false; }
}

function validDashboard(config) {
  try {
    const url = new URL(config.url);
    return url.protocol === 'https:' && url.hostname === 'mailmerge.onepws.com' && /^dev_[a-zA-Z0-9]+$/.test(config.deviceId || '') && typeof config.deviceSecret === 'string' && config.deviceSecret.length >= 32;
  } catch { return false; }
}

async function dashboardConfig() { return (await chrome.storage.local.get('dashboardConnection')).dashboardConnection || null; }
async function dashboardSync(data) {
  const config = await dashboardConfig();
  if (!validDashboard(config)) return { connected: false };
  const payload = JSON.stringify(data);
  const timestamp = String(Date.now());
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(config.deviceSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${payload}`))))
    ).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  const response = await fetch(`${config.url}/api/ingest`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-OnePWS-Device': config.deviceId, 'X-OnePWS-Timestamp': timestamp, 'X-OnePWS-Signature': signature }, body: payload, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Dashboard could not confirm the sync. Your email was not affected.');
  return { connected: true };
}

function spreadsheetId(value) {
  const match = String(value || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/);
  if (!match) throw new Error('Paste a valid Google Sheets URL.');
  return match[1];
}

async function importSheet(message) {
  if (busy) throw new Error('Wait for the current delivery before importing a sheet.');
  const id = spreadsheetId(message.url);
  const range = String(message.range || '').trim();
  if (!range || range.length > 180 || !/^[\w .!:'-]+$/u.test(range)) throw new Error('Enter a valid sheet range, for example Leads!A:Z.');
  const { token } = await verifiedAccount(true);
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(range)}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || 'Google Sheets could not read that range. Check sharing access and the tab name.');
  if (!Array.isArray(result.values) || result.values.length < 2 || !Array.isArray(result.values[0])) throw new Error('The selected range needs a header row and at least one recipient row.');
  if (result.values.length > 10001) throw new Error('Import up to 10,000 rows at a time. Split larger sheets into ranges.');
  return { values: result.values.map(row => Array.isArray(row) ? row.map(cell => String(cell ?? '')) : []) };
}

async function route(message, sender) {
  await storageReady;
  if (!message || typeof message.type !== 'string') throw new Error('Invalid OnePWS request.');
  if (message.type === 'OPEN_WORKSPACE') return openWorkspace();
  // Gmail content scripts may launch the workspace, but cannot connect or send.
  if (sender.url !== chrome.runtime.getURL('app.html')) throw new Error('Open the OnePWS workspace to perform this action.');
  if (message.type === 'STATUS') {
    const { connectedEmail } = await chrome.storage.session.get('connectedEmail');
    return { configured: configured(), email: connectedEmail || '' };
  }
  if (message.type === 'DASHBOARD_STATUS') { const config = await dashboardConfig(); return { connected: validDashboard(config), url: config?.url || DASHBOARD_DEFAULT, deviceId: config?.deviceId || '' }; }
  if (message.type === 'DASHBOARD_CONNECT') {
    const config = { url: String(message.url || '').replace(/\/$/, ''), deviceId: String(message.deviceId || '').trim(), deviceSecret: String(message.deviceSecret || '').trim() };
    if (!validDashboard(config)) throw new Error('Use a valid mailmerge.onepws.com URL and the device credential created in your dashboard.');
    await chrome.storage.local.set({ dashboardConnection: config }); return { connected: true, url: config.url, deviceId: config.deviceId };
  }
  if (message.type === 'DASHBOARD_DISCONNECT') { await chrome.storage.local.remove('dashboardConnection'); return {}; }
  if (message.type === 'DASHBOARD_SYNC') return dashboardSync(message.data);
  if (message.type === 'SHEETS_IMPORT') return importSheet(message);
  if (message.type === 'CONNECT') return connect();
  if (message.type === 'DISCONNECT') {
    if (busy) throw new Error('Wait for the current delivery to finish before disconnecting.');
    await chrome.identity.clearAllCachedAuthTokens();
    await chrome.storage.session.remove('connectedEmail');
    return {};
  }
  if (message.type === 'CLEAR_DATA') {
    if (busy) throw new Error('Wait for the current delivery to finish before clearing data.');
    await chrome.identity.clearAllCachedAuthTokens();
    const data = await chrome.storage.local.get(null);
    const keys = Object.keys(data).filter(key => ['workspace', 'templates', 'preferences', 'dashboardConnection'].includes(key) || key.startsWith('delivery:'));
    if (keys.length) await chrome.storage.local.remove(keys);
    await chrome.storage.session.remove(['workspace', 'connectedEmail']);
    return {};
  }
  if (message.type === 'SEND') return send(message);
  throw new Error('Unknown OnePWS action.');
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  route(message, sender).then(result => respond({ ok: true, result })).catch(error => respond({ ok: false, error: error.message }));
  return true;
});
