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

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function readDb() {
  try {
    if (!fs.existsSync(DB_PATH)) return { searches: {} };
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (_) {
    return { searches: {} };
  }
}

function writeDb(db) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

async function placeDetails(placeId) {
  const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`;
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
  return res.data;
}

async function searchPlaces(niche, location, maxLeads) {
  const results = [];
  const seen = new Set();
  let pageToken = null;
  let loops = 0;

  while (results.length < maxLeads && loops < 4) {
    loops += 1;
    const body = pageToken
      ? { pageToken }
      : { textQuery: `${niche} in ${location}`, pageSize: Math.min(20, maxLeads - results.length) };

    const res = await axios.post('https://places.googleapis.com/v1/places:searchText', body, {
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': API_KEY,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,nextPageToken'
      },
      timeout: 20000
    });

    const places = res.data.places || [];
    for (const p of places) {
      if (!p.id || seen.has(p.id) || results.length >= maxLeads) continue;
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
    await new Promise(r => setTimeout(r, 2000));
  }
  return results;
}

app.post('/api/search', async (req, res) => {
  try {
    if (!API_KEY) return res.status(500).json({ error: 'Missing GOOGLE_PLACES_API_KEY environment variable on Render.' });
    const niche = cleanText(req.body.niche);
    const location = cleanText(req.body.location);
    const maxLeads = Math.max(1, Math.min(Number(req.body.maxLeads || 50), 200));
    if (!niche || !location) return res.status(400).json({ error: 'Niche and location are required.' });

    const leads = await searchPlaces(niche, location, maxLeads);
    const searchId = uuidv4();
    const db = readDb();
    db.searches[searchId] = { searchId, niche, location, createdAt: new Date().toISOString(), leads };
    writeDb(db);
    res.json({ searchId, count: leads.length, leads });
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message || 'Search failed.';
    res.status(500).json({ error: msg });
  }
});

app.get('/api/search/:searchId', (req, res) => {
  const db = readDb();
  const search = db.searches[req.params.searchId];
  if (!search) return res.status(404).json({ error: 'Search not found.' });
  res.json(search);
});

app.patch('/api/search/:searchId/lead/:leadId', (req, res) => {
  const db = readDb();
  const search = db.searches[req.params.searchId];
  if (!search) return res.status(404).json({ error: 'Search not found.' });
  const lead = search.leads.find(l => l.id === req.params.leadId);
  if (!lead) return res.status(404).json({ error: 'Lead not found.' });
  ['called', 'status', 'notes', 'ownerName', 'ownerPhone', 'email', 'followUpDate'].forEach(k => {
    if (req.body[k] !== undefined) lead[k] = req.body[k];
  });
  writeDb(db);
  res.json({ ok: true, lead });
});

app.get('/api/search/:searchId/export', async (req, res) => {
  const db = readDb();
  const search = db.searches[req.params.searchId];
  if (!search) return res.status(404).send('Search not found.');

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
  sheet.eachRow(row => row.alignment = { vertical: 'top', wrapText: true });

  const safe = `${search.niche}_${search.location}`.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="voxa_leads_${safe}.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
});

app.listen(PORT, () => console.log(`Voxa Lead Finder running on port ${PORT}`));
