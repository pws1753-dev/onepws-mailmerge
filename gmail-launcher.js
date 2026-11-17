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
        <section class="onepws-panel-card"><div class="onepws-panel-title"><strong>Recipients & personalization</strong><span>01</span></div><p>Import a CSV or Google Sheet, choose the email column, and insert fields such as <code>{{FirstName}}</code>.</p><button type="button" class="onepws-open-workspace">Open campaign studio</button></section>
        <section class="onepws-panel-card"><div class="onepws-panel-title"><strong>Delivery safeguards</strong><span>02</span></div><ul class="onepws-panel-list"><li>Preview every merge field before delivery</li><li>Send an explicit test email first</li><li>Pause safely; completed sends are not resent</li></ul></section>
        <details class="onepws-panel-details"><summary>Campaign options</summary><p>Templates, test delivery, reply checks and delivery reports are configured in OnePWS campaign studio so every action is reviewed before email is sent.</p></details>
        <p class="onepws-panel-status" role="status">No emails are sent from this panel. Review and confirm in OnePWS.</p>
      </div>`;
    $('.onepws-panel-close', panel).addEventListener('click', () => panel.remove());
    $('.onepws-open-workspace', panel).addEventListener('click', () => openWorkspace(compose, panel));
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
