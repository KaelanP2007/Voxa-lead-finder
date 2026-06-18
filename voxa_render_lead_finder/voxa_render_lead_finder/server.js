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
  Number(process.env.MONTHLY_GOOGLE_REQUEST_BUDGET || 10000)
);

const MAX_LEADS_PER_SEARCH = Math.max(
  1,
  Number(process.env.MAX_LEADS_PER_SEARCH || 100)
);

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function currentMonthKey() {
  return new Date().toISOString().slice(0, 7);
}

function emptyDb() {
  return {
    searches: {},
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
    'googleMapsUri'
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

async function searchPlaces(niche, location, maxLeads) {
  const results = [];
  const seen = new Set();

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
    loops < Math.ceil(safeMaxLeads / 20) + 2
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

    const places = res.data.places || [];

    for (const p of places) {
      if (!p.id || seen.has(p.id) || results.length >= safeMaxLeads) continue;

      seen.add(p.id);

      let d = p;

      try {
        d = await placeDetails(p.id);
      } catch (err) {
        d = p;
      }

      results.push({
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
        followUpDate: ''
      });
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

    if (!niche || !location) {
      return res.status(400).json({
        error: 'Niche and location are required.'
      });
    }

    const leads = await searchPlaces(niche, location, maxLeads);

    const searchId = uuidv4();
    const db = readDb();

    db.searches[searchId] = {
      searchId,
      niche,
      location,
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

app.get('/api/search/:searchId', (req, res) => {
  const db = readDb();
  const search = db.searches[req.params.searchId];

  if (!search) {
    return res.status(404).json({ error: 'Search not found.' });
  }

  res.json(search);
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

app.get('/api/search/:searchId/export', async (req, res) => {
  const db = readDb();
  const search = db.searches[req.params.searchId];

  if (!search) {
    return res.status(404).send('Search not found.');
  }

  const workbook = new ExcelJS.Workbook();

  const sheet = workbook.addWorksheet('All Leads');

  sheet.columns = [
    { header: 'Business Name', key: 'businessName', width: 32 },
    { header: 'Phone', key: 'phone', width: 18 },
    { header: 'Website', key: 'website', width: 34 },
    { header: 'Address', key: 'address', width: 42 },
    { header: 'Rating', key: 'rating', width: 10 },
    { header: 'Review Count', key: 'reviewCount', width: 14 },
    { header: 'Google Maps', key: 'googleMaps', width: 34 },
    { header: 'Called?', key: 'called', width: 12 },
    { header: 'Status', key: 'status', width: 18 },
    { header: 'Owner Name', key: 'ownerName', width: 22 },
    { header: 'Owner Phone', key: 'ownerPhone', width: 18 },
    { header: 'Email', key: 'email', width: 28 },
    { header: 'Follow Up Date', key: 'followUpDate', width: 16 },
    { header: 'Notes', key: 'notes', width: 40 }
  ];

  sheet.addRows(search.leads);

  sheet.getRow(1).font = { bold: true };
  sheet.autoFilter = 'A1:N1';
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  sheet.eachRow(row => {
    row.alignment = {
      vertical: 'top',
      wrapText: true
    };
  });

  const safe = `${search.niche}_${search.location}`
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
});

app.listen(PORT, () => {
  console.log(`Voxa Lead Finder running on port ${PORT}`);
});
