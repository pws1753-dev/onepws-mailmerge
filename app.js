import { parseCSV, prepareContacts, merge, buildMessage, isEmail, exportCSV } from './mail-core.js';
import { WorkspaceStore } from './workspace-store.js';

const $ = id => document.getElementById(id);
let parsed = { headers: [], rows: [] }, contacts = [], invalid = [];
let campaign = null, running = false, pauseRequested = false, email = '', editable = true, saveTimer, loadingContacts = false;
let templates = [], testProof = '', saveError = false;
let store;
let lastEditor = $('body');
const draftIds = ['csv', 'subject', 'body', 'delay', 'test-email', 'campaign-name'];

async function api(type, data = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...data });
  if (!response?.ok) throw new Error(response?.error || 'OnePWS could not reach its background service. Reopen the extension.');
  return response.result;
}
function notice(message, success = false) {
  $('notice').textContent = message;
  $('notice').className = `notice${success ? ' success' : ''}`;
  $('notice').hidden = false;
}
function guarded(fn) { return async (...args) => { try { await fn(...args); } catch (error) { notice(error.message); } }; }

function snapshot() {
  const draft = Object.fromEntries(draftIds.map(id => [id, $(id).value]));
  return { draft, emailColumn: $('email-column').value, contactsImported: parsed.rows.length > 0, campaign };
}
async function save() {
  clearTimeout(saveTimer);
  saveTimer = null;
  $('save-status').textContent = 'Saving…';
  try {
    await store.saveWorkspace(snapshot());
    saveError = false;
    $('save-status').textContent = store.remember ? 'Saved in this browser' : 'Saved for this session';
  } catch (error) {
    saveError = true;
    $('save-status').textContent = 'Changes not saved';
    throw new Error('Could not save your workspace. Your browser storage may be full. Export your report before clearing data. ' + error.message);
  }
}
function queueSave() {
  $('save-status').textContent = 'Unsaved changes';
  clearTimeout(saveTimer); saveTimer = setTimeout(guarded(save), 300);
}

function resetContacts() {
  contacts = []; invalid = []; parsed = { headers: [], rows: [] };
  $('email-column').replaceChildren(new Option('Import a CSV first', ''));
  $('fields').replaceChildren(); $('preview-contact').replaceChildren(new Option('Reimport your contacts', ''));
  $('contact-summary').textContent = 'Import your contacts to apply these changes.';
  renderContacts(); controls(); renderPreview();
}

function renderContacts() {
  $('contact-table-wrap').hidden = !contacts.length;
  const query = $('contact-search').value.trim().toLowerCase();
  const filtered = contacts.filter(contact => [contact.email, ...Object.values(contact.fields)].some(value => value.toLowerCase().includes(query)));
  // Keep the table responsive with large lists. Every contact is still included in the campaign.
  $('contact-rows').replaceChildren(...filtered.slice(0, 50).map(contact => {
    const row = document.createElement('tr');
    const address = document.createElement('td'); address.textContent = contact.email; address.title = contact.email;
    const details = document.createElement('td');
    details.textContent = Object.entries(contact.fields).filter(([name]) => name !== $('email-column').value).slice(0, 2).map(([, value]) => value).join(' · ') || '—';
    const status = document.createElement('td'); const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = 'Ready'; status.append(badge);
    row.append(address, details, status); return row;
  }));
  $('contact-table-note').textContent = `Showing ${Math.min(50, filtered.length)} of ${filtered.length} matching recipients. ${contacts.length} total in this campaign.`;
}

function renderOverview() {
  const items = campaign?.items || [];
  const sent = items.filter(item => item.status === 'sent').length;
  const pending = items.filter(item => ['pending', 'failed'].includes(item.status)).length;
  const unknown = items.some(item => ['sending', 'unknown'].includes(item.status));
  $('stat-contacts').textContent = contacts.length.toLocaleString();
  $('stat-contact-note').textContent = invalid.length ? `${invalid.length} invalid addresses to fix` : contacts.length ? 'Unique, validated recipients' : 'Import your contact list';
  $('stat-sent').textContent = sent.toLocaleString();
  $('stat-pending').textContent = pending.toLocaleString();
  $('stat-pending-note').textContent = campaign ? `${campaign.delay}s between deliveries` : 'Ready when you are';
  $('stat-status').textContent = running ? 'Sending' : !campaign ? 'Draft' : sent === items.length ? 'Complete' : 'Paused';
  $('stat-status-note').textContent = unknown ? 'Check unconfirmed deliveries' : campaign ? 'Progress saved as you go' : 'Make it your own';
}

