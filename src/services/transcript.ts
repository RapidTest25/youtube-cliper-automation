// ============================================================
// Transcript Service — Download subtitles from YouTube
// ============================================================

import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "../utils/command.js";
import { logger } from "../utils/logger.js";
import type { TranscriptSegment, VideoTranscript } from "../types.js";

const TEMP_SUB_DIR = "./TEMP_SUBS";

/**
 * Download and parse transcript/subtitles for a YouTube video.
 * Tries: 1) Auto-generated subs  2) Manual subs  3) yt-dlp auto-sub
 */
export async function getTranscript(
  videoUrl: string,
  preferredLang: string = "en",
): Promise<VideoTranscript | null> {
  await mkdir(TEMP_SUB_DIR, { recursive: true });

  // Clean previous temp subs
  cleanTempSubs();

  // Try downloading subtitles via yt-dlp
  const transcript = await downloadSubtitles(videoUrl, preferredLang);
  if (transcript) return transcript;

  // Fallback: try with auto-generated subs in any language
  const fallback = await downloadSubtitles(videoUrl, preferredLang, true);
  if (fallback) return fallback;

  logger.warn("No subtitles found for this video");
  return null;
}

/**
 * Download subtitles using yt-dlp and parse the VTT output.
 */
async function downloadSubtitles(
  url: string,
  lang: string,
  autoSub: boolean = false,
): Promise<VideoTranscript | null> {
  const args = [
    "--skip-download",
    "--write-sub",
    ...(autoSub ? ["--write-auto-sub"] : []),
    "--sub-lang", lang,
    "--sub-format", "vtt",
    "--convert-subs", "vtt",
    "-o", path.join(TEMP_SUB_DIR, "%(id)s.%(ext)s"),
    "--no-playlist",
    url,
  ];

  logger.debug(`Downloading ${autoSub ? "auto-" : ""}subtitles (${lang})…`);

  const result = await runCommand("yt-dlp", args, { silent: true });

  if (result.exitCode !== 0) {
    logger.debug(`yt-dlp subtitle download failed (exit ${result.exitCode})`);
    return null;
  }

  // Find downloaded VTT file
  const vttFile = findVttFile();
  if (!vttFile) {
    logger.debug("No VTT file found after download");
    return null;
  }

  logger.info(`Found subtitle file: ${path.basename(vttFile)}`);

  const content = readFileSync(vttFile, "utf-8");
  const segments = parseVTT(content);

  if (segments.length === 0) {
    logger.warn("Subtitle file was empty or unparseable");
    return null;
  }

  // Detect language from filename (e.g., "abc123.en.vtt")
  const detectedLang = path.basename(vttFile).split(".").slice(-2, -1)[0] || lang;

  const duration = segments[segments.length - 1].end;
  const fullText = segments.map((s) => s.text).join(" ");

  logger.success(
    `Parsed ${segments.length} subtitle segments (${detectedLang}, ${Math.round(duration)}s)`,
  );

  return {
    language: detectedLang,
    segments,
    fullText,
    duration,
  };
}

/**
 * Parse a WebVTT file into TranscriptSegment[].
 */
export function parseVTT(content: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  const lines = content.split("\n");

  // Regex for VTT timestamps: 00:00:00.000 --> 00:00:05.000
  const timeRegex =
    /(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})/;

  let i = 0;
  while (i < lines.length) {
    const match = lines[i].match(timeRegex);
    if (match) {
      const start = vttTimeToSeconds(match[1]);
      const end = vttTimeToSeconds(match[2]);
      i++;

      // Collect text lines until blank line
      const textLines: string[] = [];
      while (i < lines.length && lines[i].trim() !== "") {
        // Strip VTT formatting tags like <c>, </c>, <00:00:01.234>
        const clean = lines[i]
          .replace(/<[^>]+>/g, "")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .trim();
        if (clean) textLines.push(clean);
        i++;
      }

      const text = textLines.join(" ").trim();
      if (text && start < end) {
        // Deduplicate: if same text as previous, extend end time
        const prev = segments[segments.length - 1];
        if (prev && prev.text === text) {
          prev.end = end;
        } else {
          segments.push({ start, end, text });
        }
      }
    } else {
      i++;
    }
  }

  return segments;
}

/**
 * Convert VTT timestamp "HH:MM:SS.mmm" to seconds.
 */
function vttTimeToSeconds(timeStr: string): number {
  const parts = timeStr.split(":");
  const hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1], 10);
  const [secs, ms] = parts[2].split(".");
  return hours * 3600 + minutes * 60 + parseInt(secs, 10) + parseInt(ms, 10) / 1000;
}

/**
 * Find a .vtt file in the temp subs directory.
 */
function findVttFile(): string | null {
  if (!existsSync(TEMP_SUB_DIR)) return null;
  const files = readdirSync(TEMP_SUB_DIR).filter((f) => f.endsWith(".vtt"));
  if (files.length === 0) return null;
  return path.join(TEMP_SUB_DIR, files[0]);
}

/**
 * Remove all files in the temp subs directory.
 */
function cleanTempSubs(): void {
  if (!existsSync(TEMP_SUB_DIR)) return;
  const files = readdirSync(TEMP_SUB_DIR);
  for (const f of files) {
    try {
      unlinkSync(path.join(TEMP_SUB_DIR, f));
    } catch {
      // ignore
    }
  }
}

/**
 * Get video duration via ffprobe (fallback if transcript is incomplete).
 */
export async function getVideoDuration(filePath: string): Promise<number> {
  const result = await runCommand("ffprobe", [
    "-v", "quiet",
    "-show_entries", "format=duration",
    "-of", "csv=p=0",
    filePath,
  ], { silent: true });

  const dur = parseFloat(result.stdout.trim());
  return isNaN(dur) ? 0 : dur;
}

/**
 * Format seconds to "HH:MM:SS" string.
 */
export function secondsToTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
}

/**
 * Format seconds to "MM:SS" for shorter display.
 */
export function secondsToShortTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
