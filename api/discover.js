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
//   { center:{lat,lng,label}, items:[{name,address,phone,km,site}], numbers, found, scanned,
//     again, ids, landline, none, withSite, more, nextTile, calls }
//   `phone` is an Indonesian mobile in local form (08…). A place whose only number is a
//   landline (021…) cannot open a WhatsApp chat, so it is counted (landline) instead of
//   returned.
//   Only businesses WITHOUT their own website are returned - that is who the pitch is for. A
//   place linked to Instagram/WhatsApp/Linktree still counts as "no website" (`site:'social'`),
//   a real domain is dropped and counted in `withSite`.
//   POST the ids the app has already seen as `skip` (JSON body) and they come back counted in
//   `again` instead of `scanned`; `ids` returns every place id this request touched so the app
//   can remember them (phone or no phone) and never scan that place twice.
//   `more`/`nextTile` continue with the tiles that were not searched yet.

const BASE = 'https://places.googleapis.com/v1/places:searchText';
const REFERER = process.env.APP_ORIGIN || 'https://numberlisitibf.vercel.app/';
const FIELDS = [
  'places.id',
  'places.displayName',
  'places.nationalPhoneNumber',
  'places.internationalPhoneNumber',
  'places.formattedAddress',
  'places.location',
  'places.websiteUri',
  'nextPageToken'
].join(',');
const FIELDS_AREA = 'places.location,places.formattedAddress,places.displayName';
const PAGE_SIZE = 20;       // Places caps one page at 20
const PAGES = 3;            // ... and a text search can be paged three times
const MAX_CALLS = 6;        // hard stop per search: 6 Google calls
const MAX_SKIP = 20000;     // ids the client may send as "already scanned"
const MAX_R = 50000;
const DEFAULT_R = 5000;
const DEFAULT_MAX = 50;
const HARD_MAX = 200;

function digits(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }

// What counts as "having a website". An Instagram/WhatsApp/Linktree page is not one: the owner
// still does not own a .com, which is exactly who this app is looking for. Only a real domain
// (or a free-site builder that behaves like a website) takes a place out of the list.
const NOT_A_WEBSITE = /instagram\.com|facebook\.com|fb\.me|fb\.com|wa\.me|api\.whatsapp|whatsapp\.com|linktr\.ee|linktree|tiktok\.com|twitter\.com|\bx\.com|youtube\.com|youtu\.be|sites\.google\.com|blogspot\.|wordpress\.com|wixsite\.com|weebly|myshopify|tokopedia\.com|shopee\.co\.id|google\.com\/maps|goo\.gl|bit\.ly|s\.id|link\.in|beacons\.ai|carrd\.co|notion\.site/i;

function siteKind(uri) {
  const u = String(uri || '').trim();
  if (!u) return 'none';                       // no link at all
  return NOT_A_WEBSITE.test(u) ? 'social' : 'own';
}

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
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== 'object') body = {};
  const P = Object.assign({}, req.query || {}, body);

  const q = String(P.q || '').trim().slice(0, 80);
  const area = String(P.area || '').trim().slice(0, 80);
  const tile = Math.max(0, parseInt(P.tile || '0', 10) || 0);
  let r = parseInt(P.r || String(DEFAULT_R), 10) || DEFAULT_R;
  r = Math.min(Math.max(r, 500), MAX_R);
  let max = parseInt(P.max || String(DEFAULT_MAX), 10) || DEFAULT_MAX;
  max = Math.min(Math.max(max, 1), HARD_MAX);
  // Places this app already looked at (any earlier search, any device): never hand them back
  // and never count them again.
  const skip = new Set((Array.isArray(P.skip) ? P.skip : []).slice(0, MAX_SKIP).map(String));
  // How many Google requests this call may spend (the sweep orchestrator budgets a whole run).
  const callBudget = Math.min(Math.max(parseInt(P.calls || String(MAX_CALLS), 10) || MAX_CALLS, 1), MAX_CALLS);

  if (!q) return res.status(400).json({ error: 'Type what to look for' });
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return res.status(500).json({ error: 'GOOGLE_MAPS_API_KEY is not set on Vercel' });

  try {
    let lat = parseFloat(P.lat || '');
    let lng = parseFloat(P.lng || '');
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
    const items = [], seen = new Set(), ids = [];
    let used = 0, scanned = 0, landline = 0, none = 0, hasSite = 0, again = 0, more = false, nextTile = tile;

    for (let t = tile; t < tiles.length; t++) {
      if (used >= callBudget) { more = true; nextTile = t; break; }   // resume here next time
      const c = tiles[t];
      nextTile = t + 1;
      let pageToken = null;

      for (let page = 0; page < PAGES; page++) {
        if (used >= callBudget) { more = true; nextTile = t; break; }
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
          ids.push(id);                                 // handed back so the app can remember it
          if (skip.has(id)) { again++; continue; }       // scanned in an earlier search
          scanned++;
          const mobile = toMobile(p.nationalPhoneNumber || p.internationalPhoneNumber || '');
          const anyPhone = digits(p.nationalPhoneNumber || p.internationalPhoneNumber || '');
          const kind = siteKind(p.websiteUri);
          if (mobile && kind === 'own') { hasSite++; continue; }   // already has a real website
          if (mobile) {
            items.push({
              name: (p.displayName && p.displayName.text) || '',
              address: p.formattedAddress || '',
              phone: mobile,
              km: kmBetween(lat, lng, p.location),
              lat: p.location && p.location.latitude,
              lng: p.location && p.location.longitude,
              site: kind                       // 'none' | 'social' (never 'own' - those are skipped)
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
    if (used >= callBudget && nextTile < tiles.length) more = true;

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
      again: again,
      ids: ids,
      landline: landline,
      none: none,
      withSite: hasSite,
      more: more,
      nextTile: nextTile,
      calls: used
    });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
};