function proofKey() { return JSON.stringify([email, $('csv').value, $('email-column').value, $('subject').value, $('body').value]); }
function renderReadiness() {
  let validMessage = false;
  try {
    const contact = contacts[Number($('preview-contact').value) || 0];
    if (contact) {
      const subject = merge($('subject').value, contact.fields), body = merge($('body').value, contact.fields);
      buildMessage({ from: email || 'preview@example.com', to: contact.email, subject, body }); validMessage = true;
    }
  } catch { /* Invalid merge fields remain visible in the preview. */ }
  const checks = [['Gmail connected', !!email], ['Recipients valid', !!contacts.length && !invalid.length], ['Message ready', validMessage], ['Test sent', testProof === proofKey()]];
  $('readiness').replaceChildren(...checks.map(([label, ready]) => {
    const item = document.createElement('span'); if (ready) item.className = 'ready';
    item.textContent = `${ready ? '✓' : '○'} ${label}`; return item;
  }));
}

function controls() {
  const locked = !!campaign || running || !editable || loadingContacts;
  for (const id of ['csv', 'csv-file', 'import', 'subject', 'body', 'delay']) $(id).disabled = locked;
  $('email-column').disabled = locked || !parsed.headers.length;
  $('connect').disabled = running || !editable;
  $('disconnect').disabled = running || !editable;
  const retryable = campaign?.items.some(item => ['pending', 'failed'].includes(item.status));
  $('review').disabled = running || loadingContacts || !email || !contacts.length || !!invalid.length || !editable || (!!campaign && !retryable);
  $('review').textContent = !campaign ? 'Review campaign →' : retryable ? 'Review & resume →' :
    campaign.items.every(item => item.status === 'sent') ? 'Campaign complete ✓' : 'Check unconfirmed deliveries';
  $('test').disabled = running || loadingContacts || !email || !contacts.length || !!invalid.length || !editable;
  $('new-campaign').disabled = running || !editable;
  $('campaign-name').disabled = !!campaign || running || !editable;
  $('template-save').disabled = running || !editable || !$('subject').value.trim() || !$('body').value.trim();
  $('clear-data').disabled = running || !editable;
  $('remember-workspace').disabled = running || !editable;
  $('pause').hidden = !running;
  $('preview-contact').disabled = !contacts.length;
  for (const button of $('fields').querySelectorAll('button')) button.disabled = locked;
  $('preview-prev').disabled = !contacts.length || Number($('preview-contact').value) <= 0;
  $('preview-next').disabled = !contacts.length || Number($('preview-contact').value) >= contacts.length - 1;
  renderOverview(); renderReadiness();
}

function renderPreview() {
  $('subject-count').textContent = `${$('subject').value.length} characters`;
  $('preview-from').textContent = email || 'Your Gmail account';
  const contact = contacts[Number($('preview-contact').value) || 0];
  $('preview-to').textContent = contact?.email || '—';
  try {
    const fields = contact?.fields || {};
    $('preview-subject').textContent = $('subject').value ? merge($('subject').value, fields) : 'Your subject will appear here';
    $('preview-body').textContent = $('body').value ? merge($('body').value, fields) : 'Write a message to see your personalized preview.';
  } catch (error) {
    $('preview-subject').textContent = 'Check your merge fields';
    $('preview-body').textContent = error.message;
  }
  renderReadiness();
}

function mapContacts() {
  const result = prepareContacts(parsed.rows, $('email-column').value);
  contacts = result.contacts;
  invalid = result.invalid;
  $('contact-summary').textContent = `${contacts.length} unique contacts · ${result.duplicates} duplicates removed` +
    (invalid.length ? ` · Fix invalid emails on CSV rows: ${invalid.join(', ')}. Sending is blocked until corrected.` : ' · Ready to personalize.');
  $('preview-contact').replaceChildren(...contacts.map((contact, index) => new Option(contact.email, String(index))));
  if (!contacts.length) $('preview-contact').append(new Option('No valid contacts', ''));
  renderContacts();
  controls();
  renderPreview();
}

