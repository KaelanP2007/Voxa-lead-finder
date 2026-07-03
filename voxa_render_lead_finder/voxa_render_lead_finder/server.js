const express = require('express');
const axios = require('axios');
const ExcelJS = require('exceljs');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GOOGLE_PLACES_API_KEY;

const DB_PATH = path.join(__dirname, 'data', 'leads.json');

const MONTHLY_GOOGLE_REQUEST_BUDGET = Math.max(
  1,
  Number(process.env.MONTHLY_GOOGLE_REQUEST_BUDGET || 1000)
);

const MAX_LEADS_PER_SEARCH = Math.max(
  1,
  Number(process.env.MAX_LEADS_PER_SEARCH || 100)
);

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function currentMonthKey() {
  return new Date().toISOString().slice(0, 7);
}

function emptyDb() {
  return {
    searches: {},
    seenBusinesses: {},
    usage: {
      month: currentMonthKey(),
      textSearchRequests: 0,
      placeDetailsRequests: 0,
      totalGoogleRequests: 0
    }
  };
}

function readDb() {
  try {
    if (!fs.existsSync(DB_PATH)) return emptyDb();

    const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));

    if (!db.searches) db.searches = {};
    if (!db.seenBusinesses) db.seenBusinesses = {};
    if (!db.usage) db.usage = emptyDb().usage;

    if (db.usage.month !== currentMonthKey()) {
      db.usage = emptyDb().usage;
    }

    return db;
  } catch (err) {
    return emptyDb();
  }
}

function writeDb(db) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function addUsage(textSearchRequests = 0, placeDetailsRequests = 0) {
  const db = readDb();

  db.usage.textSearchRequests += textSearchRequests;
  db.usage.placeDetailsRequests += placeDetailsRequests;
  db.usage.totalGoogleRequests =
    db.usage.textSearchRequests + db.usage.placeDetailsRequests;

  writeDb(db);

  return db.usage;
}

function usageSummary() {
  const db = readDb();
  const usage = db.usage;
  const used = usage.totalGoogleRequests || 0;

  return {
    month: usage.month,
    textSearchRequests: usage.textSearchRequests || 0,
    placeDetailsRequests: usage.placeDetailsRequests || 0,
    totalGoogleRequests: used,
    monthlyBudget: MONTHLY_GOOGLE_REQUEST_BUDGET,
    estimatedRemaining: Math.max(0, MONTHLY_GOOGLE_REQUEST_BUDGET - used),
    percentUsed: Math.min(
      100,
      Math.round((used / MONTHLY_GOOGLE_REQUEST_BUDGET) * 100)
    ),
    note:
      'Local estimate only. Google billing/free usage is based on official Google Maps SKUs in Google Cloud.'
  };
}

function cleanText(value) {
  return typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ')
    : '';
}

function normalizeInput(value) {
  return cleanText(value);
}

