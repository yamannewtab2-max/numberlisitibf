# Leads

Mesin kumpul prospek. Google Maps → **＋** → kategori → simpan nomor → **WhatsApp** → pesan siap kirim.

**Live: https://numberlisitibf.vercel.app** — buka di HP, lalu *Add to Home Screen* supaya jalan full-screen.

## Alur

1. **Home** = daftar kategori. Tombol copy di kanan menyalin **nama kategori saja**.
   Tekan lama sebuah kategori → **Rename / Delete**.
2. **＋ kanan atas** = kategori baru.
3. **Halaman kategori** = daftar usaha yang sudah disimpan (nama + nomor + tombol WhatsApp).
   **＋ kanan atas** = tambah nomor. Tekan baris = edit / hapus.
4. **Tombol WhatsApp** → nama usaha + kategori dikirim ke Gemini 3.1 Flash-Lite →
   pesan bahasa Indonesia dibuat → WhatsApp terbuka dengan pesan itu.
   **Pesan tidak pernah dikirim otomatis** — kamu yang menekan kirim.

5. **Trash** ada di paling bawah home. Setiap nomor yang sudah kamu kirimi pesan WhatsApp
   otomatis pindah ke Trash dan keluar dari kategorinya, jadi daftar kategori hanya berisi
   yang belum dihubungi. Nomor di Trash tetap dihitung "sudah dipakai" (tidak bisa dimasukkan
   lagi), dan bisa dihapus permanen dari sana.

UI sengaja tanpa teks tambahan. Tidak ada login, catatan, peta, CRM, atau dashboard.

**Satu nomor hanya sekali.** Nomor yang sudah tersimpan tidak bisa dimasukkan lagi walau
kategorinya berbeda — saat disimpan muncul "Already in &lt;kategori&gt;" dan nomornya tidak
ditambahkan. Format apa pun dianggap sama (0812…, +62 812…, 62 812…).

## Data

- Tanpa konfigurasi: data disimpan di HP (localStorage).
- Dengan Firebase: isi `config.js` → data tersimpan di Firestore dan muncul di semua perangkat.

### Mengaktifkan Firebase

1. Firebase console → **Firestore Database** → Create database.
2. **Authentication → Sign-in method → Anonymous → Enable** (app login sendiri, tanpa layar login).
3. Project settings → Your apps → **Web** → copy `firebaseConfig` → tempel ke `config.js`.
4. Aturan Firestore:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /categories/{doc} { allow read, write: if request.auth != null; }
    match /businesses/{doc} { allow read, write: if request.auth != null; }
  }
}
```

Koleksinya cuma dua: `categories` (id, name, createdAt) dan
`businesses` (id, name, phone, categoryId, createdAt).

Catatan: Firestore REST menolak API key tanpa identitas, karena itu app melakukan
anonymous sign-in sekali per perangkat. Artinya tiap perangkat punya uid sendiri —
pakai satu HP sebagai sumber data utama, atau pakai aturan `if true` kalau mau satu
dataset bersama (siapa pun yang tahu project ID bisa membacanya).

## Cari nomor (Google Maps + AI)

Tombol kaca pembesar (kiri tombol **＋**) membuka pencarian: **Area** (titik awal) + **What**
(kata kunci, otomatis terisi dari kategori) + radius. Satu kali tekan Search menjalankan
`api/sweep.js`:

1. Membaca memori di Firestore (`scans/main`) — daftar tempat yang sudah pernah dipindai.
2. Menentukan titik pusat dari area yang kamu tulis.
3. **Gemini memilih lokasi berikutnya** — 2 kecamatan/desa di sekitar pusat yang belum pernah
   dicari (contoh: dari Pacet → Cipanas, Sukaresmi, Cugenang).
4. Setiap lokasi dicari lewat `api/discover.js` (Google Places Text Search), lalu disaring:
   hanya nomor HP Indonesia dan **hanya usaha yang belum punya website sendiri**.
5. Semua `place id` yang dilihat + lokasi yang sudah dicari disimpan kembali ke Firestore, jadi
   tanah yang sama tidak pernah dipindai dua kali — dari HP mana pun.
6. Tombol **More** menjalankan putaran berikutnya; karena memori sudah bertambah, AI memilih
   lokasi yang lebih jauh lagi.

- Nomor rumah/kantor (`021…`) tidak bisa dipakai WhatsApp — dihitung, tidak ditampilkan.
- Tautan Instagram/WhatsApp/Linktree tetap dianggap "belum punya website" (ditandai `ig`).
- Hanya **nomor HP Indonesia** (08…) yang bisa disimpan; nomor yang sudah pernah disimpan
  ditandai ✓ dan tidak bisa masuk dua kali.
- Baris atas menampilkan apa yang terjadi: `50 numbers · Cipanas, Sukaresmi · 12 with website ·
  8 scanned before`.
- Kalau kuota harian Google habis, baris itu menulis `Google daily limit reached` (kuota
  kembali pada tengah malam waktu Pasifik = 14:00 WIB).

Kunci dan memori hanya ada di server:

```
GOOGLE_MAPS_API_KEY = <kunci dengan Places API (New) aktif, dibatasi ke alamat situs ini>
FIREBASE_PROJECT_ID = numberlisting-22048      (opsional, app juga mengirimnya)
FIREBASE_API_KEY    = <kunci web Firebase>     (opsional)
```

Aturan Firestore harus mengizinkan koleksi `scans` (tempat memori pemindaian disimpan):

```
match /scans/{doc} { allow read, write: if true; }
```

## Pesan AI

`api/message.js` memanggil Gemini 3.1 Flash-Lite dengan prompt pendek dan mengembalikan
satu pesan siap kirim. Setel variabel lingkungan di Vercel:

```
GEMINI_API_KEY = <kunci dari aistudio.google.com>
```

Tanpa kunci itu (atau kalau Gemini gagal/timeout), fungsi mengembalikan template bahasa
Indonesia bawaan per kategori — alur WhatsApp tetap jalan. Kunci hanya ada di server,
browser tidak pernah melihatnya.

## Deploy

Vercel, tanpa build step (`index.html` statis + `api/message.js` + `api/discover.js`).