function importContacts(preferredColumn = '') {
  resetContacts();
  const next = parseCSV($('csv').value);
  parsed = next;
  $('email-column').replaceChildren(...parsed.headers.map(header => new Option(header, header)));
  $('email-column').value = parsed.headers.includes(preferredColumn) ? preferredColumn :
    parsed.headers.find(header => /^e[-_ ]?mail(?:[-_ ]?address)?$/i.test(header)) || parsed.headers[0];
  $('fields').replaceChildren(...parsed.headers.map(header => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `{{${header}}}`;
    button.addEventListener('click', () => {
      lastEditor.setRangeText(`{{${header}}}`, lastEditor.selectionStart, lastEditor.selectionEnd, 'end');
      lastEditor.focus(); renderPreview(); queueSave();
    });
    return button;
  }));
  mapContacts();
}

async function importAndSave() {
  try { importContacts(); }
  catch (error) { await save(); throw error; }
  await save();
}

function renderProgress() {
  const items = campaign?.items || [];
  const sent = items.filter(item => item.status === 'sent').length;
  const failed = items.filter(item => item.status === 'failed').length;
  const unknown = items.filter(item => item.status === 'unknown' || item.status === 'sending').length;
  const pending = items.filter(item => item.status === 'pending').length;
  $('progress').textContent = campaign ? `${sent} of ${items.length} sent · ${pending} pending · ${failed} failed · ${unknown} unconfirmed` : 'No campaign started.';
  $('progress-bar').max = items.length || 1;
  $('progress-bar').value = sent;
  $('delivery-list').replaceChildren(...items.filter(item => item.status !== 'pending').map(item => {
    const row = document.createElement('div'); row.className = 'delivery';
    const address = document.createElement('span'); address.textContent = item.to;
    const status = document.createElement('span'); status.className = item.status; status.textContent = item.status;
    row.append(address, status);
    if (item.error) { const error = document.createElement('small'); error.textContent = item.error; row.append(error); }
    return row;
  }));
  controls();
}

function buildCampaign() {
  if (!email) throw new Error('Connect Gmail first.');
  if (!contacts.length || invalid.length) throw new Error('Import a valid contact list first.');
  const delay = Number($('delay').value);
  if (!Number.isFinite(delay) || delay < 1 || delay > 300) throw new Error('Choose a delay from 1 to 300 seconds.');
  const items = contacts.map(contact => {
    const subject = merge($('subject').value, contact.fields), body = merge($('body').value, contact.fields);
    buildMessage({ from: email, to: contact.email, subject, body });
    return { id: crypto.randomUUID(), to: contact.email, subject, body, status: 'pending' };
  });
  return { id: `campaign_${crypto.randomUUID().replaceAll('-', '')}`, name: $('campaign-name').value.trim() || 'Untitled campaign', from: email, delay, items, created: new Date().toISOString() };
}

async function syncDashboard(item) {
  if (!campaign?.id) return;
  try {
    await api('DASHBOARD_SYNC', { data: { campaign: { id: campaign.id, name: campaign.name, sender: campaign.from, recipients: campaign.items.length, status: running ? 'sending' : 'paused', createdAt: campaign.created }, event: { eventId: `event_${item.id}_${item.status}`, campaignId: campaign.id, type: item.status === 'sent' ? 'sent' : item.status === 'failed' ? 'failed' : 'queued', email: item.to, detail: item.status === 'sent' ? 'Sent from OnePWS Chrome extension.' : 'Delivery was not confirmed.', createdAt: item.at || new Date().toISOString() } } });
  } catch (error) { console.warn('OnePWS dashboard sync:', error.message); }
}

async function review() {
  const next = campaign || buildCampaign();
  if (next.from !== email) throw new Error(`This campaign belongs to ${next.from}. Connect that Gmail account or start a new campaign.`);
  const remaining = next.items.filter(item => item.status === 'pending' || item.status === 'failed').length;
  if (!remaining) throw new Error('No pending deliveries. Check unconfirmed messages in Gmail Sent, or start a new campaign.');
  $('review-summary').textContent = `Send ${remaining} individual email${remaining === 1 ? '' : 's'}, with ${next.delay} seconds between deliveries.`;
  $('review-sender').textContent = next.from;
  $('review-subject').textContent = next.items[0].subject;
  $('confirm-send').textContent = `Send ${remaining} email${remaining === 1 ? '' : 's'}`;
  $('review-dialog').showModal();
}

