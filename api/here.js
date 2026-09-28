// HERE (discover.search.hereapi.com) as the fallback source.
//
// Google Places is the better data and is always tried first; this runs when Google cannot be
// used (daily quota reached, or the key/API is unavailable). HERE's free tier allows 1,000
// requests per day, which is what keeps the search alive on days Google's cap is gone.
//
// Same rules as the Google path: Indonesian mobile numbers only, businesses that already have
// their own website are dropped, one number once, and every keyword variant for the category is
// swept because each word matches a different set of businesses.

const DISCOVER = 'https://discover.search.hereapi.com/v1/discover';
const GEO = 'https://geocode.search.hereapi.com/v1/geocode';
const LIMIT = 100;          // HERE's page size for one query
const MAX_WORDS = 5;

const NOT_A_WEBSITE = /instagram\.com|facebook\.com|fb\.me|wa\.me|api\.whatsapp|whatsapp\.com|linktr\.ee|linktree|tiktok\.com|twitter\.com|youtube\.com|sites\.google\.com|blogspot\.|wordpress\.com|wixsite\.com|google\.com\/maps|goo\.gl|bit\.ly/i;

function digits(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }

function toMobile(raw) {
  let d = digits(raw);
  if (d.indexOf('620') === 0) d = '62' + d.slice(3);
  if (d.indexOf('62') === 0) d = d.slice(2);
  else if (d.charAt(0) === '0') d = d.slice(1);
  return /^8\d{8,11}$/.test(d) ? '0' + d : '';
}

function kmBetween(lat, lng, p) {
  if (!p || !isFinite(p.lat) || !isFinite(p.lng)) return 0;
  const t = Math.PI / 180, R = 6371;
  const dLat = (p.lat - lat) * t, dLng = (p.lng - lng) * t;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat * t) * Math.cos(p.lat * t) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return Math.round(2 * R * Math.asin(Math.sqrt(a)) * 10) / 10;
}

async function getJSON(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(url, { headers: { accept: 'application/json' }, signal: ctrl.signal });
    clearTimeout(timer);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error((j && j.title) || ('here ' + r.status));
      e.status = r.status;
      throw e;
    }
    return j;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

function contactsOf(item) {
  let mobile = '', landline = '', www = '';
  for (const c of item.contacts || []) {
    for (const p of (c.phone || [])) {
      const m = toMobile(p.value);
      if (m) { if (!mobile) mobile = m; }
      else if (digits(p.value).length >= 7) { if (!landline) landline = String(p.value).trim(); }
    }
    for (const w of (c.www || [])) {
      if (w && w.value && !www) www = String(w.value);
    }
  }
  return { mobile, landline, www };
}

// A bare name such as "Bromo" also matches places abroad, so the geocoder is pinned to Indonesia.
async function geocode(area, key) {
  const base = GEO + '?q=' + encodeURIComponent(area) + '&lang=id&limit=1&apiKey=' + encodeURIComponent(key);
  let g = await getJSON(base + '&in=' + encodeURIComponent('countryCode:IDN'));
  if (!(g.items || []).length) g = await getJSON(base);
  const hit = (g.items || [])[0];
  if (!hit) return null;
  return { lat: hit.position.lat, lng: hit.position.lng, label: (hit.address && hit.address.label) || hit.title || area };
}

// words: the keyword variants for this category (["villa","vila","penginapan", ...])
async function findByKeyword(q, center, r, words, key) {
  const list = (words && words.length ? words : [q]).slice(0, MAX_WORDS).filter(Boolean);
  const items = [];
  const seenId = new Set();
  const seenPhone = new Set();
  let calls = 0;

  for (const w of list) {
    const url = DISCOVER + '?q=' + encodeURIComponent(w) +
      '&in=' + encodeURIComponent('circle:' + center.lat + ',' + center.lng + ';r=' + Math.round(r)) +
      '&limit=' + LIMIT + '&lang=id&apiKey=' + encodeURIComponent(key);
    let j;
    try {
      j = await getJSON(url);
    } catch (e) {
      console.error('here failed', w, e && e.message);
      if (e && e.status === 401) throw e;          // bad key: no point trying the other words
      continue;
    }
    calls++;
    for (const it of j.items || []) {
      const id = it.id || (it.title + '|' + ((it.position && it.position.lat) || ''));
      if (seenId.has(id)) continue;
      seenId.add(id);
      const ct = contactsOf(it);
      if (!ct.mobile) continue;                    // landline or no number: cannot open WhatsApp
      if (ct.www && !NOT_A_WEBSITE.test(ct.www)) continue;   // already has a real website
      if (seenPhone.has(ct.mobile)) continue;
      seenPhone.add(ct.mobile);
      items.push({
        name: it.title || '',
        address: (it.address && (it.address.label || it.address.street)) || '',
        phone: ct.mobile,
        km: kmBetween(center.lat, center.lng, it.position),
        lat: it.position && it.position.lat,
        lng: it.position && it.position.lng,
        site: ct.www ? 'social' : 'none',
        source: 'here'
      });
    }
  }

  items.sort((a, b) => a.km - b.km);
  return { items, calls, words: list.length };
}

module.exports = { findByKeyword, geocode };
