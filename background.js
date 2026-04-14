// Leads by SBL - Background Service Worker
// Handles LinkedIn API calls using the user's authenticated session

// Get LinkedIn cookies from the browser using getAll (more reliable than get)
async function getLinkedInCookies() {
  const allCookies = await chrome.cookies.getAll({ domain: '.linkedin.com' });

  const li_at = allCookies.find(c => c.name === 'li_at');
  const jsessionid = allCookies.find(c => c.name === 'JSESSIONID');
  const li_a = allCookies.find(c => c.name === 'li_a');

  console.log('[SBL] Cookie check — li_at:', !!li_at, 'JSESSIONID:', !!jsessionid, 'li_a:', !!li_a);
  console.log('[SBL] Total linkedin cookies found:', allCookies.length);

  if (!li_at?.value) {
    throw new Error('NOT_LOGGED_IN');
  }

  // JSESSIONID sometimes has quotes around it
  const csrf = jsessionid?.value?.replace(/"/g, '') || '';

  if (!csrf) {
    throw new Error('NO_CSRF_TOKEN');
  }

  return {
    li_at: li_at.value,
    li_a: li_a?.value || '',
    jsessionid: csrf
  };
}

// Search people on LinkedIn Voyager API by job title keyword
async function voyagerPeopleSearch(keywords, start = 0, count = 25) {
  const cookies = await getLinkedInCookies();
  const encoded = encodeURIComponent(keywords);

  const url = `https://www.linkedin.com/voyager/api/graphql?includeWebMetadata=true&variables=(start:${start},origin:GLOBAL_SEARCH_HEADER,query:(keywords:${encoded},flagshipSearchIntent:SEARCH_SRP,queryParameters:List((key:resultType,value:List(PEOPLE))),includeFiltersInResponse:false))&queryId=voyagerSearchDashClusters.b0928897b71bd00a5a7291755dcd64f0`;

  const headers = {
    'csrf-token': cookies.jsessionid,
    'x-li-lang': 'en_US',
    'x-li-track': JSON.stringify({
      clientVersion: '1.13.8920',
      mpVersion: '1.13.8920',
      osName: 'web',
      timezoneOffset: -5.5,
      timezone: 'Asia/Kolkata',
      deviceFormFactor: 'DESKTOP',
      mpName: 'voyager-web',
      displayDensity: 1,
      displayWidth: 1920,
      displayHeight: 1080
    }),
    'x-restli-protocol-version': '2.0.0',
    'Accept': 'application/vnd.linkedin.normalized+json+2.1'
  };

  console.log('[SBL] Fetching Voyager API for:', keywords);

  const resp = await fetch(url, {
    headers,
    credentials: 'include'
  });

  console.log('[SBL] Voyager response status:', resp.status);

  if (!resp.ok) {
    const status = resp.status;
    if (status === 401 || status === 403) {
      throw new Error('AUTH_EXPIRED');
    }
    throw new Error(`VOYAGER_ERROR:${status}`);
  }

  const data = await resp.json();
  return parseVoyagerResults(data, count);
}

// Parse Voyager search response into clean lead objects
function parseVoyagerResults(data, maxCount) {
  const leads = [];
  const included = data.included || [];

  for (const item of included) {
    if (!item.navigationUrl?.includes('/in/')) continue;

    const publicId = item.navigationUrl.match(/\/in\/([^/?]+)/)?.[1];
    if (!publicId) continue;

    const name = item.title?.text || '';
    const headline = item.primarySubtitle?.text || '';
    const location = item.secondarySubtitle?.text || '';

    if (!name) continue;

    const { role, company } = parseHeadline(headline);

    leads.push({
      name,
      title: role || headline,
      company: company || '',
      location,
      headline,
      profileUrl: `https://www.linkedin.com/in/${publicId}`,
      publicId
    });

    if (leads.length >= maxCount) break;
  }

  console.log('[SBL] Parsed', leads.length, 'leads from Voyager response');
  return leads;
}

// Parse LinkedIn headline into role and company
function parseHeadline(headline) {
  if (!headline) return { role: '', company: '' };

  const separators = [' at ', ' @ ', ' | '];
  for (const sep of separators) {
    const idx = headline.indexOf(sep);
    if (idx > 0) {
      return {
        role: headline.substring(0, idx).trim(),
        company: headline.substring(idx + sep.length).split(/[|·]/)[0].trim()
      };
    }
  }

  return { role: headline, company: '' };
}

// Check if user is logged into LinkedIn
async function checkLinkedInAuth() {
  try {
    const cookies = await getLinkedInCookies();
    return { loggedIn: true, hasJsessionid: !!cookies.jsessionid };
  } catch (e) {
    console.log('[SBL] Auth check failed:', e.message);
    return { loggedIn: false, hasJsessionid: false, reason: e.message };
  }
}

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[SBL] Got message:', message.type);

  if (message.type === 'SBL_SEARCH') {
    voyagerPeopleSearch(message.keywords, message.start || 0, message.count || 25)
      .then(leads => sendResponse({ ok: true, leads }))
      .catch(err => {
        console.error('[SBL] Search error:', err.message);
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }

  if (message.type === 'SBL_CHECK_AUTH') {
    checkLinkedInAuth()
      .then(status => sendResponse({ ok: true, ...status }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'SBL_PING') {
    sendResponse({ ok: true, version: '1.0.0' });
    return true;
  }

  return false;
});
