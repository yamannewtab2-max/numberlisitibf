// GET /api/discover?q=<what>&area=<area name>&lat=&lng=&r=<metres>&tile=<tile index>&max=<numbers wanted>
//
// Finds businesses that carry a phone number around an area using HERE
// (discover.search.hereapi.com). The HERE key lives in the HERE_API_KEY environment
// variable on the Vercel project and never reaches the browser.
//
// HERE's discover endpoint never returns more than 100 places, and `offset` only works
// inside that page (offset >= limit is a 400 "Illegal input for parameter 'offset'"), so an
// area is covered by a set of overlapping tiles instead: the middle first, then rings around
// it. Tiles are walked until `max` numbers (default 50) are collected or the tiles run out.
//
// Response:
//   { center:{lat,lng,label}, items:[{name,address,phone,km}], numbers, scanned, landline,
//     none, more, nextTile, calls }
//   `phone` is an Indonesian mobile in local form (08…). A place whose only number is a
//   landline (021…) cannot open a WhatsApp chat, so it is counted (landline) instead of
//   returned. `more`/`nextTile` continue with the tiles that were not searched yet.

const GEO = 'https://geocode.search.hereapi.com/v1/geocode';
const DISCOVER = 'https://discover.search.hereapi.com/v1/discover';
const LIMIT = 100;          // HERE's page size = the most it will ever return for one query
const MAX_CALLS = 8;        // hard stop: at most 8 HERE calls per search (of the 1000/day free)
const MAX_R = 50000;
const DEFAULT_R = 5000;
const DEFAULT_MAX = 50;
const HARD_MAX = 200;

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

// HERE returns distance only when the query was built with `at`, so the distance is measured
// here, against the centre that was actually searched.
function kmBetween(lat, lng, p) {
  if (!p || !isFinite(p.lat) || !isFinite(p.lng)) return 0;
  const t = Math.PI / 180, R = 6371;
  const dLat = (p.lat - lat) * t, dLng = (p.lng - lng) * t;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat * t) * Math.cos(p.lat * t) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return Math.round(2 * R * Math.asin(Math.sqrt(a)) * 10) / 10;
}

// Middle circle first, then overlapping rings — a ring tile sits at `dist` × r from the
// centre and keeps its radius small enough to stay inside the searched area.
function tileSet(lat, lng, r) {
  const tiles = [{ lat: lat, lng: lng, r: Math.min(r, MAX_R) }];
  const rings = [{ n: 6, dist: 0.62, rad: 0.70 }, { n: 12, dist: 1.15, rad: 0.58 }];
  for (const g of rings) {
    const far = (g.dist * r) / 1000;                       // km from the centre
    const rad = Math.round(r * g.rad);
    if (rad < 500) continue;
    for (let i = 0; i < g.n; i++) {
      const b = (i / g.n) * 2 * Math.PI;
      const dLat = (far / 111.32) * Math.cos(b);
      const dLng = (far / (111.32 * Math.cos(lat * Math.PI / 180))) * Math.sin(b);
      tiles.push({ lat: lat + dLat, lng: lng + dLng, r: rad });
    }
  }
  return tiles;
}

module.exports = async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  const Q = req.query || {};
  const q = String(Q.q || '').trim().slice(0, 80);
  const area = String(Q.area || '').trim().slice(0, 80);
  const tile = Math.max(0, parseInt(Q.tile || '0', 10) || 0);
  let r = parseInt(Q.r || String(DEFAULT_R), 10) || DEFAULT_R;
  r = Math.min(Math.max(r, 500), MAX_R);
  let max = parseInt(Q.max || String(DEFAULT_MAX), 10) || DEFAULT_MAX;
  max = Math.min(Math.max(max, 1), HARD_MAX);

  if (!q) return res.status(400).json({ error: 'Type what to look for' });
  const key = process.env.HERE_API_KEY;
  if (!key) return res.status(500).json({ error: 'HERE_API_KEY is not set on Vercel' });

  try {
    let lat = parseFloat(Q.lat || '');
    let lng = parseFloat(Q.lng || '');
    let label = area;

    // A named area is geocoded (so "Cianjur" or "Pacet, Cianjur" works); otherwise the
    // coordinates the app already has are reused.
    if (area || !isFinite(lat) || !isFinite(lng)) {
      if (!area) return res.status(400).json({ error: 'Type an area' });
      const hit = await geocode(area, key);
      if (!hit) return res.status(404).json({ error: 'Area not found: ' + area });
      lat = hit.position.lat; lng = hit.position.lng;
      label = (hit.address && hit.address.label) || hit.title;
    }

    const tiles = tileSet(lat, lng, r);
    const items = [], seen = new Set();
    let used = 0, scanned = 0, landline = 0, none = 0, more = false, nextTile = tile;

    for (let t = tile; t < tiles.length; t++) {
      if (used >= MAX_CALLS) { more = true; nextTile = t; break; }   // resume here next time
      const c = tiles[t];
      used++;
      nextTile = t + 1;
      const d = await getJSON(DISCOVER + '?q=' + encodeURIComponent(q) +
        '&in=' + encodeURIComponent('circle:' + c.lat + ',' + c.lng + ';r=' + c.r) +
        '&limit=' + LIMIT + '&lang=id&apiKey=' + key);

      for (const i of d.items || []) {
        const id = i.id || (i.title + '|' + (i.position && i.position.lat));
        if (seen.has(id)) continue;                  // tiles overlap on purpose
        seen.add(id);
        scanned++;
        const ct = contactsOf(i);
        if (ct.mobile) {
          items.push({
            name: i.title || '',
            address: (i.address && (i.address.label || i.address.street)) || '',
            phone: ct.mobile,
            km: kmBetween(lat, lng, i.position)
          });
        } else if (ct.landline) landline++;
        else none++;
      }
      if (items.length >= max) { more = nextTile < tiles.length; break; }
    }
    if (used >= MAX_CALLS && nextTile < tiles.length) more = true;

    items.sort(function (a, b) { return a.km - b.km; });
    const numbers = items.length;
    if (numbers > max) items.length = max;

    return res.status(200).json({
      center: { lat: lat, lng: lng, label: label },
      items: items,
      numbers: numbers,
      scanned: scanned,
      landline: landline,
      none: none,
      more: more,
      nextTile: nextTile,
      calls: used
    });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
};
