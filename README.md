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

Vercel, tanpa build step (`index.html` statis + `api/message.js`).
