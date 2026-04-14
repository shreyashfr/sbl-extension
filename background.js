// Leads by SBL - Background Service Worker
// Handles LinkedIn API calls + Hiring signal pipeline

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// ══════════════════════════════════════════════════════════════════════════════
// LINKEDIN COOKIES
// ══════════════════════════════════════════════════════════════════════════════

async function getLinkedInCookies() {
  const allCookies = await chrome.cookies.getAll({ domain: '.linkedin.com' });
  const li_at = allCookies.find(c => c.name === 'li_at');
  const jsessionid = allCookies.find(c => c.name === 'JSESSIONID');
  const li_a = allCookies.find(c => c.name === 'li_a');

  console.log('[SBL] Cookie check — li_at:', !!li_at, 'JSESSIONID:', !!jsessionid, 'li_a:', !!li_a);

  if (!li_at?.value) throw new Error('NOT_LOGGED_IN');
  const csrf = jsessionid?.value?.replace(/"/g, '') || '';
  if (!csrf) throw new Error('NO_CSRF_TOKEN');

  return { li_at: li_at.value, li_a: li_a?.value || '', jsessionid: csrf };
}

async function checkLinkedInAuth() {
  try {
    const cookies = await getLinkedInCookies();
    return { loggedIn: true, hasJsessionid: !!cookies.jsessionid };
  } catch (e) {
    return { loggedIn: false, hasJsessionid: false, reason: e.message };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// VOYAGER PEOPLE SEARCH
// ══════════════════════════════════════════════════════════════════════════════

function voyagerHeaders(cookies) {
  return {
    'Cookie': `li_at=${cookies.li_at}; JSESSIONID="${cookies.jsessionid}"; li_a=${cookies.li_a}`,
    'csrf-token': cookies.jsessionid,
    'x-li-lang': 'en_US',
    'x-li-track': JSON.stringify({
      clientVersion: '1.13.8920', mpVersion: '1.13.8920', osName: 'web',
      timezoneOffset: -5.5, timezone: 'Asia/Kolkata', deviceFormFactor: 'DESKTOP',
      mpName: 'voyager-web', displayDensity: 1, displayWidth: 1920, displayHeight: 1080
    }),
    'x-restli-protocol-version': '2.0.0',
    'Accept': 'application/vnd.linkedin.normalized+json+2.1'
  };
}

async function voyagerPeopleSearch(keywords, start = 0, count = 25) {
  const cookies = await getLinkedInCookies();
  const encoded = encodeURIComponent(keywords);
  const url = `https://www.linkedin.com/voyager/api/graphql?includeWebMetadata=true&variables=(start:${start},origin:GLOBAL_SEARCH_HEADER,query:(keywords:${encoded},flagshipSearchIntent:SEARCH_SRP,queryParameters:List((key:resultType,value:List(PEOPLE))),includeFiltersInResponse:false))&queryId=voyagerSearchDashClusters.b0928897b71bd00a5a7291755dcd64f0`;

  const resp = await fetch(url, { headers: voyagerHeaders(cookies) });
  if (!resp.ok) {
    const status = resp.status;
    if (status === 401 || status === 403) throw new Error('AUTH_EXPIRED');
    throw new Error(`LinkedIn API returned ${status}`);
  }

  const data = await resp.json();
  return parseVoyagerResults(data, count);
}

function parseVoyagerResults(data, maxCount) {
  const leads = [];
  const included = data.included || [];

  for (const item of included) {
    if (!item.navigationUrl?.includes('/in/')) continue;
    const publicId = item.navigationUrl.match(/\/in\/([^/?]+)/)?.[1];
    if (!publicId) continue;
    const name = item.title?.text || '';
    if (!name) continue;

    const headline = item.primarySubtitle?.text || '';
    const location = item.secondarySubtitle?.text || '';
    const { role, company } = parseHeadline(headline);

    leads.push({
      name, title: role || headline, company: company || '',
      location, headline,
      profileUrl: `https://www.linkedin.com/in/${publicId}`, publicId
    });
    if (leads.length >= maxCount) break;
  }
  return leads;
}

function parseHeadline(headline) {
  if (!headline) return { role: '', company: '' };
  for (const sep of [' at ', ' @ ', ' | ']) {
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

// ══════════════════════════════════════════════════════════════════════════════
// HIRING SIGNAL SOURCES
// ══════════════════════════════════════════════════════════════════════════════

// --- LinkedIn Jobs Guest API (no auth needed) ---
async function fetchLinkedInJobsExt(role, location, count) {
  console.log('[SBL Hiring] LinkedIn Jobs:', role, location);
  const companies = [];
  const perPage = 25;
  const pages = Math.ceil(Math.min(count, 50) / perPage);

  for (let page = 0; page < pages && companies.length < count; page++) {
    try {
      const params = new URLSearchParams({
        keywords: role, location: location, f_TPR: 'r604800', start: String(page * perPage)
      });
      // Use redirect: 'follow' and explicitly avoid sending cookies
      const resp = await fetch(
        `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${params}`,
        { headers: { 'User-Agent': UA, 'Accept': 'text/html' }, credentials: 'omit', redirect: 'follow' }
      );
      console.log('[SBL Hiring] LinkedIn Jobs status:', resp.status, 'url:', resp.url);
      if (!resp.ok) break;
      const html = await resp.text();
      console.log('[SBL Hiring] LinkedIn Jobs HTML length:', html.length, 'first 200:', html.substring(0, 200));

      // Parse with regex (no cheerio in service worker)
      // Try multiple patterns - LinkedIn changes class names
      const cards = html.split(/<li\b/i).slice(1);
      console.log('[SBL Hiring] LinkedIn Jobs cards found:', cards.length);

      for (const card of cards) {
        if (companies.length >= count) break;

        // Multiple patterns for company name
        const companyMatch = card.match(/base-search-card__subtitle[^>]*>\s*([^<]+)/i)
          || card.match(/hidden-nested-link[^>]*>\s*([^<]+)/i)
          || card.match(/<h4[^>]*>\s*([^<]+)/i)
          || card.match(/data-tracking-control-name="[^"]*company[^"]*"[^>]*>\s*([^<]+)/i);

        // Multiple patterns for job title
        const titleMatch = card.match(/base-search-card__title[^>]*>\s*([^<]+)/i)
          || card.match(/sr-only[^>]*>\s*([^<]+)/i)
          || card.match(/<h3[^>]*>\s*([^<]+)/i);

        const urlMatch = card.match(/href="(https?:\/\/[^"]*linkedin\.com\/jobs\/view\/[^"?]+)/i)
          || card.match(/href="(\/jobs\/view\/[^"?]+)/i);

        const locMatch = card.match(/job-search-card__location[^>]*>\s*([^<]+)/i)
          || card.match(/base-search-card__metadata[^>]*>\s*([^<]+)/i);

        const companyLinkMatch = card.match(/href="(https?:\/\/[^"]*linkedin\.com\/company\/[^"?]+)/i);

        const companyName = companyMatch?.[1]?.trim();
        if (companyName && companyName.length > 1) {
          const jobUrl = urlMatch?.[1] || '';
          companies.push({
            name: companyName,
            jobTitle: titleMatch?.[1]?.trim() || role,
            roleHiringFor: titleMatch?.[1]?.trim() || role,
            jobPostUrl: jobUrl.startsWith('/') ? `https://www.linkedin.com${jobUrl}` : jobUrl,
            linkedinCompanyUrl: companyLinkMatch?.[1] || '',
            location: locMatch?.[1]?.trim() || location,
            source: 'LinkedIn Jobs',
            sourcePlatform: 'LinkedIn Jobs'
          });
        }
      }
      if (page < pages - 1) await sleep(500);
    } catch (e) {
      console.error('[SBL Hiring] LinkedIn Jobs error:', e.message);
      break;
    }
  }
  console.log('[SBL Hiring] LinkedIn Jobs found:', companies.length);
  return { companies, source: 'LinkedIn Jobs' };
}

// --- Dice (public HTML scraping) ---
async function fetchDiceExt(role, location, count) {
  console.log('[SBL Hiring] Dice:', role, location);
  const companies = [];
  try {
    const params = new URLSearchParams({ q: role, location: location, pageSize: String(Math.min(count, 20)) });
    const resp = await fetch(`https://www.dice.com/jobs?${params}`, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' }
    });
    if (!resp.ok) throw new Error(`Dice returned ${resp.status}`);
    const html = await resp.text();

    // Parse Next.js RSC data for job cards
    const scriptMatches = html.match(/self\.__next_f\.push\(\[1,"(.*?)"\]\)/gs) || [];
    for (const block of scriptMatches) {
      if (!block.includes('"companyName"') || !block.includes('"detailsPageUrl"')) continue;
      try {
        const jsonStr = block.match(/self\.__next_f\.push\(\[1,"(.*)"\]\)/s)?.[1];
        if (!jsonStr) continue;
        const unescaped = jsonStr.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\u0026/g, '&');
        const companyMatches = [...unescaped.matchAll(/"companyName"\s*:\s*"([^"]+)"/g)];
        const titleMatches = [...unescaped.matchAll(/"title"\s*:\s*"([^"]+)"/g)];
        const urlMatches = [...unescaped.matchAll(/"detailsPageUrl"\s*:\s*"([^"]+)"/g)];
        const locMatches = [...unescaped.matchAll(/"displayName"\s*:\s*"([^"]+)"/g)];

        for (let i = 0; i < companyMatches.length && companies.length < count; i++) {
          companies.push({
            name: companyMatches[i][1],
            jobTitle: titleMatches[i]?.[1] || role,
            roleHiringFor: titleMatches[i]?.[1] || role,
            jobPostUrl: urlMatches[i]?.[1] || '',
            location: locMatches[i]?.[1] || location,
            source: 'Dice', sourcePlatform: 'Dice'
          });
        }
      } catch {}
    }

    // Fallback: parse HTML for data-testid cards
    if (companies.length === 0) {
      const cardBlocks = html.split(/data-testid="job-card"/i).slice(1);
      for (const card of cardBlocks) {
        if (companies.length >= count) break;
        const companyMatch = card.match(/company-profile\/[^"]*"[^>]*><p[^>]*>([^<]+)/i);
        const titleMatch = card.match(/aria-label="([^"]+)"/i);
        const urlMatch = card.match(/href="(\/job-detail\/[^"]+)"/i);
        if (companyMatch?.[1]) {
          companies.push({
            name: companyMatch[1].trim(),
            jobTitle: titleMatch?.[1] || role,
            roleHiringFor: titleMatch?.[1] || role,
            jobPostUrl: urlMatch?.[1] ? `https://www.dice.com${urlMatch[1]}` : '',
            location: location, source: 'Dice', sourcePlatform: 'Dice'
          });
        }
      }
    }
  } catch (e) {
    console.error('[SBL Hiring] Dice error:', e.message);
  }

  // Dedupe by company name
  const seen = new Set();
  const unique = companies.filter(c => {
    const key = c.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  console.log('[SBL Hiring] Dice found:', unique.length);
  return { companies: unique, source: 'Dice' };
}

// --- YC Work at a Startup (WAAS + Algolia fallback) ---
const YC_ALGOLIA_APP_ID = '45BWZJ1SGC';
const YC_ALGOLIA_API_KEY = 'NzllNTY5MzJiZGM2OTY2ZTQwMDEzOTNhYWZiZGRjODlhYzVkNjBmOGRjNzJiMWM4ZTU0ZDlhYTZjOTJiMjlhMWFuYWx5dGljc1RhZ3M9eWNkYyZyZXN0cmljdEluZGljZXM9WUNDb21wYW55X3Byb2R1Y3Rpb24lMkNZQ0NvbXBhbnlfQnlfTGF1bmNoX0RhdGVfcHJvZHVjdGlvbiZ0YWdGaWx0ZXJzPSU1QiUyMnljZGNfcHVibGljJTIyJTVE';

async function fetchYCExt(role, location, count) {
  console.log('[SBL Hiring] YC:', role);
  const companies = [];

  // Try WAAS first
  try {
    const searchQuery = encodeURIComponent(role || '');
    const waasUrl = `https://www.workatastartup.com/companies?demographic=any&hasEquity=any&hasSalary=any&industry=any&interviewProcess=any&jobType=any&layout=list-compact&role=any&sortBy=created_desc&usVisaNotRequired=any&query=${searchQuery}`;
    const resp = await fetch(waasUrl, { headers: { 'User-Agent': UA } });
    if (resp.ok) {
      const html = await resp.text();
      const decoded = html.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
      const jobsMatch = decoded.match(/"jobs":\[(.*?)\],"signupUrl"/s);
      if (jobsMatch?.[1]) {
        try {
          const jobs = JSON.parse(`[${jobsMatch[1]}]`.replace(/\\u0026/g, '&'));
          const roleLower = (role || '').toLowerCase();
          const locationLower = (location || '').toLowerCase();

          const salesTerms = ['sales', 'sdr', 'bdr', 'account executive', 'account manager', 'business development', 'revenue', 'growth'];
          const isSalesRole = salesTerms.some(t => roleLower.includes(t));
          const roleTerms = isSalesRole ? [...salesTerms, roleLower] : [roleLower];

          const filtered = jobs.filter(job => {
            const title = (job.title || '').toLowerCase();
            const roleType = (job.roleType || '').toLowerCase();
            const titleMatch = !roleLower || roleTerms.some(t => title.includes(t) || roleType.includes(t));
            const locOk = !locationLower || (job.location || '').toLowerCase().includes(locationLower)
              || locationLower.includes('united states') || locationLower.includes('us');
            return titleMatch && locOk;
          }).slice(0, count * 2);

          const seenSlugs = new Set();
          for (const job of filtered) {
            if (companies.length >= count) break;
            if (!job.companySlug || seenSlugs.has(job.companySlug)) continue;
            seenSlugs.add(job.companySlug);
            companies.push({
              name: job.companyName || job.companySlug.replace(/-/g, ' '),
              jobTitle: job.title || role,
              roleHiringFor: job.title || role,
              jobPostUrl: `https://www.workatastartup.com/jobs/${job.id}`,
              companyPageUrl: `https://www.workatastartup.com/companies/${job.companySlug}`,
              location: job.location || '', source: 'YC', sourcePlatform: 'YC'
            });
          }
          console.log('[SBL Hiring] YC WAAS found:', companies.length);
        } catch (e) { console.log('[SBL Hiring] YC WAAS parse error:', e.message); }
      }
    }
  } catch (e) { console.log('[SBL Hiring] YC WAAS failed:', e.message); }

  // Algolia fallback
  if (companies.length === 0) {
    try {
      const resp = await fetch(
        `https://${YC_ALGOLIA_APP_ID.toLowerCase()}-dsn.algolia.net/1/indexes/YCCompany_production/query`,
        {
          method: 'POST',
          headers: {
            'x-algolia-application-id': YC_ALGOLIA_APP_ID,
            'x-algolia-api-key': YC_ALGOLIA_API_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ query: role, hitsPerPage: Math.min(count, 50), tagFilters: ['ycdc_public'] })
        }
      );
      if (resp.ok) {
        const data = await resp.json();
        for (const hit of (data.hits || []).slice(0, count)) {
          companies.push({
            name: hit.name || '',
            jobTitle: role, roleHiringFor: role,
            jobPostUrl: hit.slug ? `https://www.ycombinator.com/companies/${hit.slug}/jobs` : '',
            companyPageUrl: hit.slug ? `https://www.ycombinator.com/companies/${hit.slug}` : '',
            companyWebsite: hit.website && !/ycombinator|workatastartup|startupschool/i.test(hit.website) ? hit.website : '',
            location: hit.all_locations || '', source: 'YC', sourcePlatform: 'YC'
          });
        }
        console.log('[SBL Hiring] YC Algolia found:', companies.length);
      }
    } catch (e) { console.log('[SBL Hiring] YC Algolia failed:', e.message); }
  }

  return { companies, source: 'YC' };
}

// --- Wellfound via Google (no Serper key needed — use direct Google search) ---
async function fetchWellfoundExt(role, location, count) {
  console.log('[SBL Hiring] Wellfound:', role, location);
  const companies = [];
  try {
    // Use Google search directly from extension (no CORS in service worker)
    const q = encodeURIComponent(`site:wellfound.com ${role} jobs ${location}`);
    const resp = await fetch(`https://www.google.com/search?q=${q}&num=${Math.min(count, 20)}`, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html' }
    });
    if (!resp.ok) { console.log('[SBL Hiring] Google search returned', resp.status); return { companies: [], source: 'Wellfound' }; }
    const html = await resp.text();

    // Extract Wellfound URLs from Google results
    const urlMatches = [...html.matchAll(/href="(https?:\/\/wellfound\.com\/company\/[^"&]+)"/g)];
    const seenCompanies = new Set();

    for (const match of urlMatches) {
      if (companies.length >= count) break;
      const url = match[1];
      const companySlug = url.match(/wellfound\.com\/company\/([^\/]+)/)?.[1];
      if (!companySlug || seenCompanies.has(companySlug)) continue;
      seenCompanies.add(companySlug);

      const companyName = companySlug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      companies.push({
        name: companyName,
        jobTitle: role, roleHiringFor: role,
        jobPostUrl: url,
        companyPageUrl: url,
        source: 'Wellfound', sourcePlatform: 'Wellfound'
      });
    }
    console.log('[SBL Hiring] Wellfound found:', companies.length);
  } catch (e) { console.log('[SBL Hiring] Wellfound failed:', e.message); }
  return { companies, source: 'Wellfound' };
}

// ══════════════════════════════════════════════════════════════════════════════
// DECISION MAKER SEARCH (Voyager)
// ══════════════════════════════════════════════════════════════════════════════

async function findDecisionMakers(cookies, companies, role) {
  const leads = [];
  const maxCompanies = Math.min(companies.length, 15);

  for (let i = 0; i < maxCompanies; i++) {
    const c = companies[i];
    const companyName = c.name || '';
    if (!companyName) continue;

    try {
      // Search for people at this company with seniority keywords
      const query = `${companyName}`;
      const encoded = encodeURIComponent(query);
      const url = `https://www.linkedin.com/voyager/api/graphql?includeWebMetadata=true&variables=(start:0,origin:GLOBAL_SEARCH_HEADER,query:(keywords:${encoded},flagshipSearchIntent:SEARCH_SRP,queryParameters:List((key:resultType,value:List(PEOPLE)),(key:currentCompany,value:List(${encodeURIComponent(companyName)}))),includeFiltersInResponse:false))&queryId=voyagerSearchDashClusters.b0928897b71bd00a5a7291755dcd64f0`;

      const resp = await fetch(url, { headers: voyagerHeaders(cookies) });
      if (!resp.ok) {
        if (resp.status === 429) {
          console.log('[SBL Hiring] Rate limited, pausing...');
          await sleep(5000);
          continue;
        }
        continue;
      }

      const data = await resp.json();
      const people = parseVoyagerResults(data, 5);

      for (const person of people) {
        leads.push({
          name: person.name,
          designation: person.title,
          company: companyName,
          roleHiringFor: c.roleHiringFor || c.jobTitle || role,
          linkedinProfileUrl: person.profileUrl,
          publicIdentifier: person.publicId,
          location: person.location || c.location || '',
          sourcePlatform: c.sourcePlatform || c.source || 'Unknown',
          jobPostUrl: c.jobPostUrl || '',
          linkedinCompanyUrl: c.linkedinCompanyUrl || '',
          companyWebsite: c.companyWebsite || ''
        });
      }

      // Rate limit: delay between company lookups
      if (i < maxCompanies - 1) await sleep(1000);
    } catch (e) {
      console.log('[SBL Hiring] DM search failed for', companyName, e.message);
    }
  }

  console.log('[SBL Hiring] Decision makers found:', leads.length);
  return leads;
}

// ══════════════════════════════════════════════════════════════════════════════
// FULL HIRING PIPELINE
// ══════════════════════════════════════════════════════════════════════════════

async function runHiringScan(role, location, count, sendProgress) {
  const startTime = Date.now();
  const allCompanies = [];
  const sourceReport = {};

  // Step 1: Fetch from all sources in parallel
  sendProgress('step1_http', '10%', 'Fetching job boards...');

  const results = await Promise.allSettled([
    fetchLinkedInJobsExt(role, location, count),
    fetchDiceExt(role, location, count),
    fetchYCExt(role, location, count),
    fetchWellfoundExt(role, location, count)
  ]);

  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) {
      sourceReport[r.value.source] = { count: r.value.companies.length, status: 'ok' };
      allCompanies.push(...r.value.companies);
    } else if (r.status === 'rejected') {
      console.log('[SBL Hiring] Source failed:', r.reason);
    }
  }

  sendProgress('dedup', '40%', `Deduplicating ${allCompanies.length} companies...`);

  // Dedupe companies
  const seen = new Set();
  const uniqueCompanies = allCompanies.filter(c => {
    const key = (c.name || '').toLowerCase().trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log('[SBL Hiring] Companies:', allCompanies.length, '→', uniqueCompanies.length, 'unique');

  // Step 2: Find decision makers via Voyager
  sendProgress('step2_voyager', '50%', `Finding decision makers at ${uniqueCompanies.length} companies...`);

  let allLeads = [];
  try {
    const cookies = await getLinkedInCookies();
    allLeads = await findDecisionMakers(cookies, uniqueCompanies, role);
  } catch (e) {
    console.log('[SBL Hiring] Decision maker search failed:', e.message);
    sourceReport['Voyager'] = { count: 0, status: 'failed', error: e.message };
  }

  // If no leads from Voyager, create placeholder leads from company data
  if (allLeads.length === 0) {
    for (const c of uniqueCompanies.slice(0, count)) {
      allLeads.push({
        name: 'Decision Maker',
        designation: 'Unknown',
        company: c.name,
        roleHiringFor: c.roleHiringFor || role,
        linkedinProfileUrl: '',
        jobPostUrl: c.jobPostUrl || '',
        sourcePlatform: c.sourcePlatform || c.source || 'Unknown',
        location: c.location || '',
        linkedinCompanyUrl: c.linkedinCompanyUrl || '',
        companyWebsite: c.companyWebsite || ''
      });
    }
  }

  sourceReport['Voyager'] = sourceReport['Voyager'] || { count: allLeads.length, status: 'ok' };

  // Step 3: Dedupe leads and score
  sendProgress('scoring', '85%', 'Scoring and ranking...');

  const seenLeads = new Set();
  const dedupedLeads = allLeads.filter(l => {
    const key = `${(l.name || '').toLowerCase().replace(/[^a-z]/g, '')}__${(l.company || '').toLowerCase().replace(/[^a-z]/g, '')}`;
    if (seenLeads.has(key)) return false;
    seenLeads.add(key);
    return true;
  });

  // Simple scoring: prioritize leads with LinkedIn profiles and matching titles
  const roleLower = (role || '').toLowerCase();
  const scored = dedupedLeads.map(lead => {
    let score = 50;
    if (lead.linkedinProfileUrl) score += 20;
    if (lead.designation && lead.designation !== 'Unknown') score += 10;
    const title = (lead.designation || '').toLowerCase();
    // Seniority bonus
    if (/\b(ceo|cto|cfo|coo|founder|co-founder|president|owner)\b/i.test(title)) score += 30;
    else if (/\b(vp|vice president|director|head of)\b/i.test(title)) score += 25;
    else if (/\b(manager|lead|senior)\b/i.test(title)) score += 15;
    // Role relevance
    if (roleLower && title.includes(roleLower)) score += 10;
    return { ...lead, combinedScore: Math.min(score, 100) };
  });

  scored.sort((a, b) => b.combinedScore - a.combinedScore);

  const duration = Math.round((Date.now() - startTime) / 1000);

  // Format final leads
  const finalLeads = scored.map((lead, i) => ({
    leadNo: String(i + 1).padStart(3, '0'),
    name: lead.name || 'Unknown',
    designation: lead.designation || 'Unknown',
    company: lead.company || 'Unknown',
    roleHiringFor: lead.roleHiringFor || role,
    sourcePlatform: lead.sourcePlatform || 'Unknown',
    jobPostUrl: lead.jobPostUrl || '',
    linkedinProfileUrl: lead.linkedinProfileUrl || '',
    publicIdentifier: lead.publicIdentifier || '',
    linkedinCompanyUrl: lead.linkedinCompanyUrl || '',
    companyWebsite: lead.companyWebsite || '',
    location: lead.location || '',
    combinedScore: lead.combinedScore,
    status: i < count ? 'delivered' : 'reserve'
  }));

  sendProgress('done', '100%', 'Complete!');

  return {
    status: 'complete',
    role, location,
    requestedLeads: count,
    totalLeadsScored: finalLeads.length,
    totalLeadsDelivered: Math.min(finalLeads.length, count),
    scanDurationSeconds: duration,
    sourceReport,
    leads: finalLeads.filter(l => l.status === 'delivered'),
    allLeads: finalLeads
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// UTILITY
// ══════════════════════════════════════════════════════════════════════════════

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ══════════════════════════════════════════════════════════════════════════════
// MESSAGE HANDLER
// ══════════════════════════════════════════════════════════════════════════════

// Store progress for active scans so content script can poll
const activeScanProgress = {};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[SBL] Got message:', message.type);

  if (message.type === 'SBL_SEARCH') {
    voyagerPeopleSearch(message.keywords, message.start || 0, message.count || 25)
      .then(leads => sendResponse({ ok: true, leads }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'SBL_CHECK_AUTH') {
    checkLinkedInAuth()
      .then(status => sendResponse({ ok: true, ...status }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'SBL_HIRING_SCAN') {
    const scanId = 'ext_' + Date.now();
    activeScanProgress[scanId] = { phase: 'initializing', progress: '0%', phaseLabel: 'Starting...' };

    const sendProgress = (phase, progress, label) => {
      activeScanProgress[scanId] = { phase, progress, phaseLabel: label };
      // Broadcast progress to content script
      if (sender.tab?.id) {
        chrome.tabs.sendMessage(sender.tab.id, {
          type: 'SBL_HIRING_PROGRESS',
          scanId, phase, progress, phaseLabel: label
        }).catch(() => {});
      }
    };

    runHiringScan(message.role, message.location, message.count || 10, sendProgress)
      .then(result => {
        delete activeScanProgress[scanId];
        sendResponse({ ok: true, scanId, ...result });
      })
      .catch(err => {
        delete activeScanProgress[scanId];
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }

  if (message.type === 'SBL_HIRING_PROGRESS_POLL') {
    const progress = activeScanProgress[message.scanId];
    sendResponse({ ok: true, ...(progress || { phase: 'unknown', progress: '0%' }) });
    return true;
  }

  if (message.type === 'SBL_PING') {
    sendResponse({ ok: true, version: '1.1.0' });
    return true;
  }

  return false;
});
