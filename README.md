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

## Cari nomor (Google Maps)

Tombol kaca pembesar (kiri tombol **＋**) membuka pencarian: **Area** + **What** + radius
(1/3/5/10 km). `api/discover.js` menanyakan **Google Places API (New)**
(`places.googleapis.com/v1/places:searchText`) di sekitar area itu dan mengembalikan usaha yang
punya nomor.

- Hanya **nomor HP Indonesia** (08…) yang bisa disimpan. Nomor rumah/kantor (`021…`) tidak
  bisa dipakai WhatsApp — barisnya tampil redup dengan label `landline`.
- Usaha tanpa nomor juga tampil redup (`no number`) supaya kelihatan berapa yang terbuang.
- Tombol **＋** di baris hasil menyimpan nomor itu. Dari halaman kategori, nomor masuk ke
  kategori itu; dari Home, muncul pilihan kategori (atau kategori baru bernama kata kuncinya).
- Nomor yang sudah pernah disimpan ditandai ✓ dan tidak bisa masuk dua kali.
- Satu pencarian mengumpulkan **50 nomor** (bukan 50 tempat mentah): `api/discover.js` menyapu
  area itu sampai 50 nomor HP terkumpul atau area habis, lalu hanya menampilkan yang bisa
  di-WhatsApp. Baris atas menunjukkan hasilnya: `50 numbers · 200 places · 150 no number`.
- **More** melanjutkan area berikutnya (50 nomor lagi). Satu halaman Google berisi 20 tempat dan
  bisa dilanjutkan 3 halaman, jadi area ditutup dengan beberapa kotak tumpang-tindih (tengah
  dulu, lalu cincin di sekelilingnya) — maksimal 6 permintaan Google per pencarian.
- Kata kunci otomatis terisi dari nama kategori yang sedang dibuka.

Kunci Google hanya ada di server. Setel di Vercel:

```
GOOGLE_MAPS_API_KEY = <kunci dengan Places API (New) aktif>
```

Kunci itu dibatasi ke alamat website ini (HTTP referrer), jadi setiap permintaan dari server
dikirim dengan `Referer` aplikasi. Kalau alamat situs berubah, tambahkan alamat baru di
pembatasan kunci.

Hasil nyata (radius 10 km, September 2026): villa di Pacet/Cianjur **50 nomor dari 60 tempat**
(3 permintaan), restoran di Cianjur **50 nomor dari 84 tempat** (6 permintaan), laundry di
Cibinong **50 nomor dari 60 tempat** (3 permintaan). Sebelumnya dengan HERE hasilnya hanya
9–19 nomor per pencarian. Google memberi **10.000 permintaan gratis per SKU per bulan**,
jadi sekitar 1.500–3.000 pencarian gratis setiap bulan (tarif setelahnya ada di halaman
billing Google Cloud).

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
