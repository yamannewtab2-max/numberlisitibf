// POST /api/sweep  { q, area, lat?, lng?, max?, skip?[] }
//
// One tap = the AI decides WHERE to look, Google looks there, and what was covered is written
// back to Firestore so the same ground is never swept twice.
//
//   1. read the scan memory (Firestore scans/main -> { ids, near, done })
//   2. work out the centre: the given lat/lng, or the named area
//   3. Gemini lists a few nearby kecamatan/desa that are NOT in `done` yet
//   4. each one is searched through /api/discover (which drops places with a website, places
//      without a mobile number, and places already in `ids`)
//   5. the new place ids + the areas just covered are merged into the scan memory and saved
//   6. the app gets the numbers plus which locations were searched
//
// Google calls are metered: AREAS_PER_RUN areas x CALLS_PER_AREA calls, hard-capped below. The
// Places API has a daily cap, so a sweep run is deliberately small - "More" does the next run.

const discover = require('./discover.js');

const MODEL = 'gemini-3.1-flash-lite';
const GEMINI = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const AREAS_PER_RUN = 2;          // locations the AI picks per run
const CALLS_PER_AREA = 5;         // Google requests per location (one per keyword variant)
const SWEEP_CALLS = AREAS_PER_RUN * CALLS_PER_AREA;   // hard cap for the whole run
const AREA_RADIUS = 8000;
const MAX_ITEMS = 200;
const MAX_DONE = 200;              // areas kept in the memory before the oldest are dropped

const PROJECT = process.env.FIREBASE_PROJECT_ID || '';
const FB_KEY = process.env.FIREBASE_API_KEY || '';
const FS = 'https://firestore.googleapis.com/v1/projects/';
const MEMBER = 'scans/main';

function digits(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }

function fsUrl(project, key) {
  return FS + project + '/databases/(default)/documents/' + MEMBER + '?key=' + encodeURIComponent(key);
}

// The scan memory lives in one Firestore doc as JSON: { ids:{placeId:1}, near:{area:ts}, done:{area:ts} }
async function readMemory(project, key) {
  if (!project || !key) return { ids: {}, near: {}, done: {} };
  try {
    const r = await fetch(fsUrl(project, key));
    const j = await r.json().catch(() => ({}));
    const f = ((j.fields || {}).blob || {}).stringValue;
    const m = f ? JSON.parse(f) : {};
    return { ids: m.ids || {}, near: m.near || {}, done: m.done || {} };
  } catch (e) { return { ids: {}, near: {}, done: {} }; }
}

async function writeMemory(project, key, mem) {
  if (!project || !key) return false;
  const ids = Object.keys(mem.ids);
  if (ids.length > 12000) {                       // keep the document well under Firestore's limit
    const trimmed = {};
    ids.slice(ids.length - 12000).forEach((id) => { trimmed[id] = 1; });
    mem.ids = trimmed;
  }
  const doneKeys = Object.keys(mem.done);
  if (doneKeys.length > MAX_DONE) {
    const keep = {};
    doneKeys.slice(doneKeys.length - MAX_DONE).forEach((k) => { keep[k] = mem.done[k]; });
    mem.done = keep;
  }
  const blob = JSON.stringify(mem);
  try {
    const r = await fetch(fsUrl(project, key) + '&updateMask.fieldPaths=id&updateMask.fieldPaths=blob', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fields: { id: { stringValue: 'main' }, blob: { stringValue: blob } } })
    });
    return r.ok;
  } catch (e) { return false; }
}

// Ask the AI which places to look at next, given what has already been covered.
async function pickAreas(q, center, done, key) {
  const known = Object.keys(done);
  if (!key) return [];
  const prompt = `Kamu memilih lokasi pencarian usaha di Indonesia.
Kata kunci usaha: ${q}
Pusat pencarian: ${center.label || ''} (lat ${center.lat}, lng ${center.lng})
Sudah pernah dicari (jangan diulang): ${known.length ? known.join('; ') : '(belum ada)'}

Sebutkan ${AREAS_PER_RUN} kecamatan atau desa lain di sekitar pusat itu (dalam radius sekitar 15 km) yang BELUM ada di daftar "sudah pernah dicari", urut dari yang paling dekat dengan pusat.
Setiap nama harus bisa dicari di Google Maps, tulis dengan format "Nama, Kabupaten".
Balas HANYA array JSON berisi string, contoh: ["Cipanas, Cianjur", "Sukaresmi, Cianjur"]. Tanpa penjelasan.`;
  try {
    const r = await fetch(GEMINI, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 200 }
      })
    });
    const j = await r.json();
    const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
    let text = parts.map((p) => p.text || '').join('').trim();
    const m = /\[[\s\S]*\]/.exec(text);
    if (!m) return [];
    const list = JSON.parse(m[0]);
    if (!Array.isArray(list)) return [];
    return list.map((s) => String(s || '').trim()).filter(Boolean)
      .filter((a) => !known.some((k) => k.toLowerCase().indexOf(a.toLowerCase()) >= 0))
      .slice(0, AREAS_PER_RUN);
  } catch (e) {
    console.error('sweep: area pick failed', e && e.message);
    return [];
  }
}