function makeFallbackBusinessKey(lead) {
  const name = cleanText(lead.businessName || '').toLowerCase();
  const address = cleanText(lead.address || '').toLowerCase();

  return `${name}|${address}`
    .replace(/[^a-z0-9|]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function markBusinessAsSeen(db, lead) {
  if (lead.id) {
    db.seenBusinesses[`place:${lead.id}`] = {
      businessName: lead.businessName || '',
      address: lead.address || '',
      firstSeenAt: new Date().toISOString()
    };
  }

  const fallbackKey = makeFallbackBusinessKey(lead);

  if (fallbackKey && fallbackKey !== '|') {
    db.seenBusinesses[`fallback:${fallbackKey}`] = {
      businessName: lead.businessName || '',
      address: lead.address || '',
      firstSeenAt: new Date().toISOString()
    };
  }
}

function hasBusinessBeenSeen(db, place) {
  if (place.id && db.seenBusinesses[`place:${place.id}`]) {
    return true;
  }

  const fallbackLead = {
    businessName: place.displayName?.text || '',
    address: place.formattedAddress || ''
  };

  const fallbackKey = makeFallbackBusinessKey(fallbackLead);

  if (fallbackKey && db.seenBusinesses[`fallback:${fallbackKey}`]) {
    return true;
  }

  return false;
}

function isWeakWebsite(website) {
  const url = cleanText(website).toLowerCase();

  if (!url) return false;

  const weakDomains = [
    'facebook.com',
    'instagram.com',
    'wixsite.com',
    'wix.com',
    'weebly.com',
    'squarespace.com',
    'godaddysites.com',
    'business.site',
    'sites.google.com',
    'linktr.ee',
    'yelp.com',
    'yellowpages',
    'canpages',
    'homestars.com'
  ];

  return weakDomains.some(domain => url.includes(domain));
}

function hasRealWebsite(website) {
  const url = cleanText(website).toLowerCase();

  if (!url) return false;
  if (isWeakWebsite(url)) return false;

  return true;
}

function isTollFreePhone(phone) {
  const digits = cleanText(phone).replace(/\D/g, '');

  if (!digits) return false;

  const normalized = digits.length === 11 && digits.startsWith('1')
    ? digits.slice(1)
    : digits;

  const tollFreePrefixes = ['800', '888', '877', '866', '855', '844', '833', '822'];

  return tollFreePrefixes.some(prefix => normalized.startsWith(prefix));
}

function ownerNameBusinessSignal(name) {
  const businessName = cleanText(name).toLowerCase();

  if (!businessName) return false;

  const personalPatterns = [
    /\b[a-z]+['’]s\b/,
    /\bguy\b/,
    /\bdude\b/,
    /\bhandyman\b/,
    /\bdrain guy\b/,
    /\blawn guy\b/,
    /\bplumbing guy\b/,
    /\bdave\b/,
    /\bmike\b/,
    /\bmark\b/,
    /\bsteve\b/,
    /\bpaul\b/,
    /\bjohn\b/,
    /\bjoe\b/,
    /\bchris\b/,
    /\btony\b/,
    /\bkevin\b/,
    /\brob\b/,
    /\bbob\b/,
    /\btom\b/,
    /\bsam\b/
  ];

  return personalPatterns.some(pattern => pattern.test(businessName));
}

function corporateNameSignal(name) {
  const businessName = cleanText(name).toLowerCase();

  if (!businessName) return false;

  const corporateWords = [
    'group',
    'holdings',
    'corporation',
    'corp',
    'inc',
    'limited',
    'ltd',
    'franchise',
    'national',
    'canada',
    'solutions',
    'enterprises',
    'management',
    'systems',
    'partners',
    'associates'
  ];

  return corporateWords.some(word => businessName.includes(word));
}

function openingHoursMissingOrWeak(place) {
  const hours = place.regularOpeningHours;

  if (!hours) return true;

  const weekdayDescriptions = hours.weekdayDescriptions || [];
  const periods = hours.periods || [];

  if (weekdayDescriptions.length === 0 && periods.length === 0) {
    return true;
  }

  if (periods.length > 0 && periods.length < 5) {
    return true;
  }

  return false;
}

function calculateSmallBusinessFit(lead, rawPlace) {
  let score = 0;
  const reasons = [];

  const reviewCount = Number(lead.reviewCount || 0);

  if (reviewCount > 0 && reviewCount <= 40) {
    score += 25;
    reasons.push(`Low review count (${reviewCount})`);
  } else if (reviewCount > 40 && reviewCount <= 80) {
    score += 10;
    reasons.push(`Moderate review count (${reviewCount})`);
  } else if (reviewCount >= 150) {
    score -= 15;
    reasons.push(`High review count (${reviewCount})`);
  } else if (reviewCount === 0) {
    score += 15;
    reasons.push('No review count showing');
  }

  if (!lead.website) {
    score += 20;
    reasons.push('No website listed');
  } else if (isWeakWebsite(lead.website)) {
    score += 15;
    reasons.push('Weak/simple website source');
  } else {
    reasons.push('Has proper website');
  }

  if (ownerNameBusinessSignal(lead.businessName)) {
    score += 15;
    reasons.push('Owner-name style business');
  }

  if (!isTollFreePhone(lead.phone)) {
    score += 10;
    reasons.push('Local/non-toll-free phone');
  } else {
    score -= 10;
    reasons.push('Toll-free/corporate-looking phone');
  }

  if (openingHoursMissingOrWeak(rawPlace)) {
    score += 10;
    reasons.push('Hours missing or limited');
  } else {
    reasons.push('Hours configured');
  }

  if (corporateNameSignal(lead.businessName)) {
    score -= 10;
    reasons.push('Corporate/branded name signal');
  }

  score = Math.max(0, Math.min(100, score));

  return {
    score,
    reasons
  };
}

function passesSmallBusinessFilters(lead, filters) {
  const score = Number(lead.smallBusinessScore || 0);
  const reviewCount = Number(lead.reviewCount || 0);

  if (filters.smallBusinessOnly && score < filters.minSmallBusinessScore) {
    return false;
  }

  if (filters.hideHighReviewCompanies && reviewCount >= filters.maxReviewCount) {
    return false;
  }

  if (filters.hideProperWebsites && hasRealWebsite(lead.website)) {
    return false;
  }

  return true;
}

async function placeDetails(placeId) {
  const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(
    placeId
  )}`;

  const fieldMask = [
    'id',
    'displayName',
    'formattedAddress',
    'nationalPhoneNumber',
    'internationalPhoneNumber',
    'websiteUri',
    'rating',
    'userRatingCount',
    'businessStatus',
    'googleMapsUri',
    'regularOpeningHours'
  ].join(',');

  const res = await axios.get(url, {
    headers: {
      'X-Goog-Api-Key': API_KEY,
      'X-Goog-FieldMask': fieldMask
    },
    timeout: 15000
  });

  addUsage(0, 1);

  return res.data;
}

async function searchPlaces(niche, location, maxLeads, filters) {
  const results = [];
  const localSeenThisSearch = new Set();

  let pageToken = null;
  let loops = 0;

  const safeMaxLeads = Math.max(
    1,
    Math.min(Number(maxLeads || 20), MAX_LEADS_PER_SEARCH)
  );

  const cleanNiche = normalizeInput(niche);
  const cleanLocation = normalizeInput(location);

  const textQuery = `${cleanNiche} in ${cleanLocation}`;
  const pageSize = Math.min(20, safeMaxLeads);

  while (
    results.length < safeMaxLeads &&
    loops < Math.ceil(safeMaxLeads / 20) + 8
  ) {
    loops += 1;

    const body = {
      textQuery,
      pageSize
    };

    if (pageToken) {
      body.pageToken = pageToken;
    }

    const res = await axios.post(
      'https://places.googleapis.com/v1/places:searchText',
      body,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': API_KEY,
          'X-Goog-FieldMask':
            'places.id,places.displayName,places.formattedAddress,nextPageToken'
        },
        timeout: 20000
      }
    );

    addUsage(1, 0);

    const db = readDb();
    const places = res.data.places || [];

    for (const p of places) {
      if (!p.id || localSeenThisSearch.has(p.id)) continue;
      if (results.length >= safeMaxLeads) break;

      localSeenThisSearch.add(p.id);

      if (hasBusinessBeenSeen(db, p)) {
        continue;
      }

      let d = p;

      try {
        d = await placeDetails(p.id);
      } catch (err) {
        d = p;
      }

      const lead = {
        id: p.id,
        businessName: cleanText(d.displayName?.text || p.displayName?.text),
        phone: cleanText(d.nationalPhoneNumber || d.internationalPhoneNumber),
        website: cleanText(d.websiteUri),
        address: cleanText(d.formattedAddress || p.formattedAddress),
        rating: d.rating || '',
        reviewCount: d.userRatingCount || '',
        googleMaps: cleanText(d.googleMapsUri),
        status: 'New',
        called: 'No',
        notes: '',
        ownerName: '',
        ownerPhone: '',
        email: '',
        followUpDate: '',
        smallBusinessScore: 0,
        smallBusinessReasons: ''
      };

      const fit = calculateSmallBusinessFit(lead, d);

      lead.smallBusinessScore = fit.score;
      lead.smallBusinessReasons = fit.reasons.join(', ');

      if (!passesSmallBusinessFilters(lead, filters)) {
        continue;
      }

      results.push(lead);
      markBusinessAsSeen(db, lead);
      writeDb(db);
    }

    pageToken = res.data.nextPageToken;

    if (!pageToken) break;

    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  return results;
}

app.get('/api/usage', (req, res) => {
  res.json(usageSummary());
});

app.post('/api/search', async (req, res) => {
  try {
    if (!API_KEY) {
      return res.status(500).json({
        error: 'Missing GOOGLE_PLACES_API_KEY environment variable on Render.'
      });
    }

    const niche = normalizeInput(req.body.niche);
    const location = normalizeInput(req.body.location);

    const maxLeads = Math.max(
      1,
      Math.min(Number(req.body.maxLeads || 20), MAX_LEADS_PER_SEARCH)
    );

    const filters = {
      smallBusinessOnly: Boolean(req.body.smallBusinessOnly),
      minSmallBusinessScore: Math.max(
        0,
        Math.min(100, Number(req.body.minSmallBusinessScore || 60))
      ),
      hideHighReviewCompanies: Boolean(req.body.hideHighReviewCompanies),
      maxReviewCount: Math.max(1, Number(req.body.maxReviewCount || 100)),
      hideProperWebsites: Boolean(req.body.hideProperWebsites)
    };

    if (!niche || !location) {
      return res.status(400).json({
        error: 'Niche and location are required.'
      });
    }

    const leads = await searchPlaces(niche, location, maxLeads, filters);

    const searchId = uuidv4();
    const db = readDb();

    db.searches[searchId] = {
      searchId,
      niche,
      location,
      filters,
      createdAt: new Date().toISOString(),
      leads
    };

    writeDb(db);

    res.json({
      searchId,
      count: leads.length,
      leads,
      usage: usageSummary()
    });
  } catch (err) {
    const msg =
      err.response?.data?.error?.message ||
      err.message ||
      'Search failed.';

    res.status(500).json({
      error: msg,
      usage: usageSummary()
    });
  }
});

app.patch('/api/search/:searchId/lead/:leadId', (req, res) => {
  const db = readDb();
  const search = db.searches[req.params.searchId];

  if (!search) {
    return res.status(404).json({ error: 'Search not found.' });
  }

  const lead = search.leads.find(l => l.id === req.params.leadId);

  if (!lead) {
    return res.status(404).json({ error: 'Lead not found.' });
  }

  [
    'called',
    'status',
    'notes',
    'ownerName',
    'ownerPhone',
    'email',
    'followUpDate'
  ].forEach(key => {
    if (req.body[key] !== undefined) {
      lead[key] = req.body[key];
    }
  });

  writeDb(db);

  res.json({
    ok: true,
    lead
  });
});

async function writeLeadsWorkbook(res, leads, filenameBase) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('All Leads');

  sheet.columns = [
    { header: 'Business Name', key: 'businessName', width: 32 },
    { header: 'Phone', key: 'phone', width: 18 },
    { header: 'Website', key: 'website', width: 34 },
    { header: 'Address', key: 'address', width: 42 },
    { header: 'Rating', key: 'rating', width: 10 },
    { header: 'Review Count', key: 'reviewCount', width: 14 },
    { header: 'Small Biz Score', key: 'smallBusinessScore', width: 16 },
    { header: 'Small Biz Reasons', key: 'smallBusinessReasons', width: 48 },
    { header: 'Google Maps', key: 'googleMaps', width: 34 },
    { header: 'Called?', key: 'called', width: 12 },
    { header: 'Status', key: 'status', width: 18 },
    { header: 'Owner Name', key: 'ownerName', width: 22 },
    { header: 'Owner Phone', key: 'ownerPhone', width: 18 },
    { header: 'Email', key: 'email', width: 28 },
    { header: 'Follow Up Date', key: 'followUpDate', width: 16 },
    { header: 'Notes', key: 'notes', width: 40 }
  ];

  sheet.addRows(leads);

  sheet.getRow(1).font = { bold: true };
  sheet.autoFilter = 'A1:P1';
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  sheet.eachRow(row => {
    row.alignment = {
      vertical: 'top',
      wrapText: true
    };
  });

  const safe = filenameBase
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();

  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );

  res.setHeader(
    'Content-Disposition',
    `attachment; filename="voxa_leads_${safe}.xlsx"`
  );

  await workbook.xlsx.write(res);
  res.end();
}

app.post('/api/export', async (req, res) => {
  try {
    const { niche = 'leads', location = 'area', leads = [] } = req.body || {};

    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).send('No leads to export.');
    }

    await writeLeadsWorkbook(res, leads, `${niche}_${location}`);
  } catch (err) {
    res.status(500).send(err.message || 'Export failed.');
  }
});

app.listen(PORT, () => {
  console.log(`Voxa Lead Finder running on port ${PORT}`);
});
