// GET /api/discover?q=<what>&area=<area name>&lat=&lng=&r=<metres>&offset=<n>
//
// Finds businesses around an area with HERE (discover.search.hereapi.com) and returns the
// ones carrying a phone number. The HERE key lives in the HERE_API_KEY environment variable
// on the Vercel project and never reaches the browser.
//
// Response:
//   { center:{lat,lng,label}, items:[{name,address,phone,landline,km}], more:bool }
//   phone is an Indonesian mobile in local form (08…) or '' when the place only has a
//   landline (done, landline) — a landline cannot open a WhatsApp chat.

const GEO = 'https://geocode.search.hereapi.com/v1/geocode';
const DISCOVER = 'https://discover.search.hereapi.com/v1/discover';
const LIMIT = 100;
const MAX_R = 50000;
const DEFAULT_R = 5000;

function digits(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }

// A bare name such as "Bromo" also matches places abroad (Bromo, Kentucky), so the geocoder is
// pinned to Indonesia and the area is only widened to the whole world if that finds nothing.
async function geocode(area, key) {
  const base = GEO + '?q=' + encodeURIComponent(area) + '&lang=id&limit=1&apiKey=' + key;
  let g = await getJSON(base + '&in=' + encodeURIComponent('countryCode:IDN'));
  if (!(g.items || []).length) g = await getJSON(base);
  return (g.items || [])[0] || null;
}

// 0812… / +62 812… / 62 812… / 812… -> 0812… (mobile) ; anything else -> ''
function toMobile(raw) {
  let d = digits(raw);
  if (d.indexOf('620') === 0) d = '62' + d.slice(3);
  if (d.indexOf('62') === 0) d = d.slice(2);
  else if (d.charAt(0) === '0') d = d.slice(1);
  return /^8\d{8,11}$/.test(d) ? '0' + d : '';
}

function contactsOf(item) {
  let mobile = '', landline = '';
  const cs = item.contacts || [];
  for (const c of cs) {
    for (const p of (c.phone || [])) {
      const m = toMobile(p.value);
      if (m) { if (!mobile) mobile = m; }
      else if (digits(p.value).length >= 7) { if (!landline) landline = String(p.value).trim(); }
    }
  }
  return { mobile, landline };
}

async function getJSON(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error((j && j.title) || ('here ' + r.status));
    e.status = r.status;
    throw e;
  }
  return j;
}

module.exports = async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  const q = String((req.query && req.query.q) || '').trim().slice(0, 80);
  const area = String((req.query && req.query.area) || '').trim().slice(0, 80);
  const offset = Math.max(0, parseInt((req.query && req.query.offset) || '0', 10) || 0);
  let r = parseInt((req.query && req.query.r) || String(DEFAULT_R), 10) || DEFAULT_R;
  r = Math.min(Math.max(r, 500), MAX_R);

  if (!q) return res.status(400).json({ error: 'Type what to look for' });
  const key = process.env.HERE_API_KEY;
  if (!key) return res.status(500).json({ error: 'HERE_API_KEY is not set on Vercel' });

  try {
    let lat = parseFloat((req.query && req.query.lat) || '');
    let lng = parseFloat((req.query && req.query.lng) || '');
    let label = area;

    // A named area is geocoded (so "Cianjur" or "Pacet, Cianjur" works); otherwise the
    // coordinates the app already has are reused.
    if (area || !isFinite(lat) || !isFinite(lng)) {
      if (!area) return res.status(400).json({ error: 'Type an area' });
      const hit = await geocode(area, key);
      if (!hit) return res.status(404).json({ error: 'Area not found: ' + area });
      lat = hit.position.lat; lng = hit.position.lng;
      label = hit.address ? (hit.address.label || hit.title) : hit.title;
    }

    const url = DISCOVER + '?q=' + encodeURIComponent(q) +
      '&in=' + encodeURIComponent('circle:' + lat + ',' + lng + ';r=' + r) +
      '&limit=' + LIMIT + '&offset=' + offset + '&lang=id&apiKey=' + key;
    const d = await getJSON(url);

    // HERE returns distance only when the query was built with `at`, so the distance is
    // measured here, against the centre that was actually searched.
    function kmTo(p) {
      if (!p || !isFinite(p.lat) || !isFinite(p.lng)) return 0;
      const t = Math.PI / 180, R = 6371;
      const dLat = (p.lat - lat) * t, dLng = (p.lng - lng) * t;
      const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat * t) * Math.cos(p.lat * t) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
      return Math.round(2 * R * Math.asin(Math.sqrt(a)) * 10) / 10;
    }

    const items = (d.items || []).map(function (i) {
      const c = contactsOf(i);
      return {
        name: i.title || '',
        address: (i.address && (i.address.label || i.address.street)) || '',
        phone: c.mobile,
        landline: c.landline,
        km: kmTo(i.position)
      };
    }).filter(function (i) { return i.name; })
      .sort(function (a, b) { return a.km - b.km; });

    return res.status(200).json({
      center: { lat: lat, lng: lng, label: label },
      items: items,
      more: (d.items || []).length === LIMIT
    });
  } catch (e) {
    return res.status(e.status && e.status < 500 ? 502 : 502).json({ error: String(e.message || e) });
  }
};
