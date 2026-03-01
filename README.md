# YouTube Cliper Automation

AI-powered YouTube clips automation — **download**, **edit** (silence removal), **generate thumbnails**, and **upload** clips automatically.

> TypeScript rewrite of [eddieoz/youtube-clips-automator](https://github.com/eddieoz/youtube-clips-automator) with a faster, modern architecture.

---

## What's New vs Original Python Version

| Feature | Python (original) | TypeScript (this) |
|---|---|---|
| Silence removal | Frame-by-frame extraction (slow) | FFmpeg `silencedetect` filter (10-50× faster) |
| YouTube download | `pytube` (broken since 2024) | `yt-dlp` (actively maintained) |
| Thumbnail composition | OpenCV + Pillow | `sharp` + SVG text overlay (no native deps) |
| YouTube upload | External Go binary | `googleapis` npm package (native) |
| Type safety | None | Full TypeScript strict mode |
| Architecture | Single-file scripts | Modular service-based architecture |

## Architecture

```
src/
├── index.ts                 # Main pipeline orchestrator
├── types.ts                 # TypeScript interfaces
├── config.ts                # Default configuration
├── utils/
│   ├── logger.ts            # Coloured console logger
│   └── command.ts           # Shell command execution wrapper
└── services/
    ├── csv-parser.ts        # Parse clip list CSV
    ├── downloader.ts        # Download YouTube videos (yt-dlp)
    ├── editor.ts            # Silence removal via ffmpeg
    ├── thumbnail.ts         # Thumbnail generation (sharp)
    └── uploader.ts          # YouTube upload (googleapis)
```

## Requirements

- **Node.js** ≥ 18
- **ffmpeg** and **ffprobe** (required)
- **yt-dlp** (required for downloading)
- **YouTube API v3** credentials (required for uploading)
- ~50 GB free storage (depends on video sizes)

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/RapidTest25/youtube-cliper-automation.git
cd youtube-cliper-automation
```

### 2. Install Node.js dependencies

```bash
npm install
```

### 3. Install system dependencies

```bash
# Ubuntu / Debian
sudo apt-get install -y ffmpeg
pip install yt-dlp

# macOS
brew install ffmpeg yt-dlp

# Windows (with chocolatey)
choco install ffmpeg yt-dlp
```

### 4. Configure YouTube API v3 (for upload)

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project and enable **YouTube Data API v3**
3. Create OAuth 2.0 credentials (Desktop App)
4. Download and save as `client_secrets.json` in the project root

> On first run, the app will open a browser for authorisation and save the token automatically.

## Setup

1. Populate `./backgrounds/` with `.png` images for random thumbnail backgrounds
2. Place a `logo.png` in `./assets/` for branding on thumbnails
3. *(Optional)* Place `opening.mp4` and `ending.mp4` (1920×1080) in `./assets/` for intro/outro

## Usage

### 1. Prepare the clip list

Create `lists/list.csv` with these columns:

| url | time_from | time_to | podcast | title | description | tags |
|---|---|---|---|---|---|---|
| https://youtube.com/watch?v=... | 00:00:14 | 00:01:46 | 0 | My Title | Description | tag1 tag2 tag3 |
| https://youtube.com/watch?v=... | | | 0 | Full Video | Description | tag1 tag2 |

- **url** — YouTube video URL
- **time_from / time_to** — Clip timestamps (leave blank for full video)
- **podcast** — Reserved for future use (leave 0)
- **title** — Clip title (no commas)
- **description** — Clip description (no commas)
- **tags** — Space-separated tags

### 2. Run the pipeline

```bash
# Development (with tsx)
npm run dev

# Production
npm run build
npm start
```

### 3. Check output

Processed clips are organised in `./output/<title>/`:
- `*_EDITED.mp4` — Silence-removed video
- `*_FINAL.mp4` — With intro/ending (if configured)
- Thumbnails in `*.png`

## Docker

```bash
docker build -t youtube-cliper .
docker run -it youtube-cliper

# Mount updated clip list:
docker run -it -v "$(pwd)/lists:/app/lists" youtube-cliper
```

## How It Works

The pipeline processes each clip in 5 phases:

1. **Download** — `yt-dlp` downloads the video in best quality (≤ 1080p)
2. **Cut** — `ffmpeg` trims the video to specified timestamps
3. **Edit** — `ffmpeg silencedetect` identifies silent segments, then a single `ffmpeg` command removes them (much faster than frame-by-frame)
4. **Thumbnail** — Extracts frames via scene-change detection, composes with random background + text overlay using `sharp`
5. **Upload** — Uploads to YouTube via Data API v3 with scheduling support

## Configuration

Edit `src/config.ts` to customise defaults:

```typescript
export const DEFAULT_CONFIG = {
  editor: {
    silentThreshold: -30,     // dB threshold for silence
    silentDuration: 0.5,      // minimum silence duration (seconds)
    frameSize: "1920:1080",   // output resolution
  },
  thumbnail: {
    maxThumbs: 10,            // max thumbnails to generate
    fontSize: 70,             // title font size
    thumbnailWidth: 1280,
    thumbnailHeight: 720,
  },
  upload: {
    privacyStatus: "private",
    publishInterval: 3,       // hours between scheduled uploads
    categoryId: "28",         // Science & Technology
  },
};
```

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Run with tsx (development) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled version |
| `npm run clean` | Remove build artifacts and temp files |

## Credits

- Original project: [eddieoz/youtube-clips-automator](https://github.com/eddieoz/youtube-clips-automator)
- Silence detection: [jumpcutter](https://github.com/carykh/jumpcutter) by @carykh
- Named after [Marcelo Rezende](https://en.wikipedia.org/wiki/Marcelo_Rezende), Brazilian journalist famous for "Corta pra mim"

## License

MIT