async function runCampaign() {
  $('review-dialog').close();
  if (running) return;
  campaign ||= buildCampaign();
  if (campaign.from !== email) throw new Error('The sender changed. Review this campaign again.');
  running = true; pauseRequested = false;
  $('pause').textContent = 'Pause after current email';
  renderProgress();
  try {
    await save();
    for (const item of campaign.items) {
      if (pauseRequested) break;
      if (!['pending', 'failed'].includes(item.status)) continue;
      item.status = 'sending'; delete item.error;
      // Persist intent before contacting Gmail; interrupted deliveries are reconciled on reopen.
      await save(); renderProgress();
      let result;
      try { result = await api('SEND', { ...item, from: campaign.from }); }
      catch (error) { result = { status: 'unknown', error: error.message }; }
      Object.assign(item, result);
      await syncDashboard(item);
      await save(); renderProgress();
      if (item.status !== 'sent') {
        notice(`${item.to}: ${item.error || 'Delivery could not be confirmed.'} Campaign paused. Check Gmail Sent before retrying unconfirmed deliveries.`);
        pauseRequested = true; break;
      }
      await new Promise(resolve => setTimeout(resolve, campaign.delay * 1000));
    }
    if (!pauseRequested) notice('Campaign complete. Your delivery report is ready to export.', true);
    else if (!$('notice').textContent.includes('Campaign paused.')) notice('Campaign paused. Review & resume when you are ready.', true);
  } finally { running = false; renderProgress(); }
}

async function sendTest() {
  if (!isEmail($('test-email').value.trim())) throw new Error('Enter a valid test recipient email.');
  const next = buildCampaign();
  const sample = next.items[Number($('preview-contact').value) || 0];
  running = true; controls();
  try {
    const result = await api('SEND', { ...sample, id: crypto.randomUUID(), from: email, to: $('test-email').value.trim(), subject: `[Test] ${sample.subject}` });
    if (result.status !== 'sent') throw new Error(`${result.error} ${result.status === 'unknown' ? 'Check Gmail Sent before testing again.' : ''}`);
    testProof = proofKey();
    notice(`Test sent to ${$('test-email').value.trim()}. Check the message before sending your campaign.`, true);
  } finally { running = false; controls(); }
}

function download(name, content) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function accountUI() {
  $('account').textContent = email || 'Connect your Gmail';
  $('account-detail').textContent = email ? 'Connected · Emails are sent from this account.' : 'Send directly from your own account.';
  $('connect').hidden = !!email; $('disconnect').hidden = !email;
  $('connection-badge').textContent = email ? 'Connected' : 'Not connected';
  $('connection-badge').className = email ? 'badge' : 'badge muted';
  $('sender-avatar').textContent = email ? email[0].toUpperCase() : 'O';
  controls(); renderPreview();
}

async function init() {
  store = new WorkspaceStore(chrome.storage);
  const loaded = await store.load();
  const saved = loaded.workspace;
  templates = loaded.templates;
  $('remember-workspace').checked = loaded.remember;
  $('save-status').textContent = loaded.remember ? 'Saved in this browser' : 'Saved for this session';
  if (saved) {
    for (const id of draftIds) if (saved.draft?.[id] !== undefined) $(id).value = saved.draft[id];
    if ($('csv').value.trim() && saved.contactsImported !== false) {
      try { importContacts(saved.emailColumn); } catch (error) { notice(error.message); }
    } else if ($('csv').value.trim()) {
      $('contact-summary').textContent = 'Your contact data has unsaved import changes. Choose Import contacts to validate and activate it.';
    }
    campaign = saved.campaign;
    if (campaign) {
      for (const item of campaign.items) {
        const record = (await chrome.storage.local.get(`delivery:${item.id}`))[`delivery:${item.id}`];
        if (record) Object.assign(item, record);
        if (item.status === 'sending') { item.status = 'unknown'; item.error = 'Interrupted delivery. Check Gmail Sent before sending again.'; }
      }
    }
  }
  const status = await api('STATUS'); email = status.email;
  if (!status.configured) notice('One-time setup needed: add your Google OAuth client ID. Open the setup guide to get started.');
  $('extension-id').textContent = chrome.runtime.id;
  accountUI(); renderProgress();

  $('setup-open').onclick = () => $('setup-dialog').showModal();
  $('setup-close').onclick = () => $('setup-dialog').close();
  $('connect').onclick = guarded(async () => {
    $('connect').disabled = true;
    try { email = (await api('CONNECT')).email; accountUI(); notice(`Connected as ${email}.`, true); }
    finally { controls(); }
  });
  $('disconnect').onclick = guarded(async () => { await api('DISCONNECT'); email = ''; accountUI(); notice('Gmail disconnected.', true); });
  $('import').onclick = guarded(importAndSave);
  $('email-column').onchange = guarded(async () => { mapContacts(); await save(); });
  $('preview-contact').onchange = () => { renderPreview(); controls(); };
  $('preview-prev').onclick = () => { $('preview-contact').selectedIndex--; renderPreview(); controls(); };
  $('preview-next').onclick = () => { $('preview-contact').selectedIndex++; renderPreview(); controls(); };
  $('contact-search').oninput = renderContacts;
  for (const id of draftIds) $(id).addEventListener('input', () => {
    if (id === 'csv') {
      resetContacts();
    }
    renderPreview(); controls(); queueSave();
  });
  for (const id of ['subject', 'body']) $(id).addEventListener('focus', () => { lastEditor = $(id); });
  $('sample').onclick = () => download('onepws-contacts.csv', 'Email,FirstName,Company\r\nalex@example.com,Alex,Example Co\r\nsam@example.com,Sam,Sample Studio\r\n');
  $('review').onclick = guarded(review);
  $('confirm-send').onclick = guarded(runCampaign);
  $('test').onclick = guarded(sendTest);
  $('pause').onclick = () => { pauseRequested = true; $('pause').textContent = 'Pausing…'; };
  $('export').onclick = guarded(() => {
    if (!campaign) throw new Error('Start a campaign to create a delivery report.');
    download('onepws-delivery-report.csv', exportCSV([['Email', 'Status', 'Message ID', 'Time', 'Error'], ...campaign.items.map(item => [item.to, item.status, item.messageId, item.at, item.error])]));
  });
  $('new-campaign').onclick = guarded(async () => {
    if ((campaign || $('subject').value || $('body').value || $('csv').value) && !confirm('Start a fresh campaign? Export the current report and save your message as a template first. Previously sent recipients can be emailed again in a new campaign.')) return;
    campaign = null; testProof = '';
    for (const id of ['csv', 'subject', 'body', 'campaign-name']) $(id).value = '';
    $('contact-search').value = ''; resetContacts(); await save(); renderProgress(); notice('Ready for a new campaign.', true);
  });
  setupExtras();
  window.addEventListener('beforeunload', event => {
    if (running || saveTimer || saveError) { event.preventDefault(); event.returnValue = ''; }
  });
}

