(() => {
  function importCompose(compose) {
    const subject = compose.querySelector('input[name="subjectbox"]')?.value || '';
    const body = compose.querySelector('[contenteditable="true"][aria-label^="Message Body"], [contenteditable="true"][role="textbox"]')?.innerText || '';
    chrome.runtime.sendMessage({ type: 'IMPORT_GMAIL_DRAFT', draft: { subject, body } }).catch(() => {
      window.alert('OnePWS could not open. Refresh Gmail and try again.');
    });
  }

  function addComposeButton(compose) {
    if (compose.querySelector('.onepws-compose-button')) return;
    const toolbar = compose.querySelector('[role="toolbar"]');
    if (!toolbar) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'onepws-compose-button';
    button.textContent = 'OnePWS campaign';
    button.title = 'Use this Gmail draft in OnePWS Mail Merge';
    button.addEventListener('click', () => importCompose(compose));
    toolbar.append(button);
  }

  function scanComposers() {
    document.querySelectorAll('[role="dialog"]').forEach(addComposeButton);
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
})();
