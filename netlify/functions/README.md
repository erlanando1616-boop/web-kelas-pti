# Web Kelas Pendidikan Teknologi Informasi

Web kelas berbahasa Indonesia dengan tiga peran: **Admin**, **Spesial**, dan **Member**.
Data disimpan di **repository GitHub** (berkas `data/db.json`) lewat fungsi server Netlify, sehingga semua anggota melihat data yang sama.

## Fitur

| Fitur | Member | Spesial | Admin |
|---|:--:|:--:|:--:|
| Beranda & status pribadi | ✔ | ✔ | ✔ |
| Daftar isi informasi (baca) | ✔ | ✔ | ✔ |
| Tambah informasi | | ✔ | ✔ |
| Hapus informasi | | | ✔ |
| Daftar anggota & perannya (lihat) | ✔ | ✔ | ✔ |
| Absen harian (lihat milik sendiri, streak) | ✔ | | |
| Isi absen harian: tekan Hadir / Tidak hadir | | ✔ | ✔ |
| Keuangan / kas mingguan (lihat milik sendiri) | ✔ | | |
| Isi kas, atur nominal, catat transaksi | | ✔ | ✔ |
| Analitik (grafik & rekap) | | ✔ | ✔ |
| Riwayat aktivitas | | ✔ | ✔ |
| Tambah/ubah/hapus anggota & akun | | | ✔ |
| Cadangkan / pulihkan data | | | ✔ |

- **Absen dicatat per HARI** oleh Admin/Spesial: tiap nama punya dua tombol, **Hadir** (hijau) dan **Tidak hadir** (merah). Tekan lagi untuk membatalkan; ada tombol massal *Semua hadir* dan *Sisanya tidak hadir*. Nama yang belum diisi berwarna abu-abu.
- **Kas dicatat per minggu**: hijau = sudah bayar, merah = belum bayar.
- **Analitik**: persentase kehadiran, streak, peringkat paling rajin, tren 14 hari, peta kehadiran per anggota, kepatuhan kas.
- **Riwayat**: linimasa semua perubahan, bisa disaring (absen, kas, info, anggota).
- Tampilan bergaya Gen Z dengan mode gelap/terang dan navigasi bawah di HP.
- `preview.html` = gambaran tampilan dengan data contoh (tidak memakai GitHub), bisa dibuka langsung di browser.

## Cara kerja penyimpanan

```
Browser  →  Fungsi Netlify (api.js)  →  Repo GitHub privat (data/db.json)
```

- Token GitHub **hanya** ada di server Netlify (variabel lingkungan), tidak pernah dikirim ke browser.
- Login diperiksa di server. Kata sandi disimpan sebagai hash (scrypt), dan hash tidak pernah dikirim ke browser.
- Server menegakkan peran: Member tidak bisa mengubah data, Spesial tidak bisa mengubah akun.
- Setiap perubahan menjadi satu *commit* di repo data, jadi riwayat Git sekaligus menjadi cadangan.
- Jika dua pengurus menyimpan bersamaan, yang terlambat akan diminta mengulang perubahannya (data dimuat ulang otomatis).

## Langkah pemasangan

### 1. Repo kode (memicu Netlify)
1. Buat repository GitHub, misalnya `web-kelas-pti`.
2. Unggah semua isi folder ini, **termasuk folder `netlify/functions/`**.

### 2. Repo data (database)
1. Buat repository **kedua** yang **Private**, misalnya `kelas-pti-data`, dan centang *Add a README file*.
   Gunakan repo terpisah supaya setiap penyimpanan data tidak memicu build ulang Netlify.
2. Buat token: GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate.
   - *Repository access*: **Only select repositories** → pilih `kelas-pti-data`
   - *Permissions* → *Repository permissions* → **Contents: Read and write**
   - Salin token (hanya tampil sekali).

### 3. Netlify
1. Netlify → **Add new site** → **Import an existing project** → GitHub → pilih repo kode.
2. Sebelum Deploy (atau di *Site configuration → Environment variables*) tambahkan:

| Nama | Isi |
|---|---|
| `GITHUB_TOKEN` | token dari langkah 2 |
| `GITHUB_REPO` | `usernameanda/kelas-pti-data` |
| `SESSION_SECRET` | teks acak panjang (minimal 32 karakter) |
| `GITHUB_BRANCH` | (opsional) default `main` |

3. Deploy. Saat pertama dibuka, server otomatis membuat `data/db.json` dengan akun awal.

### 4. Pertama kali dipakai
- Masuk dengan `admin` / `admin123`, lalu **segera ganti kata sandi**.
- Tambahkan anggota di menu *Anggota*.

## Batasan yang perlu diketahui

- Cocok untuk kelas kecil (puluhan anggota). Berkas data dibatasi 1 MB oleh API GitHub; untuk data lebih besar gunakan database sungguhan (Supabase/Firebase).
- Data kehadiran dan kas milik semua anggota ikut dikirim ke browser Member (hanya disembunyikan di tampilan). Jangan simpan data sensitif.
- Memulihkan cadangan JSON: akun yang tidak ada di server perlu diberi kata sandi baru oleh admin.
- Tidak ada pembatasan percobaan login; gunakan kata sandi yang kuat.
