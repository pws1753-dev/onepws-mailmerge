(() => {
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
})();