// Run one search through the existing endpoint and capture its JSON.
function search(body) {
  return new Promise((resolve) => {
    const res = {
      _s: 200,
      setHeader() {},
      status(c) { this._s = c; return this; },
      json(j) { resolve({ code: this._s, j: j || {} }); return this; }
    };
    discover({ query: {}, body: body }, res).catch((e) => resolve({ code: 502, j: { error: String(e && e.message || e) } }));
  });
}

module.exports = async (req, res) => {
  res.setHeader('cache-control', 'no-store');
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== 'object') body = {};
  const P = Object.assign({}, req.query || {}, body);

  const q = String(P.q || '').trim().slice(0, 80);
  const area = String(P.area || '').trim().slice(0, 80);
  let max = Math.min(Math.max(parseInt(P.max || '50', 10) || 50, 1), 200);
  let lat = parseFloat(P.lat || '');
  let lng = parseFloat(P.lng || '');
  const clientSkip = Array.isArray(P.skip) ? P.skip.map(String) : [];
  const project = String(P.projectId || PROJECT || '');
  const fbKey = String(P.firebaseKey || FB_KEY || '');
  const geminiKey = process.env.GEMINI_API_KEY;

  if (!q) return res.status(400).json({ error: 'Type what to look for' });
  if (!process.env.GOOGLE_MAPS_API_KEY) return res.status(500).json({ error: 'GOOGLE_MAPS_API_KEY is not set on Vercel' });

  try {
    const mem = await readMemory(project, fbKey);
    clientSkip.forEach((id) => { mem.ids[id] = 1; });

    // Where to look: explicit coordinates, or the area the app passed in.
    let center = { lat: lat, lng: lng, label: area };
    let firstArea = area;
    let googleDown = false;
    if (!isFinite(lat) || !isFinite(lng)) {
      if (!area) return res.status(400).json({ error: 'Type an area' });
      const probe = await search({ q: q, area: area, r: AREA_RADIUS, max: 1, calls: 1, skip: Object.keys(mem.ids) });
      if (probe.j.error) {
        if (/quota/i.test(probe.j.error)) {
          googleDown = true;                                 // keep going: OpenStreetMap still works
        } else {
          return res.status(502).json({ error: probe.j.error });
        }
      } else {
        center = probe.j.center || { lat: NaN, lng: NaN, label: area };
        firstArea = '';
      }
    }

    const areas = googleDown ? [] : await pickAreas(q, center, mem.done, geminiKey);
    const queue = googleDown ? [] : (areas.length ? areas : [firstArea || area || center.label || '']).filter(Boolean);

    const items = [];
    const searched = [];
    const allIds = [];
    let used = 0, again = 0, withSite = 0, scanned = 0, more = false;
    const seenPhones = new Set();

    for (let i = 0; i < queue.length; i++) {
      if (used >= SWEEP_CALLS) { more = true; break; }
      const a = queue[i];
      const calls = Math.min(CALLS_PER_AREA, SWEEP_CALLS - used);
      // expand: every keyword variant for this category (villa / vila / penginapan / homestay …)
      const r = await search({ q: q, area: a, r: AREA_RADIUS, max: 100, calls: calls, expand: true, skip: Object.keys(mem.ids) });
      if (r.j.error) {
        if (/quota/i.test(r.j.error)) {
          more = true;
          if (!searched.length) return res.status(429).json({ error: r.j.error, quota: true, areas: searched });
          break;
        }
        continue;
      }
      used += r.j.calls || 0;
      again += r.j.again || 0;
      withSite += r.j.withSite || 0;
      scanned += r.j.scanned || 0;
      (r.j.ids || []).forEach((id) => { mem.ids[id] = 1; });     // never look at these again
      (r.j.ids || []).forEach((id) => { if (allIds.indexOf(id) < 0) allIds.push(id); });
      const key = (r.j.center && r.j.center.label) || a;
      mem.done[key] = Date.now();
      searched.push(r.j.center && r.j.center.label ? shortArea(r.j.center.label) : a);
      (r.j.items || []).forEach((it) => {
        if (seenPhones.has(it.phone)) return;                    // one number, once
        seenPhones.add(it.phone);
        items.push(it);
      });
      if (items.length >= max) { more = true; break; }
    }


    const saved = await writeMemory(project, fbKey, mem);
    items.sort((a, b) => a.km - b.km);
    const numbers = Math.min(items.length, max);
    items.length = numbers;
    return res.status(200).json({
      items: items,
      numbers: numbers,
      scanned: scanned,
      again: again,
      withSite: withSite,
      ids: allIds,
      areas: searched,
      calls: used,
      googleDown: googleDown,
      remembered: saved,
      more: more,
      done: Object.keys(mem.done).length,
      skipped: clientSkip.length
    });
  } catch (e) {
    return res.status(502).json({ error: String(e && e.message || e) });
  }
};

// "Kec. Cipanas, Kabupaten Cianjur, Jawa Barat, Indonesia" -> "Cipanas"
function shortArea(label) {
  const s = String(label || '');
  const m = /Kec\.?\s*([^,]+)/.exec(s);
  if (m) return m[1].trim();
  const parts = s.split(',');
  return (parts[0] || s).trim();
}
