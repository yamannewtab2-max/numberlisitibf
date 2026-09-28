// POST /api/message  { name, category }  ->  { message }
// Writes a short, natural Indonesian WhatsApp opener for the business using
// Gemini 2.5 Flash-Lite. The API key lives in the GEMINI_API_KEY environment
// variable on the Vercel project and never reaches the browser.
// If the key is missing (or Gemini fails), a built-in Indonesian template is
// returned instead, so the WhatsApp flow always works.

// Fast Flash-Lite models in preference order: the first answers in ~1s. 2.5-flash-lite
// is retired for new API keys ("no longer available to new users"), so it is not used.
const MODELS = ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-flash-lite-latest'];
const PER_MODEL_TIMEOUT_MS = 6000;
const endpointFor = (m) => `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;

const LIMITS = { name: 80, category: 40 };

const FALLBACK = [
  [/villa|vila|guest ?house|penginapan|homestay/i, 'villa', 'foto-foto, kamar, fasilitas, harga, lokasi, dan tombol pemesanan'],
  [/resto|restaurant|rumah makan|warung|cafe|kafe|kedai|bakery/i, 'restoran', 'menu, harga, foto makanan, lokasi, jam buka, dan pemesanan lewat WhatsApp'],
  [/barber|cukur|salon|potong/i, 'barbershop', 'daftar layanan, harga, galeri hasil potongan, lokasi, jam buka, dan booking'],
  [/hotel|resort|losmen|motel|inn/i, 'hotel', 'kamar, fasilitas, harga, lokasi, dan tombol booking langsung'],
  [/shop|toko|store|butik|grosir|distro/i, 'toko', 'produk, harga, katalog, pemesanan lewat WhatsApp, dan lokasi'],
];

function fallback(name, category) {
  let cat = category || 'usaha';
  let benefit = 'profil usaha, foto, harga, lokasi, dan tombol WhatsApp';
  for (const [re, noun, text] of FALLBACK) {
    if (re.test(category)) { cat = noun; benefit = text; break; }
  }
  const who = name || cat;
  return (
    `Halo, saya dapat nomor ${who} dari Google Maps. Saya bikin website untuk ${cat} — isinya ${benefit}.\n\n` +
    `Kalau berminat, saya buatkan contohnya dulu (gratis) supaya ${who} bisa lihat hasilnya. Terima kasih.`
  );
}

const PROMPT = `Kamu menulis pesan WhatsApp pertama ke pemilik usaha kecil di Indonesia,
setelah menemukan nomornya di Google Maps. Kamu menawarkan jasa pembuatan website profesional
untuk usaha mereka.

Data usaha:
- Nama usaha: {NAME}
- Kategori: {CATEGORY}

Aturan keras:
- Bahasa Indonesia yang natural, seperti orang Indonesia menulis chat, bukan bahasa iklan.
- Panjang 3-4 kalimat pendek saja. Maksimal 480 karakter.
- Sebut nama usaha sekali secara alami (kalau namanya masuk akal). Kalau nama tidak jelas, pakai kategorinya.
- Fokus ke manfaat yang relevan dengan kategori usaha itu, bukan daftar panjang. Pilih 3-5 hal yang paling menjual untuk kategori itu (contoh: villa -> foto, kamar, fasilitas, harga, lokasi, tombol booking; restoran -> menu, harga, foto makanan, jam buka, pesan/booking lewat WhatsApp; barbershop -> layanan, harga, galeri hasil potong, jam buka, booking; hotel -> kamar, fasilitas, harga, lokasi, booking; toko -> produk, harga, katalog, order lewat WhatsApp, lokasi).
- Tawarkan untuk membuatkan contoh/demo dulu supaya mereka bisa lihat hasilnya sebelum memutuskan.
- Maksimal 1 emoji, atau tidak sama sekali. Jangan pakai tanda seru berlebihan.
- Jangan berjanji hal yang tidak bisa dipastikan (jangan bilang sudah punya pelanggan mereka, jangan mengaku dari perusahaan tertentu, jangan sebut harga).
- Jangan mengaku sudah menghubungi mereka sebelumnya.
- Akhiri dengan pertanyaan singkat yang mudah dijawab, atau ajakan halus — bukan perintah.

Balas HANYA isi pesannya. Tanpa tanda kutip, tanpa penjelasan, tanpa judul.`;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'POST only' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  if (!body || typeof body !== 'object') {
    res.status(400).json({ ok: false, error: 'bad json' });
    return;
  }

  const name = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.name);
  const category = String(body.category || '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.category);

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    res.status(200).json({ ok: true, source: 'template', message: fallback(name, category) });
    return;
  }

  const prompt = PROMPT.replace('{NAME}', name || '-').replace('{CATEGORY}', category || '-');

  for (const model of MODELS) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), PER_MODEL_TIMEOUT_MS);
      const r = await fetch(endpointFor(model), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        signal: ctrl.signal,
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.9,
            topP: 0.95,
            maxOutputTokens: 400,
          },
        }),
      });
      clearTimeout(timer);

      const j = await r.json();
      const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
      let text = parts.map((p) => p.text || '').join('').trim();

      text = text.replace(/^```[a-z]*\s*/i, '').replace(/```$/,'').replace(/^["'“”]+|["'“”]+$/g, '').trim();

      if (!text || text.length > 700) continue;   // retired model or odd reply -> next model, then template
      res.status(200).json({ ok: true, source: 'gemini', model, message: text });
      return;
    } catch (e) {
      console.error('gemini failed', model, e && e.message);   // try the next model
    }
  }
  res.status(200).json({ ok: true, source: 'template', message: fallback(name, category) });
};
