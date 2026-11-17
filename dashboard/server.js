import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSession, parseEnv, safeEqual, sign, validateEvent, verifySession } from './lib.js';
import { DashboardStore } from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = await fs.readFile(path.join(here, '.env'), 'utf8').catch(() => '');
const config = { ...parseEnv(envFile), ...process.env };
const production = config.NODE_ENV === 'production';
const store = new DashboardStore(config.MONGODB_URI, config.MONGODB_DB || 'onepws_mailmerge');
let databaseReady = false;
try { databaseReady = await store.connect(); console.log('[OnePWS] MongoDB Atlas connected.'); } catch (error) { console.warn('[OnePWS] Database unavailable; dashboard is using volatile local memory.'); }

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'"
};
const allowedOrigins = new Set((config.ALLOWED_EXTENSION_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean));

function json(res, status, data, headers = {}) { res.writeHead(status, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(data)); }
function text(res, status, data, type = 'text/plain; charset=utf-8') { res.writeHead(status, { ...securityHeaders, 'Content-Type': type }); res.end(data); }
function cookies(req) { return Object.fromEntries((req.headers.cookie || '').split(';').map((item) => item.trim().split('=').map(decodeURIComponent)).filter((item) => item.length === 2)); }
function authorized(req) { return verifySession(cookies(req).onepws_session, config.DASHBOARD_SESSION_SECRET); }
async function body(req) { let raw = ''; for await (const part of req) { raw += part; if (raw.length > 100_000) throw new Error('Payload too large'); } try { return raw ? JSON.parse(raw) : {}; } catch { throw new Error('Invalid JSON'); } }
function deviceSignature(req, raw) { const timestamp = req.headers['x-onepws-timestamp']; const signature = req.headers['x-onepws-signature']; const deviceId = req.headers['x-onepws-device']; return { timestamp, signature, deviceId, raw }; }
async function verifyDevice(req, raw) {
  const { timestamp, signature, deviceId } = deviceSignature(req, raw);
  if (!timestamp || !signature || !deviceId || Math.abs(Date.now() - Number(timestamp)) > 5 * 60_000) return null;
  const device = await store.findDevice(deviceId);
  if (!device) return null;
  return safeEqual(signature, sign(`${timestamp}.${raw}`, device.secret)) ? device : null;
}
async function servePublic(res, requested) {
  const file = requested === '/' ? 'index.html' : requested.slice(1);
  const absolute = path.resolve(here, 'public', file);
  if (!absolute.startsWith(path.join(here, 'public'))) return text(res, 403, 'Forbidden');
  const type = absolute.endsWith('.html') ? 'text/html; charset=utf-8' : absolute.endsWith('.css') ? 'text/css; charset=utf-8' : absolute.endsWith('.js') ? 'application/javascript; charset=utf-8' : absolute.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream';
  try { text(res, 200, await fs.readFile(absolute), type); } catch { text(res, 404, 'Not found'); }
}

const app = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, database: databaseReady ? 'connected' : 'unavailable', time: new Date().toISOString() });
    if (req.method === 'POST' && url.pathname === '/api/session') {
      const data = await body(req);
      if (!config.DASHBOARD_PASSWORD || !config.DASHBOARD_SESSION_SECRET) return json(res, 503, { error: 'Dashboard access has not been configured.' });
      if (!safeEqual(data.password || '', config.DASHBOARD_PASSWORD)) return json(res, 401, { error: 'Incorrect password.' });
      const session = createSession(config.DASHBOARD_SESSION_SECRET);
      return json(res, 200, { ok: true }, { 'Set-Cookie': `onepws_session=${encodeURIComponent(session)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${production ? '; Secure' : ''}` });
    }
    if (req.method === 'DELETE' && url.pathname === '/api/session') return json(res, 200, { ok: true }, { 'Set-Cookie': `onepws_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${production ? '; Secure' : ''}` });
    if (req.method === 'GET' && url.pathname === '/api/dashboard') { if (!authorized(req)) return json(res, 401, { error: 'Sign in required.' }); return json(res, 200, await store.dashboard()); }
    if (req.method === 'POST' && url.pathname === '/api/devices') {
      if (!authorized(req)) return json(res, 401, { error: 'Sign in required.' });
      const device = await store.createDevice((await body(req)).label);
      return json(res, 201, { id: device.id, secret: device.secret, label: device.label, warning: 'Copy this once. It is shown only at creation.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/ingest') {
      const raw = await (async () => { let result = ''; for await (const part of req) { result += part; if (result.length > 100_000) throw new Error('Payload too large'); } return result; })();
      const origin = req.headers.origin;
      if (origin && allowedOrigins.size && !allowedOrigins.has(origin)) return json(res, 403, { error: 'Origin not allowed.' });
      if (!await verifyDevice(req, raw)) return json(res, 401, { error: 'Invalid device signature.' });
      const data = JSON.parse(raw || '{}');
      if (!data.campaign || !data.event) return json(res, 400, { error: 'campaign and event are required.' });
      const validation = validateEvent(data.event);
      if (validation) return json(res, 400, { error: validation });
      await store.upsertCampaign(data.campaign);
      await store.appendEvent(data.event);
      return json(res, 202, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, { dashboardReady: Boolean(config.DASHBOARD_PASSWORD && config.DASHBOARD_SESSION_SECRET), databaseReady });
    if (req.method === 'GET') return servePublic(res, url.pathname);
    return json(res, 404, { error: 'Not found.' });
  } catch (error) { console.error('[OnePWS] request error', error.message); return json(res, error.message === 'Payload too large' ? 413 : 400, { error: error.message === 'Invalid JSON' ? 'Invalid request.' : 'Request could not be processed.' }); }
});

const port = Number(config.PORT || 3000);
app.listen(port, () => console.log(`[OnePWS] Dashboard listening on port ${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await store.close(); process.exit(0); });
