const test = require('node:test');
const assert = require('node:assert/strict');
const { createSession, metricsFromEvents, validateEvent, verifySession } = require('../lib.js');

test('session token verifies only with its secret', () => { const token = createSession('correct-secret'); assert.ok(verifySession(token, 'correct-secret')); assert.equal(verifySession(token, 'wrong-secret'), false); });
test('metrics count campaign events without making a negative queue', () => { const [campaign] = metricsFromEvents([{ id: 'campaign_123', recipients: 1 }], [{ campaignId: 'campaign_123', type: 'sent' }, { campaignId: 'campaign_123', type: 'sent' }, { campaignId: 'campaign_123', type: 'bounced' }]); assert.equal(campaign.sent, 2); assert.equal(campaign.pending, 0); assert.equal(campaign.bounced, 1); });
test('event validation rejects unknown event types and malformed campaign ids', () => { assert.ok(validateEvent({ type: 'wrong', campaignId: 'campaign_123' })); assert.ok(validateEvent({ type: 'sent', campaignId: 'x' })); assert.equal(validateEvent({ type: 'sent', campaignId: 'campaign_123' }), null); });
