# 🤖 WabotAI (NANBOT) — WhatsApp Group AI Bot

Bot WhatsApp Grup pintar berbasis **@whiskeysockets/baileys**, **Google Gemini AI (Interactions API)**, **Backup AI Gratis (Pollinations / Groq / OpenRouter)**, dan **Web Dashboard**.

## ✨ Fitur Utama
- **Tanya AI & Cari Riwayat Obrolan Grup**: Mention `@nomor_bot` atau `@bot` / `!ai` diikuti pertanyaan.
- **📌 Simpan Catatan, Jadwal & File Ringan Permanen (`.docx`, `.xlsx`, `.pdf`, Foto)**:
  - Simpan: `@bot tolong savekan jadwal/file ini ya`
  - Lihat Daftar: `@bot list catatan`
  - Kirim Ulang File: `@bot kirim file #1` atau `@bot kirim file excel tadi`
  - Hapus: `@bot hapus catatan #1` atau `@bot hapus catatan tersebut`
- **☁️ Integrasi Google Drive**: Upload otomatis file ke Google Drive & hapus file sementara di server lokal.
- **🌤️ Informasi Real-Time**: Cuaca terkini & prakiraan 3 hari (Open-Meteo), Kurs Mata Uang, Berita Terkini Google News Indonesia, dan Wikipedia Indonesia.
- **🖼️ Pembuat Stiker WhatsApp Otomatis**:
  - Kirim/reply foto dengan caption `stiker`
  - Kirim/reply foto dengan teks meme: `stiker lagi pusing bos`
  - Stiker kata-kata tanpa foto: `@bot stiker otw tapi boong`
- **🔄 Multi-Model Auto-Fallback & Backup AI 100% Gratis**: Otomatis beralih antar model Gemini atau ke Backup AI Gratis jika model utama sedang sibuk.

## 🚀 Cara Install & Jalankan di VPS / aaPanel

```bash
git clone https://github.com/GGGnandartea/wabot.git
cd wabot
npm install
npx pm2 start ecosystem.config.cjs
npx pm2 save
```

Lalu buka Web Dashboard di `http://IP_VPS_ANDA:3000` untuk Scan QR Code dan mengatur Gemini API Key.

