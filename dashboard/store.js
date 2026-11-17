import crypto from 'node:crypto';
import { MongoClient } from 'mongodb';
import { metricsFromEvents, now } from './lib.js';

export class DashboardStore {
  constructor(uri, database = 'onepws_mailmerge') {
    this.uri = uri;
    this.databaseName = database;
    this.client = null;
    this.db = null;
    this.memory = { campaigns: [], events: [], devices: [] };
  }
  async connect() {
    if (!this.uri) return false;
    this.client = new MongoClient(this.uri, { serverSelectionTimeoutMS: 6000 });
    await this.client.connect();
    this.db = this.client.db(this.databaseName);
    await Promise.all([
      this.db.collection('campaigns').createIndex({ id: 1 }, { unique: true }),
      this.db.collection('events').createIndex({ eventId: 1 }, { unique: true }),
      this.db.collection('events').createIndex({ campaignId: 1, createdAt: -1 }),
      this.db.collection('devices').createIndex({ id: 1 }, { unique: true })
    ]);
    return true;
  }
  async close() { await this.client?.close(); }
  async createDevice(label = 'Chrome extension') {
    const device = { id: `dev_${crypto.randomUUID().replaceAll('-', '')}`, secret: crypto.randomBytes(32).toString('base64url'), label: String(label).slice(0, 80), createdAt: now(), revokedAt: null };
    if (this.db) await this.db.collection('devices').insertOne(device); else this.memory.devices.push(device);
    return device;
  }
  async findDevice(id) { return this.db ? this.db.collection('devices').findOne({ id, revokedAt: null }) : this.memory.devices.find((d) => d.id === id && !d.revokedAt); }
  async upsertCampaign(campaign) {
    const data = { id: campaign.id, name: String(campaign.name || 'Untitled campaign').slice(0, 160), sender: String(campaign.sender || '').slice(0, 320), recipients: Math.max(0, Number(campaign.recipients) || 0), status: ['draft', 'scheduled', 'sending', 'paused', 'completed'].includes(campaign.status) ? campaign.status : 'draft', createdAt: campaign.createdAt || now(), updatedAt: now() };
    if (this.db) await this.db.collection('campaigns').updateOne({ id: data.id }, { $set: data, $setOnInsert: { createdAt: data.createdAt } }, { upsert: true });
    else { const at = this.memory.campaigns.findIndex((c) => c.id === data.id); if (at < 0) this.memory.campaigns.push(data); else this.memory.campaigns[at] = { ...this.memory.campaigns[at], ...data }; }
    return data;
  }
  async appendEvent(event) {
    const data = { eventId: event.eventId || `evt_${crypto.randomUUID().replaceAll('-', '')}`, campaignId: event.campaignId, type: event.type, email: event.email ? String(event.email).toLowerCase() : null, detail: typeof event.detail === 'string' ? event.detail.slice(0, 500) : null, createdAt: event.createdAt || now() };
    if (this.db) { try { await this.db.collection('events').insertOne(data); } catch (error) { if (error?.code !== 11000) throw error; } }
    else if (!this.memory.events.some((e) => e.eventId === data.eventId)) this.memory.events.push(data);
    return data;
  }
  async dashboard() {
    const campaigns = this.db ? await this.db.collection('campaigns').find({}).sort({ updatedAt: -1 }).limit(100).toArray() : this.memory.campaigns;
    const events = this.db ? await this.db.collection('events').find({}).sort({ createdAt: -1 }).limit(5000).toArray() : this.memory.events;
    const rows = metricsFromEvents(campaigns, events);
    const totals = rows.reduce((sum, row) => { for (const key of ['sent', 'delivered', 'opened', 'clicked', 'bounced', 'replied', 'unsubscribed', 'pending']) sum[key] += row[key] || 0; return sum; }, { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, replied: 0, unsubscribed: 0, pending: 0 });
    return { source: this.db ? 'MongoDB Atlas' : 'local development memory', totals, campaigns: rows, events: events.slice(0, 40).map(({ _id, ...event }) => event) };
  }
}
