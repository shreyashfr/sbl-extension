// Leads by SBL - Content Script
// Bridges messages between the web app and the extension's background service worker

(function() {
  console.log('[SBL Content] Extension content script loaded on:', window.location.href);

  // Listen for messages from the web page
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    if (!event.data || typeof event.data.type !== 'string') return;

    // Only forward request messages (not READY or RESPONSE)
    if (!event.data.type.startsWith('SBL_')) return;
    if (event.data.type === 'SBL_EXTENSION_READY') return;
    if (event.data.type.endsWith('_RESPONSE')) return;

    console.log('[SBL Content] Forwarding to background:', event.data.type);

    try {
      const response = await chrome.runtime.sendMessage({
        type: event.data.type,
        keywords: event.data.keywords,
        count: event.data.count,
        start: event.data.start,
        requestId: event.data.requestId
      });

      console.log('[SBL Content] Got response from background:', response);

      window.postMessage({
        type: event.data.type + '_RESPONSE',
        requestId: event.data.requestId,
        ...response
      }, '*');
    } catch (err) {
      console.error('[SBL Content] Error:', err);
      window.postMessage({
        type: event.data.type + '_RESPONSE',
        requestId: event.data.requestId,
        ok: false,
        error: err.message || 'Extension communication failed'
      }, '*');
    }
  });

  // Announce that extension is loaded — retry a few times in case app.js isn't ready yet
  function announce() {
    console.log('[SBL Content] Announcing extension ready');
    window.postMessage({ type: 'SBL_EXTENSION_READY', version: '1.0.0' }, '*');
  }

  announce();
  setTimeout(announce, 500);
  setTimeout(announce, 1500);
  setTimeout(announce, 3000);
})();
