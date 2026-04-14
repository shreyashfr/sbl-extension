// Leads by SBL - Content Script
// Bridges messages between the web app and the extension's background service worker

(function() {
  console.log('[SBL Content] Loaded on:', window.location.href);

  // Helper: send message to background with retry
  async function sendToBackground(msg, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        const response = await chrome.runtime.sendMessage(msg);
        if (response !== undefined) return response;
        console.log('[SBL Content] Got undefined response, retry', i + 1);
      } catch (err) {
        console.log('[SBL Content] sendMessage error, retry', i + 1, err.message);
      }
      await new Promise(r => setTimeout(r, 300));
    }
    return { ok: false, error: 'Background not responding' };
  }

  // Listen for messages from the web page
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    if (!event.data || typeof event.data.type !== 'string') return;
    if (!event.data.type.startsWith('SBL_')) return;
    if (event.data.type === 'SBL_EXTENSION_READY') return;
    if (event.data.type.endsWith('_RESPONSE')) return;
    if (event.data.type === 'SBL_HIRING_PROGRESS') return;

    console.log('[SBL Content] Forwarding:', event.data.type);

    const response = await sendToBackground(event.data);

    console.log('[SBL Content] Background responded:', event.data.type, response?.ok);

    window.postMessage({
      type: event.data.type + '_RESPONSE',
      requestId: event.data.requestId,
      ...response
    }, '*');
  });

  // Listen for progress broadcasts from background (pushed, not polled)
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'SBL_HIRING_PROGRESS') {
      // Forward to web page
      window.postMessage(message, '*');
    }
    return false;
  });

  // Check auth on load and announce READY
  async function announceReady() {
    let authStatus = { loggedIn: false };
    try {
      authStatus = await sendToBackground({ type: 'SBL_CHECK_AUTH' });
    } catch (e) {}

    window.postMessage({
      type: 'SBL_EXTENSION_READY', version: '1.1.0',
      loggedIn: authStatus?.loggedIn || false,
      hasJsessionid: authStatus?.hasJsessionid || false
    }, '*');
  }

  announceReady();
  setTimeout(announceReady, 1000);
  setTimeout(announceReady, 3000);
})();
