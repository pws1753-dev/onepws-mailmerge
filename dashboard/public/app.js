const $ = (selector) => document.querySelector(selector);
const num = new Intl.NumberFormat();
const fmt = (value) => num.format(Number(value || 0));
function rate(top, bottom) { return bottom ? `${((top / bottom) * 100).toFixed(1)}%` : '—'; }
function esc(value) { const node = document.createElement('span'); node.textContent = String(value || ''); return node.innerHTML; }
function eventLabel(event) { return `${event.type[0].toUpperCase()}${event.type.slice(1)}${event.email ? ` · ${event.email}` : ''}`; }
function render(data) {
  $('#source').textContent = `Data source: ${data.source}`;
  const metrics = [['sent', 'Sent'], ['delivered', 'Delivered'], ['opened', 'Opened'], ['replied', 'Replied'], ['bounced', 'Bounced']];
  $('#metrics').innerHTML = metrics.map(([key, label]) => `<article class="metric"><span>${label.toUpperCase()}</span><strong>${fmt(data.totals[key])}</strong><span>${key === 'bounced' ? rate(data.totals.bounced, data.totals.sent) + ' of sent' : key === 'opened' ? rate(data.totals.opened, data.totals.delivered) + ' of delivered' : 'All connected campaigns'}</span></article>`).join('');
  $('#campaign-count').textContent = `${data.campaigns.length} campaign${data.campaigns.length === 1 ? '' : 's'}`;
  $('#campaigns').innerHTML = data.campaigns.length ? data.campaigns.map((row) => `<tr><td>${esc(row.name)}</td><td><span class="badge ${esc(row.status)}">${esc(row.status)}</span></td><td>${fmt(row.sent)}</td><td>${fmt(row.delivered)}</td><td>${fmt(row.replied)}</td><td>${fmt(row.bounced)}</td></tr>`).join('') : '<tr><td class="empty" colspan="6">No campaign data yet. Pair your extension, then start a campaign.</td></tr>';
  $('#bounce-rate').textContent = rate(data.totals.bounced, data.totals.sent); $('#reply-rate').textContent = rate(data.totals.replied, data.totals.sent);
  $('#events').innerHTML = data.events.length ? data.events.map((event) => `<li><i class="event-dot"></i><div><b>${esc(eventLabel(event))}</b><time>${esc(new Date(event.createdAt).toLocaleString())}</time></div></li>`).join('') : '<li class="empty">No events have been synced yet.</li>';
}
async function load() { const response = await fetch('/api/dashboard'); if (response.status === 401) { $('#dashboard').hidden = true; $('#signin').hidden = false; return; } if (!response.ok) throw new Error('Could not load dashboard.'); $('#signin').hidden = true; $('#dashboard').hidden = false; render(await response.json()); }
$('#login-form').addEventListener('submit', async (event) => { event.preventDefault(); $('#login-error').textContent = ''; const response = await fetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('#password').value }) }); const data = await response.json(); if (!response.ok) return $('#login-error').textContent = data.error || 'Sign in failed.'; $('#password').value = ''; load(); });
$('#logout').addEventListener('click', async () => { await fetch('/api/session', { method: 'DELETE' }); $('#dashboard').hidden = true; $('#signin').hidden = false; });
const dialog = $('#pair-dialog'); $('#pair-device').addEventListener('click', () => dialog.showModal());
$('#create-device').addEventListener('click', async () => { const response = await fetch('/api/devices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: $('#device-label').value }) }); const data = await response.json(); if (!response.ok) return $('#pair-warning').textContent = data.error || 'Could not create credential.'; $('#device-credential').hidden = false; $('#device-credential').textContent = `Device ID: ${data.id}\nDevice secret: ${data.secret}`; $('#pair-warning').textContent = data.warning; });
load().catch(() => $('#login-error').textContent = 'The workspace is temporarily unavailable.');
