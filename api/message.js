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
  [/resto|restaurant|rumah makan|warung|cafe|kafe|kedai|seafood|ikan|kuliner|katering|catering|kue|roti|bakery|sate|ayam|bakso|nasi|mie|martabak|dapur/i, 'restoran', 'daftar menu dan harga, foto makanan, jam buka, lokasi, dan pesanan lewat WhatsApp'],
  [/barber|cukur|salon|potong|\bspa\b|perawatan/i, 'barbershop', 'daftar layanan dan harga, galeri hasil potongan, jam buka, dan pelanggan bisa datang tanpa antre panjang'],
  [/hotel|resort|losmen|motel|\binn\b/i, 'hotel', 'tipe kamar dan fasilitas, harga, lokasi, dan cara pesan langsung'],
  [/bengkel|servis|service|motor|mobil|workshop/i, 'bengkel', 'daftar harga jasa, jadwal servis, dan galeri hasil kerja'],
  [/plumber|tukang|pipa|instalasi|listrik|elektrik/i, 'jasa servis', 'daftar layanan dan area yang dilayani, kisaran harga, dan cara menghubungi lewat WhatsApp'],
  [/gym|fitness|senam|yoga|olahraga|sanggar/i, 'gym', 'jadwal latihan, harga keanggotaan, galeri tempat dan alat, lokasi, dan cara mendaftar'],
  [/wedding|pernikahan|dekorasi|rias|organizer|tenda/i, 'jasa wedding', 'paket dan harga, galeri hasil dekorasi, dan cara menghubungi lewat WhatsApp'],
  [/print|percetakan|cetak|fotokopi|sablon/i, 'percetakan', 'daftar jenis cetakan dan harga, kirim file lewat WhatsApp, dan lokasi'],
  [/klinik|dokter|praktek|apotek|bidan|gigi|rumah sakit/i, 'klinik', 'jadwal praktik, daftar layanan, lokasi, dan cara daftar tanpa antre'],
  [/kursus|bimbel|\bles\b|sekolah|\bschool\b|pondok|pesantren|kampus|akademi/i, 'sekolah / kursus', 'program dan biaya, jadwal, galeri kegiatan, dan cara mendaftar'],
  [/laundry|cuci|kiloan/i, 'laundry', 'daftar harga dan layanan, serta cara pesan jemput cucian'],
  [/\bshop\b|\bstore\b|butik|grosir|distro|bangunan|material|toko/i, 'toko', 'daftar produk, harga, pesan lewat WhatsApp, dan lokasi toko'],
  [/kontraktor|\bjasa\b|travel|rental|sewa|properti|agen/i, 'usaha jasa', 'daftar layanan, contoh hasil kerja, dan permintaan penawaran lewat WhatsApp'],
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
    `Kalau alamat website-nya pakai .com dengan nama ${who} sendiri, usaha ini terlihat lebih resmi dan mudah diingat orang.\n\n` +
    `Harga jualnya mulai dari 1,5 juta, desainnya bersih dan rapi, dan alamat .com dengan nama usahanya sendiri sudah termasuk gratis untuk tahun pertama.\n\n` +
    `Soal biaya tidak perlu khawatir, semuanya masih bisa disesuaikan dengan budget Bapak/Ibu.\n\n` +
    `Kalau ada waktu sebentar, saya ingin tanya: website seperti apa yang Bapak/Ibu inginkan?`
  );
}

