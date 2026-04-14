// Leads by SBL - Background Service Worker
// Handles LinkedIn API calls using the user's authenticated session

// Get LinkedIn cookies from the browser
async function getLinkedInCookies() {
  const li_at = await chrome.cookies.get({ url: 'https://www.linkedin.com', name: 'li_at' });
  const jsessionid = await chrome.cookies.get({ url: 'https://www.linkedin.com', name: 'JSESSIONID' });
  const li_a = await chrome.cookies.get({ url: 'https://www.linkedin.com', name: 'li_a' });

  if (!li_at?.value) {
    throw new Error('NOT_LOGGED_IN');
  }

  // JSESSIONID sometimes has quotes around it
  const csrf = jsessionid?.value?.replace(/"/g, '') || '';

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
    'Cookie': `li_at=${cookies.li_at}; JSESSIONID="${cookies.jsessionid}"`,
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
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/vnd.linkedin.normalized+json+2.1'
  };

  const resp = await fetch(url, { headers });

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

  return leads;
}

// Parse LinkedIn headline into role and company
function parseHeadline(headline) {
  if (!headline) return { role: '', company: '' };

  // Common patterns: "Role at Company", "Role @ Company", "Role | Company"
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
    return { loggedIn: false, hasJsessionid: false };
  }
}

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SBL_SEARCH') {
    voyagerPeopleSearch(message.keywords, message.start || 0, message.count || 25)
      .then(leads => sendResponse({ ok: true, leads }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true; // Keep channel open for async response
  }

  if (message.type === 'SBL_CHECK_AUTH') {
    checkLinkedInAuth()
      .then(status => sendResponse({ ok: true, ...status }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'SBL_PING') {
    sendResponse({ ok: true, version: '1.0.0' });
    return false;
  }
});
