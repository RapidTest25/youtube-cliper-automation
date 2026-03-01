# Brainstorming: YT Viral Clipper Pro (Project Name Idea)

## Visi & Tujuan
Menciptakan "Senjata Utama" bagi para kreator pembuat video klip (Clippers). Aplikasi ini tidak hanya automation pemotong video yang pasif, melainkan sistem pintar yang proaktif mencari momen "viral" (berpotensi viral) dan menyediakannya dengan antarmuka yang mudah digunakan (GUI).

## Fitur Utama Baru (Berdasarkan Request)

1. **User Interface (GUI)**
   - *Website/Web App*: Pendekatan terbaik karena cross-platform dan fleksibel.
   - *Dashboard Utama*: Melihat antrian video, status proses, dan histori clip.
   - *Editor/Reviewer*: Menampilkan clip hasil AI sebelum di-export/upload. User bisa menyesuaikan durasi dengan slider GUI.

2. **Auto-Clipping untuk "Viral Moments" (AI Highlight Extraction)**
   - *Sebelumnya*: Memotong berdasarkan timestamp statis dari CSV.
   - *Baru*: Sistem otomatis mendeteksi bagian-bagian paling menarik/potensi viral.
   - *Cara Kerja*: 
     - Menganalisis *subtitle/transcript* untuk mencari keyword, emosi (sentiment), atau topik yang relevan.
     - Analisis audio (volume spike, tawa, atau keseruan).
     - Menghasilkan 5-10 "short clips" (durasi pendek seperti Shorts/TikTok) dari 1 video panjang (misal, durasi 1 jam -> 5 clip @ 60 detik).

3. **Multi-Platform Ready (Shorts, TikTok, Reels)**
   - Auto-crop video horizontal (16:9) menjadi vertikal (9:16) untuk format short-form content.
   - Auto-caption (teks animasi di tengah layar) yang saat ini sangat digemari penonton.

## Keputusan Arsitektur dan Arah Baru (Versi Desktop)

Dari hasil diskusi terbaru, kita akan mengubah aplikasi ini menjadi **Aplikasi Desktop** khusus kreator dengan spesifikasi berikut:

1. **Bentuk**: **Aplikasi Desktop** berbasis Electron (kombinasi Node.js backend dan React frontend). Ini memungkinkan akses langsung ke file sistem pengguna tanpa perlu server tambahan, dan aplikasi bisa berjalan full lokal terintegrasi dengan ffmpeg.
2. **AI Engine**: Menggunakan **API LLM (OpenAI/Groq/dll)** untuk menganalisa *transcript/subtitle*, yang merupakan cara paling efisien dan cerdas untuk mencari "viral hooks" dengan konteks yang tepat.
3. **Format Video**: **Vertikal (9:16)**, cocok dipersiapkan untuk TikTok, YouTube Shorts, & Instagram Reels. Pemrosesan ffmpeg akan meliputi *auto-crop face detection* atau *center crop*.

### Stack Baru yang Direkomendasikan
- **Framework**: Electron + React/Vite (menggunakan boilerplates seperti `electron-vite`).
- **Styling**: Tailwind CSS dan Shadcn/UI (supaya cepat terlihat modern dan profesional).
- **Core Video**: `ffmpeg`, `yt-dlp` akan di-bundle atau dikoordinasikan lewat script Node.js dari main process Electron.
- **Transkrip & AI**: 
  - `youtube-transcript` untuk mendownload SRT/VTT dari Youtube (jika ada CC).
  - API OpenAI / Anthropic untuk menyeleksi klip menarik dan memberi *AI score/reasoning*.

---

### 1. Frontend (Client-side)
- **Framework**: React / Next.js / Vue.js atau Vite.
- **Styling**: Tailwind CSS (untuk UI modern dan cepat dibuat).
- **Fitur**: 
  - Form input URL (Single/Bulk).
  - Video player sederhana untuk preview dan edit frame.
  - Dashboard analytics dan library klip.

### 2. Backend (Server-side & Worker)
- **Framework**: Node.js dengan Express / Nest.js API routes / tRPC.
- **Database**: SQLite / PostgreSQL / MongoDB (menyimpan project, link video, metadata klip).
- **Job Queue**: BullMQ / Kafka (Untuk mengantrikan proses berat seperti download & render video, agar server web tidak freeze).

### 3. Engine Inti (AI + Video Processing)
- **Download**: `yt-dlp` (Sudah ada & stabil).
- **Video Editing**: `ffmpeg` (Sudah ada, tapi akan dibuat lebih advanced).
- **AI Processing (Viral Detection)**:
  - Download Auto-generated subtitle vtt/srt dari YouTube.
  - Menggunakan LLM (misal: OpenAI API GPT-4, Groq, atau model lokal Llama 3/Mistral via Ollama) untuk menganalisis transkrip dan mencari "Tolong carikan 5 momen paling menarik berdurasi 30-60 detik dari video ini yang potensial viral".
  - Model akan mereturn output JSON berisi: *Start Time, End Time, Title Clip, Viral Score/Reason*.
- **Auto-Caption (Opsional tapi game-changer)**: OpenAI Whisper API / local whisper.cpp untuk *word-level transcription* frame-by-frame.

## Roadmap Pengembangan Berfokus pada GUI

### Fase 1: MVP (Minimum Viable Product) dengan GUI Sederhana
- Integrasi kode TypeScript saat ini menggunakan HTTP REST API (misal dengan Express).
- Buat Web Client Dashboard pakai React.
- Input: URL -> Output: Langsung download / play video di web.
- Proses masih berdasarkan Cut Manual via input form (bukan CSV).

### Fase 2: "The AI Highlighter" (Pendeteksi Viral)
- Integrasi module download Subtitle.
- Integrasi prompt ke LLM (OpenAI/Anthropic/Local LLM).
- Sistem nge-klik/buat klip otomatis berdasarkan output LLM.

### Fase 3: Auto-Crop & Auto-Caption
- Konversi UI ke "Shorts" format.
- Burn-in subtitle/caption ke dalam video.

### Fase 4: Export & Upload Manager
- Manajemen antrian unggahan (dijadwalkan) via GUI.
- Connect API Tiktok/Instagram.

---

## Pertanyaan Menarik untuk Kamu Sebelum Memulai:

1. **Untuk GUI-nya**, apakah lebih suka pendekatan **Web Based (Dashboard di Browser)** atau **Desktop App (Aplikasi installan Windows/Mac pakai Electron/Tauri)**?
2. **Untuk AI "Viral"-nya**, apakah kamu setuju kita pakai pendekatan **Analisis Teks (Transkrip + LLM)**? Ini pendekatan paling masuk akal saat ini untuk membuat klip viral seperti OpusClip/Vizard.ai.
3. Apakah kamu ingin membuat klip vertikal (Shorts/Tiktok 9:16) atau tetap klip horizontal (Seperti format podcast biasa)?
