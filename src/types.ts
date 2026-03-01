// ============================================================
// Type definitions for YouTube Cliper Automation
// ============================================================

/** A single clip entry parsed from the CSV list */
export interface ClipEntry {
  url: string;
  cutStart?: string;
  cutEnd?: string;
  podcast: number;
  title: string;
  description: string;
  tags: string[];
}

/** Options for the video editor (silence removal) */
export interface EditorOptions {
  /** dB threshold for silence detection (e.g. -30) */
  silentThreshold: number;
  /** Minimum silence duration in seconds (e.g. 0.5) */
  silentDuration: number;
  /** Output video frame rate */
  frameRate: number;
  /** FFmpeg quality: 1 = best, 31 = worst */
  frameQuality: number;
  /** Output frame size, e.g. "1920:1080" */
  frameSize: string;
  /** Audio sample rate */
  sampleRate: number;
}

/** Options for thumbnail generation */
export interface ThumbnailConfig {
  maxThumbs: number;
  backgroundDir: string;
  outputDir: string;
  fontFamily: string;
  fontSize: number;
  logoPath?: string;
  thumbnailWidth: number;
  thumbnailHeight: number;
}

/** Options for YouTube upload */
export interface UploadConfig {
  clientSecretsPath: string;
  tokenPath: string;
  privacyStatus: "public" | "private" | "unlisted";
  categoryId: string;
  language: string;
  playlistTitles?: string[];
  madeForKids: boolean;
  /** Hours between scheduled publishes */
  publishInterval: number;
}

/** A detected silence segment */
export interface SilenceSegment {
  start: number;
  end: number;
  duration: number;
}

/** A segment that contains audible sound */
export interface SoundedSegment {
  start: number;
  end: number;
}

/** Result of downloading a video */
export interface DownloadResult {
  filePath: string;
  frameRate: number;
  resolution: string;
}

/** Result of processing a single clip */
export interface ProcessResult {
  success: boolean;
  outputFile?: string;
  thumbnailFile?: string;
  error?: string;
}