function renderTemplates() {
  $('template-count').textContent = templates.length;
  $('template-list').replaceChildren(...templates.map(template => {
    const row = document.createElement('div'); row.className = 'template-item';
    const copy = document.createElement('div');
    const name = document.createElement('strong'); name.textContent = template.name;
    const subject = document.createElement('p'); subject.textContent = template.subject; copy.append(name, subject);
    const use = document.createElement('button'); use.className = 'secondary'; use.textContent = 'Use template'; use.disabled = !!campaign || running || !editable;
    use.onclick = guarded(async () => {
      if (campaign || running || !editable) return;
      if (($('subject').value || $('body').value) && !confirm('Replace the current subject and message with this template?')) return;
      $('subject').value = template.subject; $('body').value = template.body;
      $('templates-dialog').close(); renderPreview(); controls(); await save();
      $('message-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    const remove = document.createElement('button'); remove.className = 'delete-template'; remove.textContent = '×'; remove.setAttribute('aria-label', `Delete ${template.name}`); remove.disabled = !editable || running;
    remove.onclick = guarded(async () => {
      if (!confirm(`Delete the saved template “${template.name}”?`)) return;
      const next = templates.filter(item => item.id !== template.id); await store.saveTemplates(next); templates = next; renderTemplates();
    });
    row.append(copy, use, remove); return row;
  }));
  if (!templates.length) {
    const empty = document.createElement('p'); empty.textContent = 'Your library is ready for its first message. Write a subject and message, then choose Save template.'; $('template-list').append(empty);
  }
}

async function loadFile(file) {
  if (!file || campaign || running || !editable || loadingContacts) return;
  loadingContacts = true; resetContacts(); controls();
  try {
    if (!/\.csv$/i.test(file.name)) throw new Error('Choose a UTF-8 .csv file.');
    if (file.size > 4 * 1024 * 1024) throw new Error('This CSV exceeds the 4 MB browser import size. Split it into smaller files.');
    $('csv').value = await file.text(); await importAndSave();
  } catch (error) {
    if (!parsed.rows.length) await save();
    throw error;
  } finally { loadingContacts = false; controls(); $('csv-file').value = ''; }
}

function setupExtras() {
  renderTemplates();
  $('templates-open').onclick = () => { renderTemplates(); $('templates-dialog').showModal(); };
  $('dashboard-open').onclick = guarded(async () => {
    const status = await api('DASHBOARD_STATUS');
    $('dashboard-url').value = status.url;
    $('dashboard-device-id').value = status.deviceId;
    $('dashboard-device-secret').value = '';
    $('dashboard-status').textContent = status.connected ? `Connected to ${status.url}. The device secret remains hidden.` : 'Pair a device in the dashboard, then paste its credential here.';
    $('dashboard-dialog').showModal();
  });
  $('dashboard-save').onclick = guarded(async () => {
    const result = await api('DASHBOARD_CONNECT', { url: $('dashboard-url').value, deviceId: $('dashboard-device-id').value, deviceSecret: $('dashboard-device-secret').value });
    $('dashboard-device-secret').value = '';
    $('dashboard-status').textContent = `Connected to ${result.url}. New campaign outcomes will sync.`;
    notice('Dashboard reporting connected. Message content remains in this extension.', true);
  });
  $('dashboard-disconnect').onclick = guarded(async () => { await api('DASHBOARD_DISCONNECT'); $('dashboard-device-id').value = ''; $('dashboard-device-secret').value = ''; $('dashboard-status').textContent = 'Dashboard disconnected. New events will remain local.'; notice('Dashboard reporting disconnected.', true); });
  $('template-save').onclick = () => { $('template-name').value = $('campaign-name').value.trim(); $('template-save-dialog').showModal(); $('template-name').focus(); };
  $('template-form').onsubmit = guarded(async event => {
    event.preventDefault();
    if (running || !editable || !$('template-name').value.trim()) return;
    if (!$('subject').value.trim() || !$('body').value.trim()) throw new Error('Write a subject and message before saving a template.');
    const next = [{ id: crypto.randomUUID(), name: $('template-name').value.trim(), subject: $('subject').value, body: $('body').value }, ...templates];
    await store.saveTemplates(next); templates = next; renderTemplates(); $('template-save-dialog').close(); notice('Template saved to your local library.', true);
  });
  for (const button of document.querySelectorAll('[data-close]')) button.onclick = () => $(button.dataset.close).close();
  for (const id of ['privacy-open', 'privacy-details']) $(id).onclick = () => $('privacy-dialog').showModal();
  $('remember-workspace').onchange = guarded(async () => {
    clearTimeout(saveTimer); saveTimer = null;
    const remember = $('remember-workspace').checked;
    try { await store.setRemember(remember, snapshot()); await save(); }
    catch (error) { $('remember-workspace').checked = store.remember; throw error; }
  });
  $('clear-data').onclick = guarded(async () => {
    if (running || !editable) return;
    if (!confirm('Delete your contacts, draft, templates, and delivery receipts, and disconnect Gmail? This cannot be undone. Previously sent emails remain in Gmail.')) return;
    clearTimeout(saveTimer); saveTimer = null;
    await store.flush(); await api('CLEAR_DATA');
    // No reload: it must not trigger a queued autosave that recreates cleared personal data.
    campaign = null; templates = []; email = ''; testProof = '';
    for (const id of draftIds) $(id).value = id === 'delay' ? '3' : '';
    $('contact-search').value = ''; store.remember = true; $('remember-workspace').checked = true;
    resetContacts(); renderTemplates(); accountUI(); renderProgress();
    $('privacy-dialog').close(); $('save-status').textContent = 'Workspace cleared';
    notice('Saved data cleared and Gmail disconnected. Google still holds any email you already sent.', true);
  });
  $('csv-file').onchange = guarded(event => loadFile(event.target.files[0]));
  const zone = $('upload-zone');
  zone.addEventListener('dragover', event => { event.preventDefault(); if (!running && !campaign) zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', guarded(async event => { event.preventDefault(); zone.classList.remove('dragover'); await loadFile(event.dataTransfer.files[0]); }));
  for (const link of document.querySelectorAll('.side-nav a')) link.onclick = () => {
    document.querySelectorAll('.side-nav a').forEach(item => item.classList.toggle('active', item === link));
  };
}

// Hold a browser-wide lock for this workspace. Two open tabs must not race delivery state.
if (globalThis.chrome?.runtime?.id) {
  navigator.locks.request('onepws-workspace', { ifAvailable: true }, async lock => {
    if (!lock) { editable = false; controls(); notice('OnePWS is already open in another tab. Close that tab and reload this one to continue.'); return; }
    try { await init(); } catch (error) { notice(error.message); }
    await new Promise(() => {});
  });
} else notice('Load this folder as an unpacked Chrome extension to connect Gmail.');
