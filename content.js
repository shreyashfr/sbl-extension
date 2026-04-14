// Leads by SBL - Content Script
// Bridges messages between the web app and the extension's background service worker

(function() {
  // Listen for messages from the web page
  window.addEventListener('message', async (event) => {
    // Only accept messages from the same window
    if (event.source !== window) return;
    if (!event.data || !event.data.type?.startsWith('SBL_')) return;

    try {
      // Forward to background service worker
      const response = await chrome.runtime.sendMessage(event.data);

      // Send response back to the web page
      window.postMessage({
        type: event.data.type + '_RESPONSE',
        requestId: event.data.requestId,
        ...response
      }, '*');
    } catch (err) {
      window.postMessage({
        type: event.data.type + '_RESPONSE',
        requestId: event.data.requestId,
        ok: false,
        error: err.message || 'Extension communication failed'
      }, '*');
    }
  });

  // Announce that extension is loaded
  window.postMessage({ type: 'SBL_EXTENSION_READY', version: '1.0.0' }, '*');
})();