const PROMPT = `Kamu menulis pesan WhatsApp pertama ke pemilik usaha kecil di Indonesia, setelah menemukan nomornya di Google Maps. Kamu menawarkan jasa pembuatan website untuk usaha mereka.

Data usaha:
- Nama usaha: {NAME}
- Kategori: {CATEGORY}

Pesan harus menyentuh 4 hal ini, singkat dan mengalir:
1. MANFAAT WEBSITE untuk usaha jenis ini (ambil 2-3 yang paling cocok, jangan campur kategori lain):
- Villa / penginapan: tamu lihat foto kamar & fasilitas, harga per malam jelas, lokasi, bisa pesan langsung tanpa lewat aplikasi lain.
- Restoran / warung / kafe: menu & harga terlihat sebelum datang, foto makanan, jam buka, lokasi, pesanan langsung masuk WhatsApp.
- Barbershop / salon: daftar layanan & harga, galeri hasil potongan, jam buka, pelanggan datang tanpa antre panjang.
- Hotel: tipe kamar & fasilitas, harga, lokasi, pesan langsung, lebih dipercaya tamu dari luar kota.
- Toko / barang: daftar produk, harga, pesan lewat WhatsApp, lokasi, mudah ditemukan orang di Google.
- Kategori lain (bengkel, laundry, klinik, kursus, jasa, dll): pikirkan sendiri apa yang paling dicari calon pelanggan usaha semacam itu.
2. ALAMAT WEBSITE SENDIRI: dorong mereka punya website dengan alamat .com memakai nama usaha mereka sendiri (contoh: namaUsahanya.com). Alasannya: terlihat resmi dan lebih dipercaya, mudah diingat orang, dan jadi milik mereka sendiri - bukan numpang di akun orang lain.
3. HARGA & BONUS: sebutkan harga jual mulai dari 1,5 juta. Sekaligus sebutkan dua hal ini sebagai nilai tambah: (a) desainnya bersih, rapi, dan enak dilihat; (b) alamat .com dengan nama usaha mereka sendiri sudah termasuk GRATIS untuk tahun pertama. Tetap tenangkan mereka bahwa biaya bisa disesuaikan dengan budget.
4. PENUTUP: tanya apakah mereka punya waktu sebentar, karena kamu ingin tahu website seperti apa yang mereka inginkan.

Aturan keras:
- Bahasa Indonesia sehari-hari seperti orang chat, bukan bahasa iklan.
- 4-5 kalimat pendek. Maksimal 550 karakter.
- JANGAN menawarkan contoh, demo, atau draf terlebih dulu. Dilarang menulis "saya buatkan contohnya dulu" atau sejenisnya. Yang ditawarkan hanya obrolan singkat tentang keinginan mereka.
- PESAN WAJIB memuat alamat ".com" yang memakai nama usaha mereka (contoh: namaUsahanya.com). Jangan sampai lupa.
- JANGAN pakai istilah teknis, singkatan, atau bahasa asing: OTA, SEO, platform, landing page, online, booking, update, dsb. Tulis maksudnya dengan kata sehari-hari ("alamat website .com", "bisa pesan langsung tanpa lewat aplikasi lain").
- Sebut produknya "website" (kata ini sudah biasa dipakai orang Indonesia). Jangan pakai kiasan aneh seperti "tempat khusus di internet".
- Akhiri dengan SATU pertanyaan saja, yaitu soal waktu mereka.
- Setiap kalimat manfaat harus menyebut keuntungan untuk pelanggan atau pemiliknya, bukan sekadar kata "website profesional".
- Sebut nama usaha sekali secara alami. Kalau namanya tidak jelas, pakai kategorinya.
- Maksimal 1 emoji, atau tidak sama sekali. Jangan pakai tanda seru berlebihan.
- Harga yang boleh disebut hanya "mulai dari 1,5 juta" dan bonus "alamat .com gratis tahun pertama". Jangan menyebut angka lain, jangan menjanjikan hal yang tidak pasti (jumlah pelanggan, omzet). Jangan mengaku dari perusahaan tertentu, dan jangan mengaku sudah pernah menghubungi mereka.

Balas HANYA isi pesannya. Tanpa tanda kutip, tanpa penjelasan, tanpa judul.`;

// The owner's rules, enforced on the model's output instead of trusted to the prompt.
function passes(text) {
  const t = text.toLowerCase();
  if (!t.includes('.com')) return false;                                  // must offer their own .com
  if (!/1[,.]?5\s*(juta|jt)/.test(t)) return false;                       // must quote the starting price
  if (!/gratis/.test(t)) return false;                                    // must mention the free first year
  if (!/(tahun pertama|1 tahun|satu tahun)/.test(t)) return false;
  if (/contoh(nya)?\s*(dulu|demo|tampilan|desain)|saya\s+buatkan\s+(contoh|demo|draf)/.test(t)) return false;
  if (/ota|seo|landing page|platform\b/.test(t)) return false;            // no jargon
  return text.length <= 700;
}

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
    res.status(200).json({ ok: true, source: 'template', reason: 'no-key', message: fallback(name, category) });
    return;
  }

  const prompt = PROMPT.replace('{NAME}', name || '-').replace('{CATEGORY}', category || '-');
  let reason = 'unavailable';

  for (let pass = 0; pass < 2; pass++) {          // one retry if the message breaks a rule
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

        if (r.status === 429) { reason = 'rate-limited'; console.error('gemini 429', model); continue; }
        if (r.status === 404) { reason = 'retired'; continue; }

        const j = await r.json();
        const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
        let text = parts.map((p) => p.text || '').join('').trim();

        text = text.replace(/^```[a-z]*\s*/i, '').replace(/```$/,'').replace(/^["'“”]+|["'“”]+$/g, '').trim();

        if (!text) continue;
        if (!passes(text)) { reason = 'off-rules'; console.error('gemini off-rules', model); continue; }
        res.status(200).json({ ok: true, source: 'gemini', model, message: text });
        return;
      } catch (e) {
        reason = 'error';
        console.error('gemini failed', model, e && e.message);   // try the next model
      }
    }
  }
  res.status(200).json({ ok: true, source: 'template', reason, message: fallback(name, category) });
};
