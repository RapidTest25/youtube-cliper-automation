// ============================================================
// Auto-Caption Service — Whisper Transcription + Burn-in Subtitles
// ============================================================

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "../utils/command.js";
import { logger } from "../utils/logger.js";

const WHISPER_BIN =
  process.env.WHISPER_BIN ||
  path.join(process.cwd(), ".venv", "bin", "whisper");

const TEMP_CAPTION_DIR = "./TEMP_CAPTIONS";

export interface CaptionConfig {
  /** Whisper model size: tiny, base, small, medium, large */
  model: string;
  /** Max words per caption line */
  maxWordsPerLine: number;
  /** Font size for captions */
  fontSize: number;
  /** Font name (must be available on system) */
  fontName: string;
  /** Primary color in ASS format &HBBGGRR (white = &H00FFFFFF) */
  primaryColor: string;
  /** Outline color in ASS format (black = &H00000000) */
  outlineColor: string;
  /** Outline thickness */
  outlineWidth: number;
  /** Shadow depth */
  shadowDepth: number;
  /** Vertical position (0=bottom, higher=more up). For 9:16 we want ~center */
  marginV: number;
  /** Bold: 0=no, 1=yes */
  bold: number;
  /** Highlight the current word with this color (ASS format) */
  highlightColor: string;
}

export const DEFAULT_CAPTION_CONFIG: CaptionConfig = {
  model: "base",
  maxWordsPerLine: 3,
  fontSize: 60,
  fontName: "Arial",
  primaryColor: "&H00FFFFFF",    // white
  outlineColor: "&H00000000",    // black
  outlineWidth: 6,
  shadowDepth: 3,
  marginV: 200,
  bold: 1,
  highlightColor: "&H0000FFFF", // yellow
};

/** Word-level timing from Whisper */
interface WhisperWord {
  word: string;
  start: number;
  end: number;
}

/** Segment-level result from Whisper */
interface WhisperSegment {
  id: number;
  start: number;
  end: number;
  text: string;
  words: WhisperWord[];
}

/**
 * Generate captions and burn them into the video.
 * Pipeline: Extract audio → Whisper transcribe → Generate ASS → Burn with ffmpeg
 */
export async function addCaptions(
  inputVideo: string,
  outputVideo: string,
  config: CaptionConfig = DEFAULT_CAPTION_CONFIG,
): Promise<string> {
  if (!existsSync(inputVideo)) {
    throw new Error(`Input video not found: ${inputVideo}`);
  }

  await mkdir(TEMP_CAPTION_DIR, { recursive: true });

  const baseName = path.basename(inputVideo, ".mp4");
  const audioFile = path.join(TEMP_CAPTION_DIR, `${baseName}.wav`);
  const jsonFile = path.join(TEMP_CAPTION_DIR, `${baseName}.json`);
  const assFile = path.join(TEMP_CAPTION_DIR, `${baseName}.ass`);

  try {
    // ── 1. Extract audio ──────────────────────────────────────
    logger.info("Extracting audio for captioning…");
    await extractAudio(inputVideo, audioFile);

    // ── 2. Whisper transcription (word-level) ─────────────────
    logger.info(`Running Whisper (model=${config.model}) for word-level transcription…`);
    const segments = await whisperTranscribe(audioFile, jsonFile, config.model);

    if (segments.length === 0) {
      logger.warn("Whisper returned no segments — skipping captions");
      return inputVideo;
    }

    const totalWords = segments.reduce((sum, s) => sum + (s.words?.length ?? 0), 0);
    logger.success(`Whisper: ${segments.length} segments, ${totalWords} words detected`);

    // ── 3. Generate ASS subtitle file ─────────────────────────
    logger.info("Generating animated subtitle file (ASS)…");
    generateASS(segments, assFile, config);

    // ── 4. Burn subtitles into video ──────────────────────────
    logger.info("Burning captions into video…");
    await burnSubtitles(inputVideo, assFile, outputVideo);

    logger.success(`Captioned video saved: ${outputVideo}`);
    return outputVideo;
  } finally {
    // Clean up temp files
    for (const f of [audioFile, jsonFile, assFile]) {
      try { if (existsSync(f)) unlinkSync(f); } catch { /* ignore */ }
    }
  }
}

// ────────────────────────────────────────────────────────────
// Step 1: Extract Audio
// ────────────────────────────────────────────────────────────

async function extractAudio(videoPath: string, audioPath: string): Promise<void> {
  const result = await runCommand("ffmpeg", [
    "-y",
    "-i", videoPath,
    "-vn",
    "-acodec", "pcm_s16le",
    "-ar", "16000",
    "-ac", "1",
    audioPath,
  ], { silent: true });

  if (result.exitCode !== 0) {
    throw new Error(`Failed to extract audio (exit ${result.exitCode})`);
  }
}

// ────────────────────────────────────────────────────────────
// Step 2: Whisper Transcription
// ────────────────────────────────────────────────────────────

