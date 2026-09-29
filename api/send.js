// Send ONE WhatsApp message through WA Hero (my.wahero.org).
//
// The API key stays on the server; the browser only ever posts a number and a message to this
// endpoint. Nothing is sent without the user pressing the send button on a specific lead, and
// each press sends exactly one message to that one number.

const ENDPOINT = 'https://my.wahero.org/api/send-message';

// WA Hero wants the number in international form without a plus sign: 628123456789
function toWaHero(phone) {
  let d = String(phone == null ? '' : phone).replace(/\D/g, '');
  if (d.indexOf('620') === 0) d = '62' + d.slice(3);
  if (d.indexOf('62') === 0) d = d;
  else if (d.charAt(0) === '0') d = '62' + d.slice(1);
  else if (d.charAt(0) === '8') d = '62' + d;
  return d;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const key = process.env.WAHERO_API_KEY;
  const p = req.body || {};
  const to = toWaHero(p.phone);
  const message = String(p.message || '').trim();

  if (!/^628\d{7,12}$/.test(to)) return res.status(400).json({ error: 'Bad number' });   // mobiles only
  if (!message) return res.status(400).json({ error: 'Empty message' });
  if (!key) return res.status(500).json({ error: 'WAHERO_API_KEY is not set' });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({ to, message }),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const why = (j && (j.message || j.error || j.detail)) || ('wahero ' + r.status);
      console.error('wahero rejected', r.status, why);
      return res.status(502).json({ error: String(why).slice(0, 200) });
    }
    return res.status(200).json({ ok: true, to, id: (j && (j.id || j.messageId || j.data)) || null });
  } catch (e) {
    clearTimeout(timer);
    console.error('wahero failed', e && e.message);
    return res.status(502).json({ error: 'WA Hero did not answer (' + String((e && e.message) || e).slice(0, 80) + ')' });
  }
};
