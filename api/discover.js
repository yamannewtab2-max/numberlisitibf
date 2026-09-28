// GET /api/discover?q=<what>&area=<area name>&lat=&lng=&r=<metres>&tile=<tile index>&max=<numbers wanted>
//
// Finds businesses that carry a phone number around an area using Google Places API (New):
//   https://places.googleapis.com/v1/places:searchText
// The Google key lives in the GOOGLE_MAPS_API_KEY environment variable on the Vercel project and
// never reaches the browser. It is restricted to this app's own address, so every call is sent
// with that Referer header.
//
// Text Search returns at most 20 places per page and can be paged 3 times (nextPageToken), so an
// area is covered by overlapping tiles: the middle first, then rings around it. Tiles are walked
// until `max` numbers (default 50) are collected or the tiles run out.
//
// Response:
//   { center:{lat,lng,label}, items:[{name,address,phone,km}], numbers, found, scanned, landline,
//     none, more, nextTile, calls }
//   `phone` is an Indonesian mobile in local form (08…). A place whose only number is a
//   landline (021…) cannot open a WhatsApp chat, so it is counted (landline) instead of
//   returned. `more`/`nextTile` continue with the tiles that were not searched yet.

const BASE = 'https://places.googleapis.com/v1/places:searchText';
const REFERER = process.env.APP_ORIGIN || 'https://numberlisitibf.vercel.app/';
const FIELDS = [
  'places.id',
  'places.displayName',
  'places.nationalPhoneNumber',
  'places.internationalPhoneNumber',
  'places.formattedAddress',
  'places.location',
  'nextPageToken'
].join(',');
const FIELDS_AREA = 'places.location,places.formattedAddress,places.displayName';
const PAGE_SIZE = 20;       // Places caps one page at 20
const PAGES = 3;            // ... and a text search can be paged three times
const MAX_CALLS = 6;        // hard stop per search: 6 Google calls
const MAX_R = 50000;
const DEFAULT_R = 5000;
const DEFAULT_MAX = 50;
const HARD_MAX = 200;

function digits(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }

// 0812… / +62 812… / 62 812… / 812… -> 0812… (mobile) ; anything else -> ''
function toMobile(raw) {
  let d = digits(raw);
  if (d.indexOf('620') === 0) d = '62' + d.slice(3);
  if (d.indexOf('62') === 0) d = d.slice(2);
  else if (d.charAt(0) === '0') d = d.slice(1);
  return /^8\d{8,11}$/.test(d) ? '0' + d : '';
}

function kmBetween(lat, lng, p) {
  if (!p || !isFinite(p.latitude) || !isFinite(p.longitude)) return 0;
  const t = Math.PI / 180, R = 6371;
  const dLat = (p.latitude - lat) * t, dLng = (p.longitude - lng) * t;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat * t) * Math.cos(p.latitude * t) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
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

// Text Search only accepts a rectangle as a restriction (a circle is SearchNearby's shape), so
// each tile's circle is converted into its bounding box.
function rectOf(lat, lng, r) {
  const dLat = r / 111320;
  const dLng = r / (111320 * Math.cos(lat * Math.PI / 180));
  return {
    low: { latitude: lat - dLat, longitude: lng - dLng },
    high: { latitude: lat + dLat, longitude: lng + dLng }
  };
}

async function callGoogle(body, fields, key) {
  const r = await fetch(BASE, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': fields,
      referer: REFERER
    },
    body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (j && j.error && j.error.message) || ('places ' + r.status);
    const e = new Error(msg);
    e.status = r.status;
    throw e;
  }
  return j;
}

// The key is referrer-restricted, which the Geocoding API refuses, so the area centre comes
// from a text search pinned to Indonesia instead.
async function geocode(area, key) {
  const j = await callGoogle(
    { textQuery: area + ', Indonesia', maxResultCount: 1, languageCode: 'id' },
    FIELDS_AREA, key
  );
  const p = (j.places || [])[0];
  if (!p || !p.location) return null;
  return { lat: p.location.latitude, lng: p.location.longitude, label: p.formattedAddress || area };
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
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return res.status(500).json({ error: 'GOOGLE_MAPS_API_KEY is not set on Vercel' });

  try {
    let lat = parseFloat(Q.lat || '');
    let lng = parseFloat(Q.lng || '');
    let label = area;

    // A named area is looked up (so "Cianjur" or "Pacet, Cianjur" works); otherwise the
    // coordinates the app already has are reused.
    if (area || !isFinite(lat) || !isFinite(lng)) {
      if (!area) return res.status(400).json({ error: 'Type an area' });
      const hit = await geocode(area, key);
      if (!hit) return res.status(404).json({ error: 'Area not found: ' + area });
      lat = hit.lat; lng = hit.lng;
      label = hit.label;
    }

    const tiles = tileSet(lat, lng, r);
    const items = [], seen = new Set();
    let used = 0, scanned = 0, landline = 0, none = 0, more = false, nextTile = tile;

    for (let t = tile; t < tiles.length; t++) {
      if (used >= MAX_CALLS) { more = true; nextTile = t; break; }   // resume here next time
      const c = tiles[t];
      nextTile = t + 1;
      let pageToken = null;

      for (let page = 0; page < PAGES; page++) {
        if (used >= MAX_CALLS) { more = true; nextTile = t; break; }
        const body = {
          textQuery: q,
          languageCode: 'id',
          maxResultCount: PAGE_SIZE,
          rankPreference: 'DISTANCE',
          locationRestriction: { rectangle: rectOf(c.lat, c.lng, c.r) }
        };
        if (pageToken) body.pageToken = pageToken;
        used++;
        const j = await callGoogle(body, FIELDS, key);

        for (const p of j.places || []) {
          const id = p.id || ((p.displayName && p.displayName.text) + '|' + (p.location && p.location.latitude));
          if (seen.has(id)) continue;                  // tiles and pages overlap on purpose
          seen.add(id);
          scanned++;
          const mobile = toMobile(p.nationalPhoneNumber || p.internationalPhoneNumber || '');
          const anyPhone = digits(p.nationalPhoneNumber || p.internationalPhoneNumber || '');
          if (mobile) {
            items.push({
              name: (p.displayName && p.displayName.text) || '',
              address: p.formattedAddress || '',
              phone: mobile,
              km: kmBetween(lat, lng, p.location)
            });
          } else if (anyPhone.length >= 7) landline++;
          else none++;
        }
        if (items.length >= max) { more = true; break; }
        pageToken = j.nextPageToken || null;
        if (!pageToken) break;
      }
      if (items.length >= max) break;
    }
    if (used >= MAX_CALLS && nextTile < tiles.length) more = true;

    items.sort(function (a, b) { return a.km - b.km; });
    const found = items.length;                     // callable numbers seen while walking
    if (found > max) items.length = max;            // ... and what is handed back (the cap)
    const numbers = items.length;

    return res.status(200).json({
      center: { lat: lat, lng: lng, label: label },
      items: items,
      numbers: numbers,
      found: found,
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
