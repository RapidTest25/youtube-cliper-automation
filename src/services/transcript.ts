// ============================================================
// Transcript Service — Download subtitles from YouTube
// Falls back to Whisper transcription when no YouTube subs
// ============================================================

import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "../utils/command.js";
import { logger } from "../utils/logger.js";
import type { TranscriptSegment, VideoTranscript } from "../types.js";

const TEMP_SUB_DIR = "./TEMP_SUBS";

const WHISPER_BIN =
  process.env.WHISPER_BIN ||
  path.join(process.cwd(), ".venv", "bin", "whisper");

/**
 * Download and parse transcript/subtitles for a YouTube video.
 * Tries: 1) Manual subs  2) Auto-generated subs  3) Whisper on downloaded video
 */
export async function getTranscript(
  videoUrl: string,
  preferredLang: string = "en",
  videoFilePath?: string,
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

  // Fallback 2: Use Whisper to transcribe the downloaded video
  if (videoFilePath && existsSync(videoFilePath)) {
    logger.warn("No YouTube subtitles found — falling back to Whisper transcription…");
    const whisperTranscript = await whisperFallbackTranscript(videoFilePath);
    if (whisperTranscript) return whisperTranscript;
  }

  logger.warn("No subtitles found and Whisper fallback unavailable");
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
 * Remove VTT files in the temp subs directory (preserve Whisper JSON cache).
 */
function cleanTempSubs(): void {
  if (!existsSync(TEMP_SUB_DIR)) return;
  const files = readdirSync(TEMP_SUB_DIR);
  for (const f of files) {
    // Keep Whisper JSON cache for reuse
    if (f.endsWith(".json")) continue;
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

// ────────────────────────────────────────────────────────────
// Whisper Fallback Transcription
// ────────────────────────────────────────────────────────────

interface WhisperWord { word: string; start: number; end: number; }
interface WhisperSegment { id: number; start: number; end: number; text: string; words?: WhisperWord[]; }

/**
 * Use OpenAI Whisper to transcribe the full video audio,
 * then convert the result into a VideoTranscript.
 */
async function whisperFallbackTranscript(
  videoPath: string,
): Promise<VideoTranscript | null> {
  try {
    await mkdir(TEMP_SUB_DIR, { recursive: true });

    const baseName = path.basename(videoPath, path.extname(videoPath));
    const audioFile = path.join(TEMP_SUB_DIR, `${baseName}_whisper.wav`);
    const jsonFile = path.join(TEMP_SUB_DIR, `${baseName}_whisper.json`);

    // Check for cached Whisper JSON from a previous run
    if (existsSync(jsonFile)) {
      logger.info("Found cached Whisper transcription — reusing…");
      const data = JSON.parse(readFileSync(jsonFile, "utf-8"));
      const cached = parseWhisperJson(data);
      if (cached) return cached;
    }

    // Check for any whisper JSON in temp dir (same video, different filename)
    const existingJsons = readdirSync(TEMP_SUB_DIR).filter(f => f.endsWith("_whisper.json"));
    if (existingJsons.length > 0) {
      const cached = path.join(TEMP_SUB_DIR, existingJsons[0]);
      logger.info(`Found cached Whisper transcription (${existingJsons[0]}) — reusing…`);
      const data = JSON.parse(readFileSync(cached, "utf-8"));
      const result = parseWhisperJson(data);
      if (result) return result;
    }

    // 1. Extract audio (16kHz mono WAV for Whisper)
    logger.info("Extracting audio for Whisper transcription…");
    const extractResult = await runCommand("ffmpeg", [
      "-y", "-i", videoPath,
      "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
      audioFile,
    ], { silent: true });

    if (extractResult.exitCode !== 0) {
      logger.error("Failed to extract audio for Whisper");
      return null;
    }

    // 2. Run Whisper
    const whisperModel = process.env.WHISPER_MODEL ?? "base";
    const whisperLang = process.env.WHISPER_LANGUAGE ?? "id"; // default Indonesian
    logger.info(`Running Whisper (model=${whisperModel}, lang=${whisperLang}) for full video transcription…`);
    const whisperResult = await runCommand(WHISPER_BIN, [
      audioFile,
      "--model", whisperModel,
      "--output_format", "json",
      "--output_dir", TEMP_SUB_DIR,
      "--word_timestamps", "True",
      "--fp16", "False",
      "--language", whisperLang,
      "--condition_on_previous_text", "False",
      "--threads", "4",
    ], { silent: true });

    if (whisperResult.exitCode !== 0) {
      logger.error("Whisper transcription failed:", whisperResult.stderr.slice(0, 300));
      return null;
    }

    // 3. Find & read JSON output
    if (!existsSync(jsonFile)) {
      // Whisper may name file differently — scan for any JSON
      const jsons = readdirSync(TEMP_SUB_DIR).filter(f => f.endsWith(".json"));
      if (jsons.length === 0) {
        logger.error("Whisper produced no JSON output");
        return null;
      }
      // Use the most recently created JSON
      const altPath = path.join(TEMP_SUB_DIR, jsons[jsons.length - 1]);
      if (existsSync(altPath)) {
        const data = JSON.parse(readFileSync(altPath, "utf-8"));
        return parseWhisperJson(data);
      }
      return null;
    }

    const data = JSON.parse(readFileSync(jsonFile, "utf-8"));
    return parseWhisperJson(data);
  } catch (err) {
    logger.error("Whisper fallback failed:", err);
    return null;
  }
}

/**
 * Parse Whisper JSON output into VideoTranscript format.
 */
function parseWhisperJson(data: { segments?: WhisperSegment[]; text?: string; language?: string }): VideoTranscript | null {
  const raw = data.segments ?? [];
  if (raw.length === 0) {
    logger.warn("Whisper returned no segments");
    return null;
  }

  const segments: TranscriptSegment[] = raw.map(s => ({
    start: s.start,
    end: s.end,
    text: s.text.trim(),
  }));

  const duration = segments[segments.length - 1].end;
  const fullText = segments.map(s => s.text).join(" ");
  const language = data.language ?? "en";

  logger.success(
    `Whisper transcribed ${segments.length} segments (${language}, ${Math.round(duration)}s)`,
  );

  return { language, segments, fullText, duration };
}
