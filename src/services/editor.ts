// ============================================================
// Video editor – silence removal via ffmpeg silencedetect
//
// This replaces the original Python frame-by-frame approach
// with a much faster ffmpeg filter-based pipeline.
// ============================================================

import { existsSync } from "node:fs";
import { cp } from "node:fs/promises";
import { runCommand } from "../utils/command.js";
import { logger } from "../utils/logger.js";
import type {
  EditorOptions,
  SilenceSegment,
  SoundedSegment,
} from "../types.js";
import { DEFAULT_CONFIG } from "../config.js";

const DEFAULTS = DEFAULT_CONFIG.editor;

// ============================
// Public API
// ============================

/**
 * Remove silent parts from a video.
 *
 * 1. Detect silence with `ffmpeg  silencedetect`
 * 2. Compute sounded (non-silent) segments
 * 3. Concatenate sounded segments with a single ffmpeg command
 */
export async function editVideo(
  inputFile: string,
  outputFile: string,
  options: Partial<EditorOptions> = {},
): Promise<string> {
  const opts: EditorOptions = { ...DEFAULTS, ...options };

  logger.info("Starting video editing (silence removal)…");

  // 1  Detect silence
  const silenceSegments = await detectSilence(
    inputFile,
    opts.silentThreshold,
    opts.silentDuration,
  );
  logger.info(`Found ${silenceSegments.length} silent segment(s)`);

  if (silenceSegments.length === 0) {
    logger.info("No silence detected – copying original file");
    await cp(inputFile, outputFile);
    return outputFile;
  }

  // 2  Compute sounded segments
  const duration = await getVideoDuration(inputFile);
  const soundedSegments = getSoundedSegments(silenceSegments, duration);
  logger.info(`Keeping ${soundedSegments.length} sounded segment(s)`);

  if (soundedSegments.length === 0) {
    throw new Error(
      "No sounded segments found – the video appears to be entirely silent",
    );
  }

  // 3  Concatenate
  await concatenateSegments(inputFile, outputFile, soundedSegments, opts);
  logger.success(`Edited video saved: ${outputFile}`);
  return outputFile;
}

/**
 * Cut a portion of a video between two timestamps.
 */
export async function cutVideo(
  inputFile: string,
  outputFile: string,
  startTime: string,
  endTime: string,
  frameSize = DEFAULTS.frameSize,
  frameQuality = DEFAULTS.frameQuality,
): Promise<string> {
  logger.info(`Cutting video from ${startTime} to ${endTime}`);

  const result = await runCommand("ffmpeg", [
    "-y",
    "-i",
    inputFile,
    "-vf",
    `scale=${frameSize}`,
    "-qscale:v",
    String(frameQuality),
    "-b:v",
    "6000k",
    "-ss",
    startTime,
    "-to",
    endTime,
    outputFile,
  ]);

  if (result.exitCode !== 0) {
    throw new Error(`Failed to cut video: ${result.stderr}`);
  }
  logger.success(`Cut video saved: ${outputFile}`);
  return outputFile;
}

/**
 * Concatenate opening + main + ending videos.
 */
export async function concatenateWithIntro(
  mainVideo: string,
  outputFile: string,
  openingVideo?: string,
  endingVideo?: string,
): Promise<string> {
  const inputs: string[] = [];
  const filterParts: string[] = [];
  let idx = 0;

  if (openingVideo && existsSync(openingVideo)) {
    inputs.push("-i", openingVideo);
    filterParts.push(`[${idx}:v] [${idx}:a]`);
    idx++;
  }

  inputs.push("-i", mainVideo);
  filterParts.push(`[${idx}:v] [${idx}:a]`);
  idx++;

  if (endingVideo && existsSync(endingVideo)) {
    inputs.push("-i", endingVideo);
    filterParts.push(`[${idx}:v] [${idx}:a]`);
    idx++;
  }

  if (idx === 1) {
    await cp(mainVideo, outputFile);
    return outputFile;
  }

  const filterComplex = `${filterParts.join(" ")} concat=n=${idx}:v=1:a=1 [v] [a]`;

  const result = await runCommand("ffmpeg", [
    "-y",
    ...inputs,
    "-filter_complex",
    filterComplex,
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-metadata",
    "handler_name=YouTube Cliper Automation",
    "-qscale:v",
    "1",
    "-strict",
    "-2",
    "-b:v",
    "6000k",
    outputFile,
  ]);

  if (result.exitCode !== 0) {
    throw new Error(`Failed to concatenate: ${result.stderr}`);
  }
  logger.success(`Final video saved: ${outputFile}`);
  return outputFile;
}

