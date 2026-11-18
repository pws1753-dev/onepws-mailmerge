(() => {
  const $ = (selector, root = document) => root.querySelector(selector);

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

  async function openWorkspace(compose, panel) {
    const button = $('.onepws-open-workspace', panel);
    button.disabled = true;
    button.textContent = 'Opening...';
    try {
      await chrome.runtime.sendMessage({ type: 'IMPORT_GMAIL_DRAFT', draft: readDraft(compose) });
      button.textContent = 'Opened in OnePWS';
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Open campaign studio';
      $('.onepws-panel-status', panel).textContent = error.message || 'Could not open OnePWS. Refresh Gmail and try again.';
    }
  }

  function togglePanel(compose) {
    const existing = $('.onepws-gmail-panel', compose);
    if (existing) {
      existing.hidden = !existing.hidden;
      if (!existing.hidden) updatePanelSummary(existing, compose);
      return;
    }
    const panel = document.createElement('aside');
    panel.className = 'onepws-gmail-panel';
    panel.setAttribute('aria-label', 'OnePWS campaign controls');
    panel.innerHTML = `
      <header class="onepws-panel-header"><div><span class="onepws-panel-kicker">ONEPWS MAIL MERGE</span><strong>Campaign controls</strong></div><button type="button" class="onepws-panel-close" aria-label="Close OnePWS controls">Close</button></header>
      <div class="onepws-panel-body">
        <section class="onepws-panel-card onepws-draft-card"><span class="onepws-panel-label">GMAIL DRAFT</span><strong class="onepws-panel-subject"></strong><p class="onepws-panel-message"></p></section>
        <section class="onepws-panel-card onepws-compose-actions"><div class="onepws-panel-title"><strong>Campaign recipients</strong><span>01</span></div><p>Connect a Google Sheet or import a CSV. OnePWS removes duplicates and checks addresses before delivery.</p><div class="onepws-panel-buttons"><button type="button" class="onepws-open-workspace">Add recipients</button><button type="button" class="onepws-panel-link" data-onepws-action="templates">Templates</button></div></section>
        <section class="onepws-panel-card"><div class="onepws-panel-title"><strong>Personalize</strong><span>02</span></div><p>Use fields from your recipient list directly in this Gmail draft.</p><div class="onepws-field-preview"><code>{{FirstName}}</code><code>{{Company}}</code><span>Choose fields in campaign studio</span></div></section>
        <details class="onepws-panel-details" open><summary>Delivery</summary><div class="onepws-option-row"><span>Individual Gmail messages</span><b>Enabled</b></div><div class="onepws-option-row"><span>Test email and live preview</span><b>Required</b></div><button type="button" class="onepws-open-workspace onepws-wide">Review campaign</button></details>
        <details class="onepws-panel-details"><summary>Follow-up & schedule</summary><p>Scheduled sending and reply-stop follow-ups need the OnePWS dashboard worker. They are not enabled in this local Gmail panel yet.</p></details>
        <details class="onepws-panel-details"><summary>Privacy & deliverability</summary><p>OnePWS sends through your Gmail account. It does not bypass Gmail limits or claim inbox/spam placement without real seed-inbox data.</p></details>
        <p class="onepws-panel-status" role="status">No email is sent from this panel. Open OnePWS to preview, test and explicitly confirm delivery.</p>
      </div>`;
    $('.onepws-panel-close', panel).addEventListener('click', () => panel.remove());
    panel.querySelectorAll('.onepws-open-workspace').forEach(button => button.addEventListener('click', () => openWorkspace(compose, panel)));
    panel.querySelectorAll('[data-onepws-action]').forEach(button => button.addEventListener('click', () => openWorkspace(compose, panel)));
    compose.append(panel);
    updatePanelSummary(panel, compose);
  }

  function addComposeButton(compose) {
    if (compose.querySelector('.onepws-compose-button')) return;
    const sendButton = compose.querySelector('[role="button"][aria-label^="Send"], [data-tooltip^="Send"]');
    // Gmail's first role=toolbar is often the formatting row. Prefer the Send
    // button's container so OnePWS always sits beside the actual Send control.
    const toolbar = sendButton?.parentElement || compose.querySelector('[role="toolbar"]');
    if (!toolbar) return;
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
