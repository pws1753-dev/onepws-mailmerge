(() => {
  const $ = (selector, root = document) => root.querySelector(selector);

  async function call(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || 'OnePWS did not complete the action.');
    return response.result;
  }

  function readDraft(compose) {
    return {
      subject: $('input[name="subjectbox"]', compose)?.value || '',
      body: $('[contenteditable="true"][aria-label^="Message Body"], [contenteditable="true"][role="textbox"]', compose)?.innerText || ''
    };
  }

  function updatePanelSummary(panel, compose) {
    const draft = readDraft(compose);
    $('.onepws-panel-subject', panel).textContent = draft.subject.trim() || 'No subject yet';
    $('.onepws-panel-message', panel).textContent = draft.body.trim() ? `${draft.body.trim().slice(0, 92)}${draft.body.trim().length > 92 ? '...' : ''}` : 'Write your message in Gmail, then open campaign studio.';
  }

  async function openWorkspace(compose, panel, trigger) {
    const button = trigger || $('.onepws-open-workspace', panel);
    button.disabled = true;
    button.textContent = 'Opening...';
    try {
      const testEmail = $('.onepws-test-email', panel)?.value.trim() || '';
      await call({ type: 'IMPORT_GMAIL_DRAFT', draft: { ...readDraft(compose), testEmail } });
      button.textContent = 'Opened in OnePWS';
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Open campaign studio';
      $('.onepws-panel-status', panel).textContent = error.message || 'Could not open OnePWS. Refresh Gmail and try again.';
    }
  }

  function setComposeValue(element, value) {
    if (!element) return;
    if ('value' in element) element.value = value;
    else element.textContent = value;
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  }

  function applyTemplate(panel, compose) {
    const selected = $('.onepws-template-select', panel);
    const template = panel._onepwsTemplates?.find(item => item.id === selected.value);
    if (!template) return;
    setComposeValue($('input[name="subjectbox"]', compose), template.subject);
    setComposeValue($('[contenteditable="true"][aria-label^="Message Body"], [contenteditable="true"][role="textbox"]', compose), template.body);
    updatePanelSummary(panel, compose);
    $('.onepws-panel-status', panel).textContent = `Template “${template.name}” applied to this Gmail draft.`;
  }

  function insertField(panel, compose, field) {
    const token = `{{${field}}}`;
    const subject = $('input[name="subjectbox"]', compose);
    const body = $('[contenteditable="true"][aria-label^="Message Body"], [contenteditable="true"][role="textbox"]', compose);
    const target = compose._onepwsLastEditor === subject ? subject : body;
    if (!target) return;
    target.focus();
    if ('selectionStart' in target) target.setRangeText(token, target.selectionStart, target.selectionEnd, 'end');
    else {
      const selection = window.getSelection();
      if (selection?.rangeCount && target.contains(selection.anchorNode)) {
        const range = selection.getRangeAt(0); range.deleteContents(); range.insertNode(document.createTextNode(token)); range.collapse(false);
      } else target.append(document.createTextNode(token));
    }
    target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: token }));
    updatePanelSummary(panel, compose);
  }

  function checkLinks(panel, compose) {
    const links = readDraft(compose).body.match(/https?:\/\/[^\s<>()]+/gi) || [];
    $('.onepws-panel-status', panel).textContent = links.length ? `${links.length} link${links.length === 1 ? '' : 's'} found. URL format looks valid; destination availability is not inferred.` : 'No web links found in this Gmail draft.';
  }

  async function loadPanelData(panel) {
    try {
      const data = await call({ type: 'GMAIL_PANEL_DATA' });
      panel._onepwsTemplates = data.templates;
      $('.onepws-test-email', panel).value = data.preferences.testEmail;
      const select = $('.onepws-template-select', panel);
      select.replaceChildren(new Option(data.templates.length ? 'Select a saved template' : 'No saved templates yet', ''));
      data.templates.forEach(template => select.append(new Option(template.name, template.id)));
    } catch (error) { $('.onepws-panel-status', panel).textContent = error.message; }
  }

  function togglePanel(compose) {
    const existing = $('.onepws-gmail-panel');
    if (existing) {
      existing._onepwsCompose = compose;
      existing.hidden = !existing.hidden;
      if (!existing.hidden) updatePanelSummary(existing, compose);
      return;
    }
    const panel = document.createElement('aside');
    panel.className = 'onepws-gmail-panel';
    panel.setAttribute('aria-label', 'OnePWS campaign controls');
    panel.innerHTML = `
      <header class="onepws-panel-header"><div><span class="onepws-panel-kicker">ONEPWS MAIL MERGE · V1.2</span><strong>Campaign controls</strong></div><button type="button" class="onepws-panel-close" aria-label="Close OnePWS controls">×</button></header>
      <div class="onepws-panel-body">
        <div class="onepws-tool-strip"><button type="button" data-onepws-action="campaign">Campaign</button><button type="button" data-onepws-action="links">Link check</button><button type="button" data-onepws-action="report">Reports</button></div>
        <section class="onepws-test-row"><label for="onepws-test-email">Test</label><div><input id="onepws-test-email" class="onepws-test-email" type="email" placeholder="you@example.com"><button type="button" class="onepws-test-open">Prepare test</button></div></section>
        <section class="onepws-panel-card onepws-draft-card"><span class="onepws-panel-label">GMAIL DRAFT</span><strong class="onepws-panel-subject"></strong><p class="onepws-panel-message"></p></section>
        <section class="onepws-panel-card onepws-compose-actions"><div class="onepws-panel-title"><strong>Campaign recipients</strong><span>01</span></div><p>Connect a Google Sheet or import a CSV. OnePWS removes duplicates and validates the recipient list.</p><div class="onepws-panel-buttons"><button type="button" class="onepws-open-workspace">Add recipients</button><button type="button" class="onepws-panel-link" data-onepws-action="templates">Manage templates</button></div></section>
        <section class="onepws-panel-card"><div class="onepws-panel-title"><strong>Templates & personalization</strong><span>02</span></div><label class="onepws-control-label" for="onepws-template-select">Saved template</label><select id="onepws-template-select" class="onepws-template-select"><option>Loading templates...</option></select><p>Click a merge field to insert it into the active subject or message.</p><div class="onepws-field-preview"><button type="button" data-field="FirstName">{{FirstName}}</button><button type="button" data-field="Company">{{Company}}</button><button type="button" data-field="Email">{{Email}}</button></div></section>
        <details class="onepws-panel-details" open><summary>Delivery</summary><div class="onepws-option-row"><span>Individual Gmail messages</span><b>Enabled</b></div><div class="onepws-option-row"><span>Create drafts instead</span><b>Planned</b></div><div class="onepws-option-row"><span>Test email and live preview</span><b>Required</b></div><button type="button" class="onepws-open-workspace onepws-wide">Review campaign</button></details>
        <details class="onepws-panel-details"><summary>Tracking</summary><p>Reply detection is available. Open/click tracking stays off until your OnePWS tracking domain and consent workflow are configured.</p></details>
        <details class="onepws-panel-details"><summary>Follow-up & schedule</summary><p>Scheduled sending and reply-stop follow-ups need the OnePWS dashboard worker. They are not enabled in this local Gmail panel yet.</p></details>
        <details class="onepws-panel-details"><summary>Privacy & deliverability</summary><p>OnePWS sends through your Gmail account. It does not bypass Gmail limits or claim inbox/spam placement without real seed-inbox data.</p></details>
        <p class="onepws-panel-status" role="status">No email is sent from this panel. Open OnePWS to preview, test and explicitly confirm delivery.</p>
      </div>`;
    panel._onepwsCompose = compose;
    $('.onepws-panel-close', panel).addEventListener('click', () => { panel.hidden = true; });
    panel.querySelectorAll('.onepws-open-workspace, .onepws-test-open').forEach(button => button.addEventListener('click', () => openWorkspace(panel._onepwsCompose, panel, button)));
    panel.querySelectorAll('[data-field]').forEach(button => button.addEventListener('click', () => insertField(panel, panel._onepwsCompose, button.dataset.field)));
    $('.onepws-template-select', panel).addEventListener('change', () => applyTemplate(panel, panel._onepwsCompose));
    $('.onepws-test-email', panel).addEventListener('change', async event => {
      try { await call({ type: 'GMAIL_PANEL_SAVE', preferences: { testEmail: event.target.value } }); $('.onepws-panel-status', panel).textContent = 'Test address saved in this Chrome profile.'; }
      catch (error) { $('.onepws-panel-status', panel).textContent = error.message; }
    });
    panel.querySelector('[data-onepws-action="campaign"]').addEventListener('click', event => openWorkspace(panel._onepwsCompose, panel, event.currentTarget));
    panel.querySelector('[data-onepws-action="templates"]').addEventListener('click', event => openWorkspace(panel._onepwsCompose, panel, event.currentTarget));
    panel.querySelector('[data-onepws-action="links"]').addEventListener('click', () => checkLinks(panel, panel._onepwsCompose));
    panel.querySelector('[data-onepws-action="report"]').addEventListener('click', async () => { try { await call({ type: 'OPEN_DASHBOARD' }); } catch (error) { $('.onepws-panel-status', panel).textContent = error.message; } });
    document.body.append(panel);
    updatePanelSummary(panel, compose);
    loadPanelData(panel);
  }

  function addComposeButton(compose) {
    if (compose.querySelector('.onepws-compose-button')) return;
    const sendButton = compose.querySelector('[role="button"][aria-label^="Send"], [data-tooltip^="Send"]');
    // Gmail's first role=toolbar is often the formatting row. Prefer the Send
    // button's container so OnePWS always sits beside the actual Send control.
    const toolbar = sendButton?.parentElement || compose.querySelector('[role="toolbar"]');
    if (!toolbar) return;
    if (!compose.dataset.onepwsEditorTracking) {
      compose.dataset.onepwsEditorTracking = 'true';
      compose.addEventListener('focusin', event => { if (event.target.matches?.('input[name="subjectbox"], [contenteditable="true"]')) compose._onepwsLastEditor = event.target; });
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'onepws-compose-button';
    button.textContent = 'OnePWS Send';
    button.title = 'Open OnePWS campaign controls beside Gmail Send';
    button.addEventListener('click', () => togglePanel(compose));
    if (sendButton && sendButton.parentElement === toolbar) toolbar.insertBefore(button, sendButton);
    else toolbar.append(button);
  }

  function findComposeRoot(subject) {
    let node = subject;
    for (let level = 0; node && level < 12; level += 1, node = node.parentElement) {
      if (node.matches?.('[role="dialog"]') || node.querySelector?.('[role="button"][aria-label^="Send"], [data-tooltip^="Send"]')) return node;
    }
    return null;
  }

  function scanComposers() {
    const roots = new Set([...document.querySelectorAll('[role="dialog"]'), ...[...document.querySelectorAll('input[name="subjectbox"]')].map(findComposeRoot).filter(Boolean)]);
    roots.forEach(addComposeButton);
  }

  if (document.getElementById('onepws-launcher')) return;
  const button = document.createElement('button');
  button.id = 'onepws-launcher';
  button.type = 'button';
  button.title = 'Open OnePWS Mail Merge';
  const icon = document.createElement('img');
  icon.src = chrome.runtime.getURL('assets/icon-48.png');
  icon.alt = '';
  const label = document.createElement('span');
  label.textContent = 'OnePWS';
  button.append(icon, label);
  button.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_WORKSPACE' }).catch(() => {
      button.title = 'Extension updated. Refresh Gmail to open OnePWS.';
    });
  });
  document.body.append(button);
  scanComposers();
  new MutationObserver(scanComposers).observe(document.documentElement, { childList: true, subtree: true });
  window.setInterval(scanComposers, 1500);
})();