// ============================
// Internal helpers
// ============================

async function detectSilence(
  inputFile: string,
  noiseDb: number,
  minDuration: number,
): Promise<SilenceSegment[]> {
  const result = await runCommand(
    "ffmpeg",
    [
      "-i",
      inputFile,
      "-af",
      `silencedetect=noise=${noiseDb}dB:d=${minDuration}`,
      "-f",
      "null",
      "-",
    ],
    { silent: true },
  );

  // ffmpeg writes diagnostic info to stderr
  const output = result.stderr;
  const segments: SilenceSegment[] = [];

  const startRe = /silence_start:\s*([\d.]+)/g;
  const endRe =
    /silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/g;

  const starts: number[] = [];
  let m: RegExpExecArray | null;

  while ((m = startRe.exec(output)) !== null) starts.push(parseFloat(m[1]));

  let i = 0;
  while ((m = endRe.exec(output)) !== null) {
    segments.push({
      start: starts[i] ?? 0,
      end: parseFloat(m[1]),
      duration: parseFloat(m[2]),
    });
    i++;
  }

  // Silence that extends to the very end of the file has no silence_end
  if (starts.length > segments.length) {
    const dur = await getVideoDuration(inputFile);
    segments.push({
      start: starts[starts.length - 1],
      end: dur,
      duration: dur - starts[starts.length - 1],
    });
  }

  return segments;
}

function getSoundedSegments(
  silenceSegments: SilenceSegment[],
  totalDuration: number,
): SoundedSegment[] {
  const sounded: SoundedSegment[] = [];
  let cursor = 0;

  for (const s of silenceSegments) {
    if (s.start > cursor + 0.01) {
      sounded.push({ start: cursor, end: s.start });
    }
    cursor = s.end;
  }

  if (cursor < totalDuration - 0.01) {
    sounded.push({ start: cursor, end: totalDuration });
  }

  return sounded;
}

async function getVideoDuration(file: string): Promise<number> {
  const r = await runCommand(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      file,
    ],
    { silent: true },
  );
  return parseFloat(r.stdout.trim()) || 0;
}

async function concatenateSegments(
  inputFile: string,
  outputFile: string,
  segments: SoundedSegment[],
  opts: EditorOptions,
): Promise<void> {
  // Limit filter complexity
  const effective =
    segments.length > 500 ? mergeSmallSegments(segments, 500) : segments;

  const filterParts: string[] = [];
  const concatIn: string[] = [];

  for (let i = 0; i < effective.length; i++) {
    const s = effective[i];
    filterParts.push(
      `[0:v]trim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},setpts=PTS-STARTPTS,scale=${opts.frameSize}[v${i}]`,
    );
    filterParts.push(
      `[0:a]atrim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`,
    );
    concatIn.push(`[v${i}][a${i}]`);
  }

  const filterComplex =
    filterParts.join(";") +
    `;${concatIn.join("")}concat=n=${effective.length}:v=1:a=1[outv][outa]`;

  logger.info(`Processing ${effective.length} sounded segments…`);

  const result = await runCommand("ffmpeg", [
    "-y",
    "-i",
    inputFile,
    "-filter_complex",
    filterComplex,
    "-map",
    "[outv]",
    "-map",
    "[outa]",
    "-qscale:v",
    String(opts.frameQuality),
    "-b:v",
    "6000k",
    "-strict",
    "-2",
    "-metadata",
    "handler_name=YouTube Cliper Automation",
    outputFile,
  ]);

  if (result.exitCode !== 0) {
    throw new Error(
      `ffmpeg edit failed:\n${result.stderr.slice(-600)}`,
    );
  }
}

/**
 * Merge the closest neighbouring segments until we are under maxCount.
 */
function mergeSmallSegments(
  segments: SoundedSegment[],
  maxCount: number,
): SoundedSegment[] {
  const merged = [...segments];

  while (merged.length > maxCount) {
    let smallestGap = Infinity;
    let mergeIdx = 0;
    for (let i = 0; i < merged.length - 1; i++) {
      const gap = merged[i + 1].start - merged[i].end;
      if (gap < smallestGap) {
        smallestGap = gap;
        mergeIdx = i;
      }
    }
    merged[mergeIdx] = {
      start: merged[mergeIdx].start,
      end: merged[mergeIdx + 1].end,
    };
    merged.splice(mergeIdx + 1, 1);
  }

  return merged;
}
