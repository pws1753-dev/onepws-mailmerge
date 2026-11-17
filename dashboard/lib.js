import crypto from 'node:crypto';

export const now = () => new Date().toISOString();

export function parseEnv(source) {
  return Object.fromEntries(source.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#')).map((line) => {
    const point = line.indexOf('=');
    return point < 0 ? [line, ''] : [line.slice(0, point), line.slice(point + 1)];
  }));
}

export function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

export function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createSession(secret, ttlSeconds = 60 * 60 * 12) {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + ttlSeconds, nonce: crypto.randomUUID() })).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySession(token, secret) {
  if (!token || !secret) return false;
  const [payload, signature] = token.split('.');
  if (!payload || !signature || !safeEqual(signature, sign(payload, secret))) return false;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Math.floor(Date.now() / 1000); } catch { return false; }
}

export function metricsFromEvents(campaigns, events) {
  const byCampaign = new Map(campaigns.map((campaign) => [campaign.id, { ...campaign, sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, replied: 0, unsubscribed: 0, pending: campaign.recipients ?? 0 }]));
  for (const event of events) {
    const item = byCampaign.get(event.campaignId);
    if (!item) continue;
    if (event.type === 'sent') { item.sent++; item.pending = Math.max(0, item.pending - 1); }
    if (event.type === 'delivered') item.delivered++;
    if (event.type === 'opened') item.opened++;
    if (event.type === 'clicked') item.clicked++;
    if (event.type === 'bounced') item.bounced++;
    if (event.type === 'replied') item.replied++;
    if (event.type === 'unsubscribed') item.unsubscribed++;
  }
  return [...byCampaign.values()].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

export function validateEvent(event) {
  const types = new Set(['sent', 'delivered', 'opened', 'clicked', 'bounced', 'replied', 'unsubscribed', 'failed', 'queued']);
  if (!event || typeof event !== 'object' || !types.has(event.type)) return 'Unsupported event type.';
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(String(event.campaignId || ''))) return 'Invalid campaign id.';
  if (event.email && (typeof event.email !== 'string' || event.email.length > 320)) return 'Invalid recipient email.';
  return null;
}