async function whisperTranscribe(
  audioPath: string,
  jsonPath: string,
  model: string,
): Promise<WhisperSegment[]> {
  // Use Whisper CLI with word_timestamps and JSON output
  const result = await runCommand(WHISPER_BIN, [
    audioPath,
    "--model", model,
    "--output_format", "json",
    "--output_dir", TEMP_CAPTION_DIR,
    "--word_timestamps", "True",
    "--fp16", "False",
  ], { silent: true });

  if (result.exitCode !== 0) {
    logger.error("Whisper failed:", result.stderr.slice(0, 500));
    throw new Error(`Whisper transcription failed (exit ${result.exitCode})`);
  }

  // Whisper outputs: <filename_without_ext>.json
  const baseName = path.basename(audioPath, path.extname(audioPath));
  const whisperOutput = path.join(TEMP_CAPTION_DIR, `${baseName}.json`);

  if (!existsSync(whisperOutput)) {
    throw new Error(`Whisper output not found: ${whisperOutput}`);
  }

  const data = JSON.parse(readFileSync(whisperOutput, "utf-8"));
  return (data.segments ?? []) as WhisperSegment[];
}

// ────────────────────────────────────────────────────────────
// Step 3: Generate ASS (Advanced SubStation Alpha) Subtitles
// ────────────────────────────────────────────────────────────

function generateASS(
  segments: WhisperSegment[],
  outputPath: string,
  config: CaptionConfig,
): void {
  // Collect all words with timestamps
  const allWords: WhisperWord[] = [];
  for (const seg of segments) {
    if (seg.words && seg.words.length > 0) {
      for (const w of seg.words) {
        allWords.push({
          word: w.word.trim(),
          start: w.start,
          end: w.end,
        });
      }
    }
  }

  if (allWords.length === 0) {
    // Fallback: use segment-level timing
    for (const seg of segments) {
      const words = seg.text.trim().split(/\s+/);
      const duration = seg.end - seg.start;
      const wordDuration = duration / words.length;
      for (let i = 0; i < words.length; i++) {
        allWords.push({
          word: words[i],
          start: seg.start + i * wordDuration,
          end: seg.start + (i + 1) * wordDuration,
        });
      }
    }
  }

  // Group words into lines (maxWordsPerLine per group)
  const groups: WhisperWord[][] = [];
  for (let i = 0; i < allWords.length; i += config.maxWordsPerLine) {
    groups.push(allWords.slice(i, i + config.maxWordsPerLine));
  }

  // Build ASS content
  const header = buildASSHeader(config);
  const events: string[] = [];

  for (const group of groups) {
    if (group.length === 0) continue;

    const start = group[0].start;
    const end = group[group.length - 1].end;
    const startTS = secondsToASS(start);
    const endTS = secondsToASS(end);

    // Build karaoke-style text with word-level highlighting
    // Using {\kf} tag for smooth karaoke fill effect
    let text = "";
    for (const word of group) {
      // Duration in centiseconds for this word
      const kDuration = Math.round((word.end - word.start) * 100);
      text += `{\\kf${kDuration}}${word.word} `;
    }
    text = text.trim();

    events.push(
      `Dialogue: 0,${startTS},${endTS},Default,,0,0,0,,${text}`,
    );
  }

  const ass = `${header}\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${events.join("\n")}\n`;

  writeFileSync(outputPath, ass, "utf-8");
  logger.debug(`ASS subtitle written: ${events.length} events`);
}

function buildASSHeader(config: CaptionConfig): string {
  return `[Script Info]
Title: Auto-Caption by YouTube Cliper Automation
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${config.fontName},${config.fontSize},${config.primaryColor},${config.highlightColor},${config.outlineColor},&H80000000,${config.bold},0,0,0,100,100,0,0,1,${config.outlineWidth},${config.shadowDepth},2,40,40,${config.marginV},1
`;
}

// ────────────────────────────────────────────────────────────
// Step 4: Burn Subtitles
// ────────────────────────────────────────────────────────────

async function burnSubtitles(
  videoPath: string,
  assPath: string,
  outputPath: string,
): Promise<void> {
  // Use ass filter with fontsdir for embedded fonts
  const assPathEscaped = assPath.replace(/([:\\'])/g, "\\$1");

  const result = await runCommand("ffmpeg", [
    "-y",
    "-i", videoPath,
    "-vf", `ass='${assPathEscaped}'`,
    "-c:v", "libopenh264",
    "-profile", "high",
    "-rc_mode", "bitrate",
    "-b:v", "6000k",
    "-c:a", "copy",
    "-movflags", "+faststart",
    outputPath,
  ]);

  if (result.exitCode !== 0) {
    throw new Error(`Failed to burn subtitles (exit ${result.exitCode})`);
  }
}

// ────────────────────────────────────────────────────────────
// Utilities
// ────────────────────────────────────────────────────────────

function secondsToASS(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const sInt = Math.floor(s);
  const cs = Math.round((s - sInt) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(sInt).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}
