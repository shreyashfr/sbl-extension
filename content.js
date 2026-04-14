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
    return { ok: false, error: 'Background service worker not responding after retries' };
  }

  // Listen for messages from the web page
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    if (!event.data || typeof event.data.type !== 'string') return;
    if (!event.data.type.startsWith('SBL_')) return;
    if (event.data.type === 'SBL_EXTENSION_READY') return;
    if (event.data.type.endsWith('_RESPONSE')) return;

    console.log('[SBL Content] Forwarding:', event.data.type, 'requestId:', event.data.requestId);

    const response = await sendToBackground({
      type: event.data.type,
      keywords: event.data.keywords,
      count: event.data.count,
      start: event.data.start
    });

    console.log('[SBL Content] Background responded:', JSON.stringify(response));

    window.postMessage({
      type: event.data.type + '_RESPONSE',
      requestId: event.data.requestId,
      ok: response?.ok || false,
      loggedIn: response?.loggedIn || false,
      hasJsessionid: response?.hasJsessionid || false,
      reason: response?.reason || '',
      leads: response?.leads || [],
      error: response?.error || ''
    }, '*');
  });

  // Check auth on load and include status in READY message
  async function announceReady() {
    let authStatus = { loggedIn: false };
    try {
      authStatus = await sendToBackground({ type: 'SBL_CHECK_AUTH' });
    } catch (e) {
      console.log('[SBL Content] Auth pre-check failed:', e);
    }

    console.log('[SBL Content] Announcing READY, auth:', JSON.stringify(authStatus));

    window.postMessage({
      type: 'SBL_EXTENSION_READY',
      version: '1.0.0',
      loggedIn: authStatus?.loggedIn || false,
      hasJsessionid: authStatus?.hasJsessionid || false
    }, '*');
  }

  // Announce multiple times to handle timing
  announceReady();
  setTimeout(announceReady, 1000);
  setTimeout(announceReady, 3000);
})();
