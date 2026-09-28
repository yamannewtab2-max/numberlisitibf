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
  [/villa|vila|guest ?house|penginapan|homestay/i, 'villa', 'foto kamar, fasilitas, harga per malam, lokasi, dan cara pesan langsung'],
  [/resto|restaurant|rumah makan|warung|cafe|kafe|kedai|bakery/i, 'restoran', 'daftar menu dan harga, foto makanan, jam buka, lokasi, dan pesanan lewat WhatsApp'],
  [/barber|cukur|salon|potong|spa/i, 'barbershop', 'daftar layanan dan harga, galeri hasil potongan, jam buka, dan pelanggan bisa datang tanpa antre panjang'],
  [/hotel|resort|losmen|motel|inn/i, 'hotel', 'tipe kamar dan fasilitas, harga, lokasi, dan cara pesan langsung'],
  [/shop|toko|store|butik|grosir|distro|bangunan|material/i, 'toko', 'daftar produk, harga, pesan lewat WhatsApp, dan lokasi toko'],
  [/bengkel|servis|service|motor|mobil|workshop/i, 'bengkel', 'daftar harga jasa, jadwal servis, dan galeri hasil kerja'],
  [/laundry|cuci|kiloan/i, 'laundry', 'daftar harga dan layanan, serta cara pesan jemput cucian'],
  [/klinik|dokter|praktek|apotek|bidan|gigi/i, 'klinik', 'jadwal praktik, daftar layanan, lokasi, dan cara daftar tanpa antre'],
  [/kursus|bimbel|les|sekolah|belajar|training/i, 'tempat kursus', 'daftar program dan biaya, jadwal kelas, dan cara daftar'],
  [/kontraktor|jasa|service|travel|rental|sewa|properti|agen/i, 'usaha jasa', 'daftar layanan, contoh hasil kerja, dan permintaan penawaran lewat WhatsApp'],
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

const PROMPT = `Kamu menulis pesan WhatsApp pertama ke pemilik usaha kecil di Indonesia, setelah menemukan nomornya di Google Maps. Kamu menawarkan jasa pembuatan website profesional untuk usaha mereka.

Data usaha:
- Nama usaha: {NAME}
- Kategori: {CATEGORY}

INTI PESAN: seluruh pesan harus menjual MANFAAT WEBSITE untuk usaha jenis ini. Manfaatnya harus spesifik untuk kategori itu, bukan manfaat umum.

Manfaat khas per kategori (pilih 3-4 yang paling cocok, jangan campur dengan kategori lain):
- Villa / penginapan: tamu lihat foto kamar & fasilitas, harga per malam jelas, lokasi, bisa pesan langsung tanpa lewat aplikasi lain, terlihat lebih terpercaya.
- Restoran / warung / kafe: menu & harga terlihat sebelum datang, foto makanan bikin orang tertarik, jam buka, lokasi, pesanan/reservasi langsung masuk WhatsApp.
- Barbershop / salon: daftar layanan & harga, galeri hasil potongan, jam buka, pelanggan bisa datang tanpa antre panjang.
- Hotel: tipe kamar & fasilitas, harga, lokasi, pesan langsung, lebih dipercaya tamu dari luar kota.
- Toko / barang: daftar produk, harga, pesan lewat WhatsApp, lokasi toko, ditemukan di Google saat orang mencari produk itu.
- Kategori lain (bengkel, laundry, klinik, kursus, jasa, dll): pikirkan sendiri apa yang paling dicari calon pelanggan usaha semacam itu (daftar layanan, harga, jam buka, lokasi, cara pesan, bukti hasil kerja), lalu pakai itu.

Aturan keras:
- Bahasa Indonesia sehari-hari seperti orang chat, bukan bahasa iklan.
- JANGAN pakai istilah teknis, singkatan, atau bahasa asing: OTA, SEO, platform, landing page, online, booking, update, dsb. Tulis maksudnya dengan kata sehari-hari ("bisa pesan langsung tanpa lewat aplikasi lain", "tanpa potongan komisi aplikasi", "pelanggan bisa lihat sendiri").
- Sebut produknya "website" (kata ini sudah biasa dipakai orang Indonesia). Jangan pakai kiasan aneh seperti "tempat khusus di internet" atau "tempat pajang foto".
- Akhiri dengan SATU pertanyaan saja, jangan dua tawaran berturut-turut.
- 3-4 kalimat pendek. Maksimal 450 karakter.
- Setiap kalimat manfaat harus menyebut keuntungan untuk pelanggan atau pemiliknya (misal "pelanggan bisa lihat menu dan harga sebelum datang"), bukan sekadar kata "website profesional".
- Sebut nama usaha sekali secara alami. Kalau namanya tidak jelas, pakai kategorinya.
- Tawarkan dibuatkan contoh/demo dulu supaya mereka bisa lihat hasilnya.
- Maksimal 1 emoji, atau tidak sama sekali. Jangan pakai tanda seru berlebihan.
- Jangan sebut harga jasa. Jangan menjanjikan hal yang tidak pasti (jumlah pelanggan, omzet). Jangan mengaku dari perusahaan tertentu, dan jangan mengaku sudah pernah menghubungi mereka.
- Akhiri dengan satu pertanyaan singkat yang mudah dijawab, atau ajakan halus — bukan perintah.

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
